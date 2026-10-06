// npm run district-sim — районная больница главы 2 (spec 2026-09-chapter-2, критерии приёмки 3 и 4) и главы 3
// (spec 2026-10-chapter-3, критерии 4 и 5): каждая глава с начала, 30 дней. Два врача на одних и тех же зёрнах:
//   разумный — сортирует привезённых по шкале с листа передачи; шаг за шагом по пришедшему — тот же врач, что у
//     «Виртуального врача» и нанятого (`nextStep`): обследования из тех, что больница может сделать, сроки первым
//     делом, анализы и снимки — отпускает ждать; где лечить — по плану лечения и тому, что есть в больнице
//     (свободная койка палаты и ПИТ, операционная, монитор у постели); на обходе выписывает, когда можно, хуже — в
//     операционную, если у болезни есть операция, иначе переводит;
//   ленивый — всех привезённых сортирует «зелёными», без обследований, по жалобам; на первом же
//     обходе выписывает всех, кого можно.
// Стационар и операционная окупаются, если случаи стационара (с операцией — и за неё) приносят не
// меньше, чем стоят их койко-дни и расходники операций, палаты и операционная (содержание,
// аппараты) и люди в них. Койко-дни и расходники — у закрытых случаев: кто ещё лежит на 30-й день,
// тот ещё не оплачен, и его траты — вместе с его оплатой, после (для сведения — и всё подряд).
// В главе 3 — та же больница с крылом: кабинет КТ и ПИТ окупаются больными кардиологии и неврологии (часть 46б) —
// оплатой их КТ и случаев ПИТ, а больные неврологии без КТ не приезжают, и их приём и палата — тоже в счёт КТ.
// С 0.3.2 (spec 2026-10-chapter-3, часть 37) — и сроки: ЭКГ при боли в груди в первые 10 минут от прихода, в главе
// 3 — и КТ при инсульте в 40 минут и тест глотания.
// И карьера с начала (критерии этапов 4 и 5: все главы проходятся от начала до конца): разумный в главе 1 открывает
// лабораторию, как велит задание, в главе 3 строит крыло — кабинет КТ и ПИТ, как в готовой больнице главы, —
// принимает, пока основные задания главы не выполнены, и переходит в следующую.
// Флаги: --days 30, --runs 4 (зёрна), --season winter, --chapter hospital или vascular (одна глава), --no-career,
// --json.
import type { Id, Setting } from '../../src/content/types';
import { nextChapterOf } from '../../src/engine/campaign/campaign';
import { Rng } from '../../src/engine/core/rng';
import { consumablesOf, expensesOf, incomeOf, type Payer, type WardClose, wardIncome } from '../../src/engine/economy/economy';
import { sizeOf } from '../../src/engine/hospital/build';
import { examWhere } from '../../src/engine/hospital/requirements';
import { contextOf, posterior } from '../../src/engine/med/infer';
import { alsoSettings, recommendedSetting, settingFit, type Venue } from '../../src/engine/med/plan';
import { choosePlan, decisionLimit, type DoctorPhase, MIN_GAIN, nextStep, runDoctor, type Strategy } from '../../src/engine/med/policy';
import {
  apply, bedsideEquipment, candidatesOf, current, freeBeds, freeIcuBeds, hospitalCtx, inIcu, inpatientsOf, moreUrgent, newCampaign, observationsOf,
  operationOf, readyIn, targetPlace,
} from '../../src/engine/shift/engine';
import { minutesTo, targetsFor, targetStart } from '../../src/engine/shift/targets';
import { type Command, DAY, SHIFT_END, type ShiftPatient, type ShiftState } from '../../src/engine/shift/types';
import { daysIn, wardState } from '../../src/engine/shift/ward';
import { buildDb } from '../content/load';
import { profileOf } from './profiles';

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const DAYS = Number(arg('days', '30'));
/** карьера: дней на все три главы — не больше */
const CAREER_DAYS = 90;
const RUNS = Number(arg('runs', '4'));
const season = arg('season', 'winter') as 'winter' | 'spring' | 'summer' | 'autumn';
const asJson = process.argv.includes('--json');
/**
 * Главы, которые живут месяц с начала: глава 2 «Приёмное» и глава 3 «Сердце и мозг» — та же больница с крылом
 * (кабинет КТ и ПИТ); `--chapter hospital` или `--chapter vascular` — одна из них
 */
const MONTHS = process.argv.includes('--chapter') ? [`chapter.${arg('chapter', '')}`] : ['chapter.hospital', 'chapter.vascular'];
const VASCULAR = 'chapter.vascular';
/** карьера разумного с начала; `--no-career` — без неё */
const CAREER = !process.argv.includes('--no-career');

const { db, errors } = buildDb();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
if (MONTHS.some(c => c !== 'chapter.hospital' && c !== VASCULAR)) {
  console.error(`--chapter: hospital или vascular, а не ${MONTHS[0].replace('chapter.', '')}`);
  process.exit(1);
}
/** помещения стационара, операционной и крыла главы 3 (кабинет КТ, ПИТ) — их содержание, аппараты и люди */
type Unit = 'ward' | 'or' | 'ct' | 'icu';
const UNITS: Record<string, Unit> = { 'room.ward': 'ward', 'room.or': 'or', 'room.ct': 'ct', 'room.icu': 'icu' };
const isCt = (exam: Id) => db.exams[exam]?.room === 'room.ct';

type Player = Extract<Strategy, 'rational' | 'lazy'>;
const PLAYERS: Player[] = ['rational', 'lazy'];

interface Run {
  profit: number; minCash: number; cash: number; reputation: number;
  arrived: number; seen: number; left: number; unseen: number; correct: number; wrong: number;
  /** по отделению болезни, которой болен на самом деле: принято и верно */
  departments: Record<Id, { seen: number; correct: number }>;
  ambulance: { arrived: number; sorted: number; under: number; over: number };
  ward: { admitted: number; discharged: number; early: number; transferred: number; died: number; stayDays: number; stayNorm: number; returnsWorse: number };
  ops: { done: number; onTime: number; late: number; complicated: number; waited: number; complications: number; good: number };
  /**
   * стационар и операционная за все дни, ₽: оплата случаев (из неё прибавка за операции), койко-дни
   * и расходники операций — всех и закрытых случаев, содержание и люди палат и операционной. Случаи ПИТ — в `wing`
   */
  money: {
    income: number; opIncome: number; bedDays: number; opConsumables: number; closedBedDays: number; closedOpCost: number;
    /** случаи с операцией: оплата целиком (тариф и прибавка) и их койко-дни */
    opCases: number; opCasesBedDays: number;
    /** содержание помещений с их аппаратами и люди в них — по подразделениям */
    units: Record<Unit, { upkeep: number; staff: number }>;
    /** оплата закрытых случаев стационара и ПИТ: по кассе и подсчётом по случаям — сверка */
    ledgerWard: number; stays: number;
  };
  /**
   * крыло главы 3 (spec 2026-10-chapter-3, часть 46б), ₽: у больных кардиологии и неврологии (`cn`) — обследования КТ
   * (оплата и расходники) и закрытые случаи ПИТ (оплата и койко-дни); больных неврологии без кабинета КТ не везут —
   * их приём и палата тоже в счёт КТ. Другие больные в КТ и ПИТ (`other`) — для сведения
   */
  wing: { cn: WingUse; other: WingUse; neuroIncome: number; neuroCosts: number; neuroSeen: number };
  /** в какой день главы выполнено основное задание; нет — не выполнено */
  missions: Record<string, number | undefined>;
  /** стало хуже: вернулись хуже или с реакцией на лечение, умерли в стационаре */
  harmed: number;
  /** сроки (часть 37): у скольких приёмов срок был и у скольких выполнен */
  /** сроки — всего и по видам (`by`: какой срок сколько раз был и сколько раз выполнен) */
  targets: { onTime: number; total: number; by: Record<Id, { onTime: number; total: number }> };
}

/** КТ и ПИТ у группы больных: обследования КТ — сколько, оплата, расходники; закрытые случаи ПИТ — сколько, оплата, койко-дни. */
interface WingUse { ctExams: number; ctFees: number; ctConsumables: number; icuStays: number; icuIncome: number; icuBedDays: number }
const noWing = (): WingUse => ({ ctExams: 0, ctFees: 0, ctConsumables: 0, icuStays: 0, icuIncome: 0, icuBedDays: 0 });

/** Что стоят за день палаты, операционная, кабинет КТ и ПИТ: содержание помещений и аппаратов и зарплаты людей в них. */
function unitCosts(s: ShiftState): Record<Unit, { upkeep: number; staff: number }> {
  const out: Record<Unit, { upkeep: number; staff: number }> = { ward: { upkeep: 0, staff: 0 }, or: { upkeep: 0, staff: 0 }, ct: { upkeep: 0, staff: 0 }, icu: { upkeep: 0, staff: 0 } };
  for (const r of s.hospital!.rooms) {
    const unit = UNITS[r.type];
    if (!unit) continue;
    let upkeep = sizeOf(db, r.type, r.size)?.upkeep ?? 0;
    for (const e of r.equipment) if (e) upkeep += db.equipment[e]?.upkeep ?? 0;
    out[unit].upkeep += upkeep;
    out[unit].staff += (s.staff ?? []).filter(m => m.room === r.id).reduce((a, m) => a + m.salary, 0);
  }
  return out;
}

/** Цена обследования для плательщика, % записанной (как в `caseIncome`). */
function priceOf(payer: Payer): number {
  const t = db.economy.tariffs;
  return payer === 'oms' ? t.omsExam : payer === 'dms' ? t.dms.price : t.self.price;
}

/**
 * Запас идущих сроков больного (spec 2026-10-chapter-3, часть 46б): минут до конца каждого за вычетом того, что нужно,
 * чтобы его выполнить, — дойти до больного (`walk`: позвать, попросить подождать того, кто в кабинете) и получить
 * результат самого быстрого его обследования в этой больнице; у срока на решение — две минуты оформить. Меньше нуля —
 * срок уже не успеть.
 */
function margins(s: ShiftState, p: ShiftPatient, walk: number): number[] {
  return targetsFor(db, p, targetPlace(db, s, p)).flatMap(t => {
    const start = targetStart(p, t);
    if (start === undefined || minutesTo(p, t) !== undefined) return [];
    const need = t.exams.length > 0 ? Math.min(...t.exams.map(e => readyIn(db, s, p, e) ?? Infinity)) : 2;
    return [t.minutes - (s.t - start) / 60 - walk - need];
  });
}

/**
 * Кого звать (spec 2026-10-chapter-3, часть 42а): разумный — того, у кого раньше кончается идущий срок
 * (ЭКГ при боли в груди — 10 минут от прихода): вернувшийся с результатами той же срочности стоит в
 * очереди раньше привезённого, а ему срок не нужен. С частью 43г — и ниже по срочности: «попросить
 * подождать» ради срока можно и того, кто выше (`moreUrgent`), и звать надо того, ради кого просили. С частью
 * 46б — по запасу: сначала тот, чей срок ещё успеть, с меньшим запасом; потом те, чей срок уже вышел. Сроков нет —
 * первого в очереди.
 */
function firstDue(s: ShiftState): string {
  let best: { id: string; key: number } | undefined;
  for (const id of s.queue) {
    const ms = margins(s, s.patients[id], 1);
    if (ms.length === 0) continue;
    const ok = ms.filter(m => m >= 0);
    const key = ok.length > 0 ? Math.min(...ok) : 1e6 + Math.min(...ms);
    if (!best || key < best.key) best = { id, key };
  }
  return best?.id ?? s.queue[0];
}

/**
 * Не отпускать (spec 2026-10-chapter-3, часть 46б) того, у кого свой срок ещё успеть, ради срока, который уже не
 * успеть: после ЭКГ с подъёмом ST — решить о тромболизисе, а не идти к привезённому с инсультом, чей осмотр в
 * 10 минут уже опоздал. Ждёт тот, чей срок ещё успеть и запас меньше, — отпустить.
 */
function keep(s: ShiftState, p: ShiftPatient): boolean {
  const own = margins(s, p, 0).filter(m => m >= 0);
  if (own.length === 0) return false;
  const mine = Math.min(...own);
  return !s.queue.some(id => margins(s, s.patients[id], 2).some(m => m >= 0 && m < mine));
}

function beliefsOf(s: ShiftState, p: ShiftPatient) {
  const obs = observationsOf(p);
  return { obs, beliefs: posterior(db, candidatesOf(db, p.departments ?? s.meta.department), obs, contextOf(db, p.patient, obs)) };
}

/**
 * Утренний обход: разумный выписывает, когда можно, хуже — в операционную (есть операция и она
 * возможна) или переводит; ленивый выписывает всех, кто не ждёт операции и не на столе.
 */
function rounds(s: ShiftState, player: Player, step: (cmd: Command) => void) {
  for (const p of inpatientsOf(s)) {
    const stay = p.stay!;
    if (stay.op && !stay.op.done) continue;
    const days = daysIn(stay, s.day);
    if (days < 1) continue;
    if (player === 'lazy') {
      step({ kind: 'discharge', id: p.id });
      continue;
    }
    const state = wardState(stay, days);
    if (state === 'ready') step({ kind: 'discharge', id: p.id });
    else if (state === 'worse' && !stay.op && p.closed && operationOf(db, p, p.closed.diagnosis)) {
      step({ kind: 'operate', id: p.id });
      if (!p.stay?.op) step({ kind: 'transfer', id: p.id });
    } else if (state === 'worse' || state === 'reaction') step({ kind: 'transfer', id: p.id });
  }
}

/** Закрыть приём: диагноз, назначения и место; своя палата, ПИТ или операционная не берёт — скорая. */
function decide(s: ShiftState, p: ShiftPatient, diagnosis: Id, plan: { treatments: readonly Id[]; setting: Setting }) {
  const step = (cmd: Command) => apply(db, s, cmd);
  step({ kind: 'diagnose', id: diagnosis });
  for (const id of plan.treatments) step({ kind: 'toggleTreatment', id });
  step({ kind: 'setting', setting: plan.setting });
  if (p.draft.setting !== plan.setting) step({ kind: 'setting', setting: 'ambulance' });
  step({ kind: 'finish' });
  if (current(s)?.id === p.id) {
    step({ kind: 'setting', setting: 'ambulance' });
    step({ kind: 'finish' });
  }
}

/**
 * Что есть у разумного для этого больного (spec 2026-10-chapter-3, часть 46б): свободная койка палаты и ПИТ,
 * операционная, аппараты у постели (в смотровой с монитором — тромболизис), минуты с прихода — окна по часам, и
 * через сколько придёт результат обследования в этой больнице.
 */
function venueFor(s: ShiftState, p: ShiftPatient): Venue {
  return {
    ...(freeBeds(db, s).length > 0 ? { ward: true } : {}), or: true, ...(freeIcuBeds(db, s).length > 0 ? { icu: true } : {}),
    bedside: bedsideEquipment(db, s, p), minutes: Math.round((s.t - p.arriveT) / 60), ready: id => readyIn(db, s, p, id),
  };
}

function playDay(s: ShiftState, player: Player) {
  const step = (cmd: Command) => apply(db, s, cmd);
  rounds(s, player, step);
  const ctx = hospitalCtx(db, s);
  const exams = Object.keys(db.exams).sort().filter(id => !('block' in examWhere(db, ctx.plan, ctx.working, ctx.staffed, id)));
  /** ленивый: что ещё сделает у пациента — его план при первом вызове */
  const todo = new Map<string, Id[]>();
  /** разумный: где он в решении (вопросы перед назначением) и что назначить не вышло */
  const phases = new Map<string, DoctorPhase>();
  const skipped = new Map<string, Set<Id>>();
  for (let guard = 0; guard < 20000; guard++) {
    // привезённых — сортировать: разумный — по шкале, ленивый — всех «зелёными»
    for (const p of Object.values(s.patients)) {
      if (p.kind !== 'ambulance' || p.status !== 'waiting' || p.sorted || !p.scale) continue;
      step({ kind: 'sort', id: p.id, triage: player === 'rational' ? p.scale.triage : 'green' });
    }
    const waiting = Object.values(s.patients).some(p => p.status === 'away' || p.status === 'coming' || (p.kind === 'ambulance' && p.status === 'waiting' && !p.sorted));
    if (s.t % DAY >= SHIFT_END && s.queue.length === 0 && !s.current && !waiting) break;
    if (!s.current && s.queue.length > 0) {
      step({ kind: 'call', id: player === 'rational' ? firstDue(s) : s.queue[0] });
      // пока звал, привезла скорая — сначала её рассортировать, потом решать, кого смотреть: иначе того, кого
      // позвали, просят подождать ради неразобранной машины и тут же зовут снова
      if (s.current) continue;
    }
    const p = current(s);
    if (!p) {
      step({ kind: 'advance', seconds: 60 });
      continue;
    }
    const candidates = candidatesOf(db, p.departments ?? s.meta.department);
    if (player === 'lazy') {
      if (!todo.has(p.id)) todo.set(p.id, runDoctor(db, p.patient, player, Rng.seeded(s.meta.seed).fork(`sim:${p.id}`), { candidates, exams }).exams);
      const next = todo.get(p.id)!.shift();
      if (next) {
        step({ kind: 'exam', exam: next });
        continue;
      }
      if (p.pending.length > 0) {
        if (s.queue.length > 0) {
          step({ kind: 'sendAway' });
          continue;
        }
        step({ kind: 'waitResults' });
        if (p.pending.length > 0) continue;
      }
      const { obs, beliefs } = beliefsOf(s, p);
      decide(s, p, beliefs[0].id, choosePlan(db, beliefs[0].id, obs, p.patient.age, venueFor(s, p)));
      continue;
    }
    // Разумный (spec 2026-10-chapter-3, часть 46б) — тот же, что у «Виртуального врача» и нанятого врача
    // (`nextStep`), шаг за шагом по пришедшему: сроки первым делом, КТ при инсульте сразу после осмотра и
    // вопроса о начале, тромболизис у постели под монитором с расспросом перед ним, ПИТ. Пока идут результаты,
    // делает то, что можно сейчас; решать — когда они пришли, а если идёт срок решения (подъём ST), — сразу.
    // Привезли срочнее — просит подождать того, кто в кабинете (часть 37)
    if (moreUrgent(db, s, p) && !keep(s, p)) {
      step({ kind: 'sendAway' });
      continue;
    }
    const venue = venueFor(s, p);
    const skip = skipped.get(p.id);
    const r = nextStep(db, p.patient, observationsOf(p), p.done, phases.get(p.id) ?? {}, {
      candidates, exams: skip ? exams.filter(e => !skip.has(e)) : exams, threshold: 0.9, minGain: MIN_GAIN, venue,
    });
    if (r.step.kind === 'exam') {
      phases.set(p.id, r.phase);
      step({ kind: 'exam', exam: r.step.exam });
      // назначить нельзя (кабинет не работает) — дальше без него
      if (!p.done.includes(r.step.exam)) (skipped.get(p.id) ?? skipped.set(p.id, new Set()).get(p.id)!).add(r.step.exam);
      continue;
    }
    if (p.pending.length > 0 && decisionLimit(db, observationsOf(p), p.patient.complaints, venue.minutes) === undefined) {
      // решать по пришедшему: пока результаты идут — к другим или ждать, потом решить заново
      phases.delete(p.id);
      if (s.queue.length > 0) {
        step({ kind: 'sendAway' });
        continue;
      }
      step({ kind: 'waitResults' });
      continue;
    }
    phases.delete(p.id);
    decide(s, p, r.step.diagnosis, r.step.plan);
  }
  step({ kind: 'closeDay' });
}

function run(seed: number, player: Player, chapter: Id): Run {
  const s = newCampaign(db, { seed, season, career: 1, chapter });
  const out: Run = {
    profit: 0, minCash: s.economy!.cash, cash: 0, reputation: 0,
    arrived: 0, seen: 0, left: 0, unseen: 0, correct: 0, wrong: 0, departments: {},
    ambulance: { arrived: 0, sorted: 0, under: 0, over: 0 },
    ward: { admitted: 0, discharged: 0, early: 0, transferred: 0, died: 0, stayDays: 0, stayNorm: 0, returnsWorse: 0 },
    ops: { done: 0, onTime: 0, late: 0, complicated: 0, waited: 0, complications: 0, good: 0 },
    money: {
      income: 0, opIncome: 0, bedDays: 0, opConsumables: 0, closedBedDays: 0, closedOpCost: 0, opCases: 0, opCasesBedDays: 0,
      units: { ward: { upkeep: 0, staff: 0 }, or: { upkeep: 0, staff: 0 }, ct: { upkeep: 0, staff: 0 }, icu: { upkeep: 0, staff: 0 } }, ledgerWard: 0, stays: 0,
    },
    wing: { cn: noWing(), other: noWing(), neuroIncome: 0, neuroCosts: 0, neuroSeen: 0 },
    missions: {}, harmed: 0, targets: { onTime: 0, total: 0, by: {} },
  };
  const operated = new Set<string>();
  const closedStays = new Set<string>();
  /** приёмы, оплата которых уже в счёте; сколько обследований каждого пациента уже в счёте расходников */
  const visits = new Set<string>();
  const examsCounted = new Map<string, number>();
  for (let d = 0; d < DAYS; d++) {
    apply(db, s, { kind: 'nextDay' });
    if (!s.dayOpen) throw new Error(`${player}: смену не открыть`);
    playDay(s, player);
    const h = s.history[s.history.length - 1];
    const l = h.economy!.ledger;
    out.profit += incomeOf(l) - expensesOf(l);
    out.minCash = Math.min(out.minCash, h.economy!.cash);
    out.arrived += h.arrived;
    out.seen += h.seen;
    out.left += h.left;
    out.unseen += h.unseen;
    out.correct += h.correct;
    out.wrong += h.wrong;
    for (const k of Object.keys(out.ambulance) as (keyof Run['ambulance'])[]) out.ambulance[k] += h.ambulance?.[k] ?? 0;
    for (const [id, t] of Object.entries(h.targets ?? {})) {
      out.targets.onTime += t.onTime;
      out.targets.total += t.total;
      const by = (out.targets.by[id] ??= { onTime: 0, total: 0 });
      by.onTime += t.onTime;
      by.total += t.total;
    }
    const w = h.ward;
    if (w) {
      out.ward.admitted += w.admitted;
      out.ward.discharged += w.discharged;
      out.ward.early += w.early;
      out.ward.transferred += w.transferred;
      out.ward.died += w.died ?? 0;
      out.ward.stayDays += w.stayDays;
      out.ward.stayNorm += w.stayNorm;
    }
    const o = h.surgery;
    if (o) {
      out.ops.done += o.done;
      out.ops.onTime += o.onTime;
      out.ops.late += o.late;
      out.ops.complicated += o.complicated ?? 0;
      out.ops.waited += o.waited ?? 0;
      out.ops.complications += o.complications;
      out.ops.good += o.good ?? 0;
    }
    out.money.ledgerWard += l.ward?.income ?? 0;
    // койко-дни всех, кто ночует, — и тех, кто ещё лежит (как в settle): в палате — у стационара, в ПИТ — у крыла
    const lying = inpatientsOf(s);
    const icuLying = lying.filter(p => inIcu(db, s, p)).length;
    if ((l.expenses.ward ?? 0) !== (lying.length - icuLying) * db.economy.ward.bedDay + icuLying * db.economy.icu.bedDay) throw new Error(`${player}: койко-дни дня ${s.day} не сходятся с кассой`);
    out.money.bedDays += (lying.length - icuLying) * db.economy.ward.bedDay;
    const unit = unitCosts(s);
    for (const k of Object.keys(unit) as Unit[]) {
      out.money.units[k].upkeep += unit[k].upkeep;
      out.money.units[k].staff += unit[k].staff;
    }
    for (const p of Object.values(s.patients)) {
      const op = p.stay?.op;
      if (op?.done && !operated.has(p.id)) {
        operated.add(p.id);
        out.money.opConsumables += db.treatments[op.tx].cost;
      }
      // крыло главы 3: больные кардиологии и неврологии — по болезни, которой болен на самом деле
      const group = profileOf(p.patient.truth.conditions[0].id);
      const use = group ? out.wing.cn : out.wing.other;
      // расходники обследований — каждого сделанного: КТ — у крыла; у больных неврологии — и остальных
      for (const id of p.done.slice(examsCounted.get(p.id) ?? 0)) {
        const cost = consumablesOf(db, db.exams[id]);
        if (isCt(id)) {
          use.ctExams++;
          use.ctConsumables += cost;
        } else if (group === 'neurology') out.wing.neuroCosts += cost;
      }
      examsCounted.set(p.id, p.done.length);
      // приём оплачен — обследования КТ, которые страховая оплатила (как в caseIncome); у больных неврологии — и сам приём
      if (p.paid && !visits.has(p.id)) {
        visits.add(p.id);
        const price = priceOf(p.payer ?? 'oms');
        const fees = p.done.filter(id => isCt(id) && !p.paid!.unindicated.includes(id)).reduce((a, id) => a + Math.round((db.exams[id].cost * price) / 100), 0);
        use.ctFees += fees;
        if (group === 'neurology') {
          out.wing.neuroIncome += p.paid.paid - fees;
          out.wing.neuroSeen++;
        }
      }
      // случай стационара закрыт — его оплата, койко-дни и расходники, прибавка за операцию и за ПИТ (как в closeStay)
      if (p.closed?.stay && p.stay && !closedStays.has(p.id)) {
        closedStays.add(p.id);
        const end = p.closed.stay.end;
        const chosen = p.stay.plan.setting === 'surgery' ? 'surgery' : p.stay.plan.setting === 'icu' ? 'icu' : 'admit';
        const done = p.results.map(r => r.exam);
        const recommended = recommendedSetting(db, p.patient, done, p.closed.bedside);
        const over = settingFit(recommended, chosen, alsoSettings(db, p.patient, done)) === 'over';
        const close: WardClose = over ? 'unindicated' : p.afterEarly ? 'repeat' : end === 'discharged' || end === 'died' ? 'full' : 'interrupted';
        const paid = wardIncome(db, p.closed.diagnosis, p.closed.grades.defensibility, close, op?.done ? op.tx : undefined, chosen === 'icu' && recommended === 'icu');
        out.money.stays += paid;
        if (inIcu(db, s, p)) {
          use.icuStays++;
          use.icuIncome += paid;
          use.icuBedDays += p.closed.stay.days * db.economy.icu.bedDay;
        } else {
          out.money.income += paid;
          out.money.closedBedDays += p.closed.stay.days * db.economy.ward.bedDay;
          if (group === 'neurology') {
            out.wing.neuroIncome += paid;
            out.wing.neuroCosts += p.closed.stay.days * db.economy.ward.bedDay;
          }
        }
        if (op?.done) {
          out.money.closedOpCost += db.treatments[op.tx].cost;
          out.money.opIncome += paid - wardIncome(db, p.closed.diagnosis, p.closed.grades.defensibility, close);
          out.money.opCases += paid;
          out.money.opCasesBedDays += p.closed.stay.days * db.economy.ward.bedDay;
        }
      }
      if (p.kind === 'return' && Math.floor(p.arriveT / DAY) + 1 === s.day && (p.returnReason === 'worse' || p.returnReason === 'reaction')) {
        out.harmed++;
        if (p.afterEarly) out.ward.returnsWorse++;
      }
      if (!p.closed || Math.floor(p.closed.at / DAY) + 1 !== s.day || p.by !== undefined) continue;
      const dept = db.conditions[p.patient.truth.conditions[0].id]?.department ?? '—';
      const x = (out.departments[dept] ??= { seen: 0, correct: 0 });
      x.seen++;
      if (p.closed.verdict === 'correct') x.correct++;
    }
  }
  out.harmed += out.ward.died;
  if (out.money.stays !== out.money.ledgerWard) throw new Error(`${player}: оплата случаев стационара ${out.money.stays} ₽ не сходится с кассой ${out.money.ledgerWard} ₽`);
  out.cash = s.economy!.cash;
  out.reputation = s.economy!.reputation ?? 0;
  for (const m of db.chapters[chapter].missions.filter(x => x.main)) {
    const at = s.campaign?.done[m.id];
    out.missions[m.id] = at === undefined ? undefined : at - s.campaign!.since;
  }
  return out;
}

/**
 * Глава 1: лаборатория — на её месте в амбулатории посёлка (как в `campaign.test.ts`), с
 * анализатором; лаборант — как только он есть среди кандидатов. Строят и нанимают между сменами.
 */
function openLab(s: ShiftState) {
  if (!s.hospital!.rooms.some(r => r.type === 'room.lab')) {
    const rec = db.presets[db.chapters[s.campaign!.chapter].preset].rooms[0];
    const [dx, dy] = [s.hospital!.rooms[0].x - rec.x, s.hospital!.rooms[0].y - rec.y];
    apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.lab', size: 'S', x: 22 + dx, y: dy, rot: 0 } });
    const lab = s.hospital!.rooms.find(r => r.type === 'room.lab');
    if (!lab) throw new Error('карьера: лаборатория не встала на своё место');
    apply(db, s, { kind: 'build', cmd: { kind: 'buy', room: lab.id, equipment: 'eq.hematology_analyzer' } });
    apply(db, s, { kind: 'buildEnd' });
  }
  const lab = s.hospital!.rooms.find(r => r.type === 'room.lab')!;
  if ((s.staff ?? []).some(m => m.room === lab.id)) return;
  const tech = s.candidates?.find(c => c.role === 'role.lab_tech');
  if (tech) {
    apply(db, s, { kind: 'hire', id: tech.id });
    apply(db, s, { kind: 'assign', id: tech.id, room: lab.id });
  }
}

/**
 * Глава 3 (spec 2026-10-chapter-3, часть 46б): крыло — кабинет КТ и ПИТ на их местах в готовой больнице главы, с её
 * аппаратами, и коридоры к ним; люди — как только они есть среди кандидатов. Строят и нанимают между сменами.
 */
function openWing(s: ShiftState) {
  const preset = db.presets[db.chapters[s.campaign!.chapter].preset];
  const wing = preset.rooms.filter(r => r.type === 'room.ct' || r.type === 'room.icu');
  if (!s.hospital!.rooms.some(r => r.type === 'room.ct')) {
    const h = s.hospital!;
    const [dx, dy] = [h.rooms[0].x - preset.rooms[0].x, h.rooms[0].y - preset.rooms[0].y];
    const have = new Set(h.corridor.map(i => `${i % h.w},${Math.floor(i / h.w)}`));
    const cells = preset.corridor.map(([x, y]): [number, number] => [x + dx, y + dy]).filter(([x, y]) => !have.has(`${x},${y}`));
    apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
    for (const r of wing) {
      apply(db, s, { kind: 'build', cmd: { kind: 'room', type: r.type, size: r.size, x: r.x + dx, y: r.y + dy, rot: r.rot } });
      const room = s.hospital!.rooms.find(x => x.type === r.type);
      if (!room) throw new Error(`карьера: ${r.type} не встал на своё место`);
      for (const e of r.equipment ?? []) apply(db, s, { kind: 'build', cmd: { kind: 'buy', room: room.id, equipment: e } });
    }
    apply(db, s, { kind: 'buildEnd' });
  }
  for (const r of wing) {
    const room = s.hospital!.rooms.find(x => x.type === r.type)!;
    for (const role of db.rooms[r.type].staff) {
      if ((s.staff ?? []).some(m => m.room === room.id && m.role === role)) continue;
      const c = s.candidates?.find(x => x.role === role);
      if (!c) continue;
      apply(db, s, { kind: 'hire', id: c.id });
      apply(db, s, { kind: 'assign', id: c.id, room: room.id });
    }
  }
}

/** Карьера: за сколько дней выполнены основные задания каждой главы (по порядку глав); касса — не ниже. */
interface Career { chapters: (number | undefined)[]; minCash: number; days: number }
const CHAPTERS = Object.values(db.chapters).sort((a, b) => a.order - b.order).map(c => c.id);

/** Карьера разумного с начала: в какой день каждой главы выполнены её основные задания. */
function career(seed: number): Career {
  const s = newCampaign(db, { seed, season, career: 1 });
  const out: Career = { chapters: CHAPTERS.map(() => undefined), minCash: s.economy!.cash, days: 0 };
  for (let d = 0; d < CAREER_DAYS; d++) {
    const c = s.campaign!;
    if (c.complete !== undefined) {
      out.chapters[CHAPTERS.indexOf(c.chapter)] = c.complete - c.since;
      if (!nextChapterOf(db, c)) break;
      apply(db, s, { kind: 'nextChapter' });
      if (s.campaign!.chapter === c.chapter) throw new Error(`карьера: из главы «${db.chapters[c.chapter].name.ru}» не перейти`);
    }
    if (s.campaign!.chapter === 'chapter.district') openLab(s);
    if (s.campaign!.chapter === 'chapter.vascular') openWing(s);
    apply(db, s, { kind: 'nextDay' });
    if (!s.dayOpen) throw new Error('карьера: смену не открыть');
    playDay(s, 'rational');
    out.minCash = Math.min(out.minCash, s.economy!.cash);
    out.days = s.day;
  }
  return out;
}

const rub = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;
const pct = (a: number, b: number) => (100 * a) / Math.max(1, b);
const sum = (rs: Run[], f: (r: Run) => number) => rs.reduce((a, r) => a + f(r), 0);
const mean = (rs: Run[], f: (r: Run) => number) => sum(rs, f) / Math.max(1, rs.length);

const t0 = performance.now();
const monthOf = (c: Id, pl: Player) => Array.from({ length: RUNS }, (_, i) => run(3500 + i, pl, c));
const results: Record<Id, Record<Player, Run[]>> = Object.fromEntries(MONTHS.map(c => [c, { rational: monthOf(c, 'rational'), lazy: monthOf(c, 'lazy') }]));
const careers = CAREER ? Array.from({ length: RUNS }, (_, i) => career(3500 + i)) : [];
const seconds = Math.round((performance.now() - t0) / 1000);

const unitOf = (r: Run, u: Unit) => r.money.units[u].upkeep + r.money.units[u].staff;
/** траты палат и операционной: у закрытых случаев — их койко-дни и расходники; `all` — все, и тех, кто ещё лежит */
const costsOf = (r: Run, all = false) => (all ? r.money.bedDays + r.money.opConsumables : r.money.closedBedDays + r.money.closedOpCost) + unitOf(r, 'ward') + unitOf(r, 'or');
/** операционная со своими случаями: их койко-дни, расходники, содержание операционной и бригада */
const orCostsOf = (r: Run) => r.money.opCasesBedDays + r.money.closedOpCost + unitOf(r, 'or');
/**
 * Кабинет КТ (глава 3): оплата обследований КТ у больных кардиологии и неврологии и приём и палата больных
 * неврологии — их без КТ не везут — против кабинета с томографом и людей, расходников КТ, койко-дней и расходников
 * больных неврологии.
 */
const ctIncomeOf = (r: Run) => r.wing.cn.ctFees + r.wing.neuroIncome;
const ctCostsOf = (r: Run) => unitOf(r, 'ct') + r.wing.cn.ctConsumables + r.wing.neuroCosts;
/** ПИТ (глава 3): закрытые случаи ПИТ больных кардиологии и неврологии против палаты с мониторами, людей и их койко-дней. */
const icuIncomeOf = (r: Run) => r.wing.cn.icuIncome;
const icuCostsOf = (r: Run) => unitOf(r, 'icu') + r.wing.cn.icuBedDays;
function summarize(rs: Run[]) {
  return {
    profit: Math.round(mean(rs, r => r.profit)), profitMin: Math.min(...rs.map(r => r.profit)), profitMax: Math.max(...rs.map(r => r.profit)),
    minCash: Math.min(...rs.map(r => r.minCash)), reputation: Math.round(mean(rs, r => r.reputation)),
    unitIncome: Math.round(mean(rs, r => r.money.income)), unitCosts: Math.round(mean(rs, r => costsOf(r))), unitCostsAll: Math.round(mean(rs, r => costsOf(r, true))),
    opSurcharge: Math.round(mean(rs, r => r.money.opIncome)),
    orIncome: Math.round(mean(rs, r => r.money.opCases)), orCosts: Math.round(mean(rs, orCostsOf)),
    ctIncome: Math.round(mean(rs, ctIncomeOf)), ctCosts: Math.round(mean(rs, ctCostsOf)),
    icuIncome: Math.round(mean(rs, icuIncomeOf)), icuCosts: Math.round(mean(rs, icuCostsOf)),
    opsOnTime: pct(sum(rs, r => r.ops.onTime), sum(rs, r => r.ops.onTime + r.ops.late)),
    waited: pct(sum(rs, r => r.ops.waited), sum(rs, r => r.ops.done)),
    complicated: pct(sum(rs, r => r.ops.complicated), sum(rs, r => r.ops.done)),
    stayRatio: sum(rs, r => r.ward.stayDays) / Math.max(1, sum(rs, r => r.ward.stayNorm)),
    early: pct(sum(rs, r => r.ward.early), sum(rs, r => r.ward.discharged)),
    triageErrors: pct(sum(rs, r => r.ambulance.under + r.ambulance.over), sum(rs, r => r.ambulance.sorted)),
    returnsWorse: sum(rs, r => r.ward.returnsWorse) / Math.max(1, rs.length),
    died: sum(rs, r => r.ward.died) / Math.max(1, rs.length),
    harmed: pct(sum(rs, r => r.harmed), sum(rs, r => r.seen)),
    targetsOnTime: pct(sum(rs, r => r.targets.onTime), sum(rs, r => r.targets.total)),
    targetsTotal: sum(rs, r => r.targets.total),
  };
}
const summary: Record<Id, Record<Player, ReturnType<typeof summarize>>> = Object.fromEntries(
  MONTHS.map(c => [c, { rational: summarize(results[c].rational), lazy: summarize(results[c].lazy) }]),
);
interface Criterion { ok: boolean; text: string }
/** Критерии месяца главы: приёмка главы 2 — у обеих глав (больница та же), КТ и ПИТ — у главы 3. */
function criteriaOf(chapter: Id): Record<string, Criterion> {
  const [ra, la] = [summary[chapter].rational, summary[chapter].lazy];
  return {
    // критерий 4: касса и окупаемость стационара с операционной
    cashNeverNegative: { ok: ra.minCash >= 0, text: `у разумного касса ни разу не в минусе: не ниже ${rub(ra.minCash)}` },
    unitsPay: { ok: ra.unitIncome >= ra.unitCosts, text: `стационар и операционная окупают койко-дни, расходники, помещения и людей: ${rub(ra.unitIncome)} против ${rub(ra.unitCosts)}` },
    orPays: { ok: ra.orIncome >= ra.orCosts, text: `случаи с операцией окупают операционную и бригаду: ${rub(ra.orIncome)} против ${rub(ra.orCosts)}` },
    // критерий 3: пороги стационара и операций у разумного
    opsOnTime: { ok: ra.opsOnTime >= 90, text: `операции в срок — не меньше 90 %: ${ra.opsOnTime.toFixed(1)} %` },
    waitedRare: { ok: ra.waited <= 5, text: `осложнились, пока ждали операции, — не больше 5 %: ${ra.waited.toFixed(1)} %` },
    stayWithinNorm: { ok: ra.stayRatio <= 1, text: `средний срок стационара — не выше обычного: ${(100 * ra.stayRatio).toFixed(0)} % обычного` },
    triageClean: { ok: ra.triageErrors <= 5, text: `ошибок сортировки скорой — не больше 5 %: ${ra.triageErrors.toFixed(1)} %` },
    // часть 37: ЭКГ при боли в груди в первые 10 минут; в главе 3 — и сроки инсульта
    targetsOnTime: { ok: ra.targetsTotal > 0 && ra.targetsOnTime >= 90, text: `сроки выполнены — не меньше 90 %: ${ra.targetsOnTime.toFixed(1)} % из ${ra.targetsTotal} (у ленивого ${la.targetsOnTime.toFixed(1)} %)` },
    // ленивый — с осложнениями и ранними выписками
    lazyEarly: { ok: la.early >= 50 && la.returnsWorse > ra.returnsWorse, text: `у ленивого ранние выписки — ${la.early.toFixed(0)} % выписанных, вернулись после них хуже — ${la.returnsWorse.toFixed(1)} за ${DAYS} дней (у разумного ${ra.returnsWorse.toFixed(1)})` },
    lazyComplications: { ok: la.harmed >= 2 * ra.harmed, text: `у ленивого хуже стало хотя бы вдвое чаще, чем у разумного: ${la.harmed.toFixed(1)} против ${ra.harmed.toFixed(1)} на 100 принятых` },
    lazyEarnsLess: { ok: la.profit < ra.profit, text: `ленивый зарабатывает меньше: ${rub(la.profit)} против ${rub(ra.profit)}` },
    // глава 3 (spec 2026-10-chapter-3, критерий 4): КТ и ПИТ — крыло, одна программа — окупаются больными кардиологии
    // и неврологии; каждое помещение отдельно — в отчёте, для сведения
    ...(chapter === VASCULAR
      ? {
        wingPays: {
          ok: ra.ctIncome + ra.icuIncome >= ra.ctCosts + ra.icuCosts,
          text: `кабинет КТ и ПИТ окупаются больными кардиологии и неврологии: ${rub(ra.ctIncome + ra.icuIncome)} против ${rub(ra.ctCosts + ra.icuCosts)}`,
        },
      }
      : {}),
  };
}
const monthCriteria: Record<Id, Record<string, Criterion>> = Object.fromEntries(MONTHS.map(c => [c, criteriaOf(c)]));
// этапы 4 и 5: все главы проходятся от начала до конца
const careerCriteria: Record<string, Criterion> = CAREER
  ? {
    careerComplete: {
      ok: careers.every(c => c.chapters.every(x => x !== undefined)),
      text: `карьера разумного: все ${CHAPTERS.length} главы выполнены за ${CAREER_DAYS} дней на каждом зерне — ${CHAPTERS.map((_, i) => `глава ${i + 1} за ${careers.map(c => c.chapters[i] ?? '—').join('/')} дн.`).join(', ')}`,
    },
    careerSolvent: { ok: careers.every(c => c.minCash >= 0), text: `в карьере касса ни разу не в минусе: не ниже ${rub(Math.min(...careers.map(c => c.minCash)))}` },
  }
  : {};
const criteria: Record<string, Criterion> = {
  ...Object.fromEntries(MONTHS.flatMap(c => Object.entries(monthCriteria[c]).map(([k, x]) => [`${c.replace('chapter.', '')}.${k}`, x]))),
  ...careerCriteria,
};
const passed = Object.values(criteria).every(c => c.ok);

if (asJson) {
  console.log(JSON.stringify({ days: DAYS, runs: RUNS, season, contentVersion: db.contentVersion, chapters: summary, careers, criteria: Object.fromEntries(Object.entries(criteria).map(([k, c]) => [k, c.ok])) }, null, 2));
  process.exit(passed ? 0 : 1);
}

console.log(`Районная больница: ${DAYS} дней × ${RUNS} зёрен, сезон ${season}, база ${db.contentVersion}, ${seconds} с`);
const names: Record<Player, string> = { rational: 'Разумный', lazy: 'Ленивый' };
for (const chapter of MONTHS) {
  const ch = db.chapters[chapter];
  console.log(`\nГлава ${ch.order} «${ch.name.ru}» с начала, в кассе на старте ${rub(ch.budget)}`);
  for (const pl of PLAYERS) {
    const rs = results[chapter][pl];
    const n = rs.length * DAYS;
    const x = summary[chapter][pl];
    const f = (g: (r: Run) => number) => sum(rs, g);
    console.log(`\n${names[pl]}`);
    console.log(`  в день: пришли ${(f(r => r.arrived) / n).toFixed(1)}, приняты ${pct(f(r => r.seen), f(r => r.arrived)).toFixed(1)} %, ушли ${pct(f(r => r.left), f(r => r.arrived)).toFixed(1)} %, не приняты ${pct(f(r => r.unseen), f(r => r.arrived)).toFixed(1)} %; верно ${pct(f(r => r.correct), f(r => r.seen)).toFixed(1)} %`);
    const depts = [...new Set(rs.flatMap(r => Object.keys(r.departments)))].sort();
    console.log(`  верно по отделениям: ${depts.map(d => `${d.replace('dept.', '')} ${pct(f(r => r.departments[d]?.correct ?? 0), f(r => r.departments[d]?.seen ?? 0)).toFixed(1)} % из ${f(r => r.departments[d]?.seen ?? 0)}`).join(', ')}`);
    console.log(`  скорая: ${(f(r => r.ambulance.arrived) / n).toFixed(1)} в день; ошибок сортировки ${x.triageErrors.toFixed(1)} % (недооценили ${f(r => r.ambulance.under)}, переоценили ${f(r => r.ambulance.over)} из ${f(r => r.ambulance.sorted)})`);
    const kinds = [...new Set(rs.flatMap(r => Object.keys(r.targets.by)))].sort();
    const kind = (id: Id) => `${id.replace('target.', '')} ${f(r => r.targets.by[id]?.onTime ?? 0)} из ${f(r => r.targets.by[id]?.total ?? 0)}`;
    console.log(`  сроки: в срок ${x.targetsOnTime.toFixed(1)} % из ${x.targetsTotal}${kinds.length > 0 ? ` — ${kinds.map(kind).join(', ')}` : ''}`);
    console.log(`  стационар: положили ${f(r => r.ward.admitted)}, выписали ${f(r => r.ward.discharged)} (рано ${x.early.toFixed(1)} %, вернулись хуже ${f(r => r.ward.returnsWorse)}), перевели ${f(r => r.ward.transferred)}, умерли ${f(r => r.ward.died)}; срок ${(100 * x.stayRatio).toFixed(0)} % обычного`);
    console.log(`  операции: ${f(r => r.ops.done)}, в срок ${x.opsOnTime.toFixed(1)} %, осложнённых на столе ${x.complicated.toFixed(1)} % (из них — пока ждали ${x.waited.toFixed(1)} % всех операций), осложнений после ${pct(f(r => r.ops.complications), f(r => r.ops.done)).toFixed(1)} %`);
    const per = (g: (r: Run) => number) => rub(f(g) / rs.length);
    console.log(`  стационар и операционная за ${DAYS} дней: случаи ${rub(x.unitIncome)} против ${rub(x.unitCosts)} — койко-дни закрытых ${per(r => r.money.closedBedDays)}, расходники операций ${per(r => r.money.closedOpCost)}, палаты ${per(r => r.money.units.ward.upkeep)}, медсёстры палат ${per(r => r.money.units.ward.staff)}, операционная ${per(r => r.money.units.or.upkeep)}, бригада ${per(r => r.money.units.or.staff)}; со всеми койко-днями и расходниками, и тех, кто ещё лежит, — против ${rub(x.unitCostsAll)}`);
    console.log(`  из них случаи с операцией: ${rub(x.orIncome)} (прибавка за операции с их расходниками — ${rub(x.opSurcharge)}) против ${rub(x.orCosts)} — их койко-дни, расходники, операционная и бригада`);
    if (chapter === VASCULAR) {
      const avg = (g: (r: Run) => number) => (f(g) / rs.length).toFixed(1);
      console.log(`  кабинет КТ за ${DAYS} дней: больные кардиологии и неврологии — ${rub(x.ctIncome)} против ${rub(x.ctCosts)}: обследования КТ ${per(r => r.wing.cn.ctFees)} (${avg(r => r.wing.cn.ctExams)}), больные неврологии — их без КТ не везут — приём и палата ${per(r => r.wing.neuroIncome)} (${avg(r => r.wing.neuroSeen)} принятых); против — кабинет с томографом ${per(r => r.money.units.ct.upkeep)}, рентгенолаборант и рентгенолог ${per(r => r.money.units.ct.staff)}, расходники КТ ${per(r => r.wing.cn.ctConsumables)}, койко-дни и расходники больных неврологии ${per(r => r.wing.neuroCosts)}`);
      console.log(`  ПИТ за ${DAYS} дней: случаи больных кардиологии и неврологии — ${rub(x.icuIncome)} (${avg(r => r.wing.cn.icuStays)}) против ${rub(x.icuCosts)}: палата с мониторами ${per(r => r.money.units.icu.upkeep)}, медсестра и анестезиолог-реаниматолог ${per(r => r.money.units.icu.staff)}, койко-дни ${per(r => r.wing.cn.icuBedDays)}`);
      console.log(`  другие больные (для сведения): КТ — ${avg(r => r.wing.other.ctExams)} обследований, оплата ${per(r => r.wing.other.ctFees)}, расходники ${per(r => r.wing.other.ctConsumables)}; ПИТ — ${avg(r => r.wing.other.icuStays)} случаев, оплата ${per(r => r.wing.other.icuIncome)}, койко-дни ${per(r => r.wing.other.icuBedDays)}`);
    }
    console.log(`  стало хуже (вернулись хуже или с реакцией, умерли): ${x.harmed.toFixed(1)} на 100 принятых`);
    console.log(`  прибыль за ${DAYS} дней: ${rub(x.profit)} (${rub(x.profitMin)} … ${rub(x.profitMax)}); касса не ниже ${rub(x.minCash)}; репутация ${x.reputation}`);
    const main = ch.missions.filter(m => m.main).map(m => m.id);
    console.log(`  основные задания, день главы: ${main.map(id => `${id} ${rs.map(r => r.missions[id] ?? '—').join('/')}`).join('; ')}`);
  }
  console.log(
    chapter === VASCULAR
      ? '\nКритерии главы 3 (spec 2026-10-chapter-3, приёмка 4: те же, что у главы 2, — больница та же, и КТ и ПИТ):'
      : '\nКритерии главы 2 (spec 2026-09-chapter-2, приёмка 3 и 4; сроки — spec 2026-10-chapter-3, часть 37):',
  );
  for (const c of Object.values(monthCriteria[chapter])) console.log(`  ${c.ok ? 'да ' : 'НЕТ'} ${c.text}`);
}
if (CAREER) {
  console.log(`\nКарьера разумного с начала: ${careers.map(c => `${c.chapters.map((x, i) => `глава ${i + 1} — ${x ?? '—'} дн.`).join(', ')}, касса не ниже ${rub(c.minCash)}`).join('; ')}`);
  console.log('Критерии карьеры (этапы 4 и 5 — 10-roadmap.md; spec 2026-10-chapter-3, приёмка 5):');
  for (const c of Object.values(careerCriteria)) console.log(`  ${c.ok ? 'да ' : 'НЕТ'} ${c.text}`);
}
process.exit(passed ? 0 : 1);
