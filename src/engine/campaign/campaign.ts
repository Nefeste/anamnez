// Кампания (spec 2026-09-campaign): глава, её задания и письма. Чистые функции над состоянием
// смены: ход задания выводится из итогов дней главы и больницы, выполненное запоминается днём,
// письма приходят по своим поводам — в начале главы, после дня N, при задании, в конце главы.
// Всё — вечером, при закрытии дня; те же зерно и команды — те же задания и письма (ADR 0004).
import type { Chapter, ContentDb, DayKind, Id, Mission } from '../../content/types';
import { expensesOf, incomeOf } from '../economy/economy';
import { type HospitalState, planOf } from '../hospital/build';
import { workingRooms } from '../hospital/requirements';
import { type StaffMember, staffingOf } from '../hospital/staff';
import type { DaySummary } from '../shift/types';

/** Где карьера: глава, с какого дня она идёт, что выполнено и какие письма пришли. */
export interface CampaignProgress {
  chapter: Id;
  /** последний день прежней главы: дни главы — после него */
  since: number;
  /** выполненные задания главы: номер задания → день */
  done: Record<string, number>;
  /** пришедшие письма: номер письма в главе, день, прочитано ли */
  letters: { id: string; day: number; read?: boolean }[];
  /** когда выполнены все основные задания */
  complete?: number;
  /**
   * Подсказки наставника: какие уже показаны в этой карьере, выключены ли («Без подсказок»).
   * Отметка вида, как «прочитано» у письма, — движок её не читает (src/state/tips.ts).
   */
  tips?: { shown: Id[]; off?: boolean };
}

/**
 * Ход задания: сколько есть, сколько нужно; у «принять N» — ещё точность, %; у сроков стационара
 * (часть 34) — суток в среднем и обычных в среднем у выписанных подряд.
 */
export interface MissionProgress {
  value: number;
  target: number;
  accuracy?: number;
  stay?: { days: number; norm: number };
  done: boolean;
}

/** Всё, что нужно заданиям: итоги дней главы, больница и штат. */
export interface CampaignView {
  campaign: CampaignProgress;
  history: readonly DaySummary[];
  hospital?: HospitalState;
  staff?: readonly StaffMember[];
}

export const chapterOf = (db: ContentDb, c: CampaignProgress): Chapter | undefined => db.chapters[c.chapter];

/** Следующая глава по порядку (spec 2026-09-chapter-2, часть 34); последняя — undefined. */
export function nextChapterOf(db: ContentDb, c: CampaignProgress): Chapter | undefined {
  const ch = chapterOf(db, c);
  return ch ? Object.values(db.chapters).find(x => x.order === ch.order + 1) : undefined;
}

/** Дни этой главы — закрытые после её начала. */
const chapterDays = (v: CampaignView) => v.history.filter(h => h.day > v.campaign.since);

/** Выполнено ли условие дня. */
export function dayOk(kind: DayKind, h: DaySummary): boolean {
  switch (kind) {
    case 'noNeedlessAntibiotic':
      return h.seen > 0 && !h.needlessAntibiotic;
    case 'noLeft':
      return h.arrived > 0 && h.left === 0;
    case 'cashPositive':
      return !!h.economy && incomeOf(h.economy.ledger) - expensesOf(h.economy.ledger) >= 0;
    case 'noWaitComplication':
      return (h.surgery?.done ?? 0) > 0 && !h.surgery?.waited;
    // глава 3 (spec 2026-10-chapter-3, часть 45а): были ваши больные с ОКС, и ни у одного он не пропущен
    case 'noMissedMI':
      return (h.acs?.seen ?? 0) > 0 && !h.acs?.missed;
  }
}

/**
 * Срок у больных подряд (часть 45а): оценки срока по порядку закрытия во всех днях главы; выполнен — «A».
 * Лучшая серия решает задание, нынешняя (с конца) — ход.
 */
function deadlineRuns(days: readonly DaySummary[], target: Id): { best: number; now: number } {
  let best = 0;
  let now = 0;
  for (const h of days) {
    for (const g of h.targetSeq?.[target] ?? '') {
      now = g === 'A' ? now + 1 : 0;
      best = Math.max(best, now);
    }
  }
  return { best, now };
}

/** Ход задания сейчас; выполненное раньше — выполнено, что бы ни было потом. */
export function missionProgress(db: ContentDb, v: CampaignView, m: Mission): MissionProgress {
  const was = v.campaign.done[m.id] !== undefined;
  const days = chapterDays(v);
  switch (m.kind) {
    case 'seen': {
      const seen = days.reduce((a, h) => a + h.seen, 0);
      const correct = days.reduce((a, h) => a + h.correct, 0);
      const accuracy = seen > 0 ? Math.round((100 * correct) / seen) : 0;
      return { value: Math.min(seen, m.count), target: m.count, accuracy, done: was || (seen >= m.count && accuracy >= m.accuracy) };
    }
    case 'roomWorks': {
      let works = false;
      if (v.hospital) {
        const plan = planOf(db, v.hospital);
        const working = workingRooms(db, plan, staffingOf(db, plan, v.staff ?? []));
        works = plan.rooms.some(r => r.type === m.room && working.has(r.id));
      }
      return { value: works || was ? 1 : 0, target: 1, done: was || works };
    }
    case 'streak': {
      let run = 0;
      for (let i = days.length - 1; i >= 0 && dayOk(m.day, days[i]); i--) run++;
      return { value: Math.min(run, m.days), target: m.days, done: was || run >= m.days };
    }
    case 'days': {
      const n = days.filter(h => dayOk(m.day, h)).length;
      return { value: Math.min(n, m.days), target: m.days, done: was || n >= m.days };
    }
    // глава 2 (spec 2026-09-chapter-2, часть 34): лучшая смена, где всех привезённых
    // отсортировали без ошибки; операции без осложнения и без смерти после них
    case 'triage': {
      const best = Math.max(0, ...days.map(h => (h.ambulance && h.ambulance.under + h.ambulance.over === 0 ? h.ambulance.sorted : 0)));
      return { value: Math.min(best, m.count), target: m.count, done: was || best >= m.count };
    }
    case 'operations': {
      const n = days.reduce((a, h) => a + (h.surgery?.good ?? 0), 0);
      return { value: Math.min(n, m.count), target: m.count, done: was || n >= m.count };
    }
    // глава 3 (spec 2026-10-chapter-3, часть 45а): срок выполнен у N ваших больных подряд — серия рвётся
    // на первом опоздании; тромболизисы в окне и без противопоказаний за главу
    case 'deadline': {
      const r = deadlineRuns(days, m.target);
      const done = was || r.best >= m.count;
      return { value: done ? m.count : Math.min(r.now, m.count), target: m.count, done };
    }
    case 'thrombolysis': {
      const n = days.reduce((a, h) => a + (h.lysis?.good ?? 0), 0);
      return { value: Math.min(n, m.count), target: m.count, done: was || n >= m.count };
    }
    // выписанные подряд — от последнего дня назад; день с выпиской раньше срока рвёт серию: так
    // средний срок не сократить, выписывая недолеченных
    case 'stay': {
      let n = 0;
      let sum = 0;
      let norm = 0;
      for (let i = days.length - 1; i >= 0 && n < m.count; i--) {
        const w = days[i].ward;
        if (!w || w.discharged === 0) continue;
        if (w.early > 0) break;
        n += w.discharged;
        sum += w.stayDays;
        norm += w.stayNorm;
      }
      return {
        value: Math.min(n, m.count), target: m.count, done: was || (n >= m.count && sum <= norm),
        ...(n > 0 ? { stay: { days: sum / n, norm: norm / n } } : {}),
      };
    }
  }
}

/** Письма главы, пришедшие по поводу — в тот же день и в порядке записи. */
function lettersFor(ch: Chapter, fits: (w: Chapter['letters'][number]['when']) => boolean): string[] {
  return ch.letters.filter(l => fits(l.when)).map(l => l.id);
}

/** Начало главы: письма «в начале» — в день начала. */
export function startChapter(db: ContentDb, chapter: Id, since: number): CampaignProgress {
  const ch = db.chapters[chapter];
  return { chapter, since, done: {}, letters: lettersFor(ch, w => w === 'start').map(id => ({ id, day: since })) };
}

/**
 * Вечер: какие задания выполнены сегодня, какие письма пришли — после дня N главы, при
 * задании, в конце главы (когда выполнены все основные). Меняет `campaign`, отдаёт
 * сделанное за день — для итогов.
 */
export function campaignEvening(db: ContentDb, v: CampaignView, day: number): { done: string[]; letters: string[] } {
  const c = v.campaign;
  const ch = chapterOf(db, c);
  if (!ch) return { done: [], letters: [] };
  const done = ch.missions.filter(m => c.done[m.id] === undefined && missionProgress(db, v, m).done).map(m => m.id);
  for (const id of done) c.done[id] = day;
  const n = day - c.since;
  const letters = lettersFor(ch, w => typeof w === 'object' && (('afterDay' in w && w.afterDay === n) || ('mission' in w && done.includes(w.mission))));
  if (c.complete === undefined && ch.missions.every(m => !m.main || c.done[m.id] !== undefined)) {
    c.complete = day;
    letters.push(...lettersFor(ch, w => w === 'end'));
  }
  const had = new Set(c.letters.map(l => l.id));
  const fresh = letters.filter(id => !had.has(id));
  c.letters.push(...fresh.map(id => ({ id, day })));
  return { done, letters: fresh };
}
