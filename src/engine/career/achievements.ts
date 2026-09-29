// Достижения (spec 2026-09-campaign, часть 13): чистые функции. Что врач сделал за всё время —
// счётчики профиля — и что есть сейчас (какие помещения своей больницы работают, какие главы
// выполнены) → какие достижения получены. Даты и хранение — профиль (src/state/profile.ts):
// у движка нет часов (ADR 0004).
import type { Achievement, ContentDb, Id } from '../../content/types';
import { alsoSettings, primaryOf, recommendedSetting, SETTING_ORDER, settingFit, txRole } from '../med/plan';
import type { ShiftPatient } from '../shift/types';

/** Вопрос об аллергии — для «Сначала спросить». */
export const ALLERGY_EXAM = 'exam.ask_allergies';

/** Всё, из чего складываются достижения. */
export interface CareerFacts {
  /** закрытые приёмы и рабочие дни (закрытые дни, когда кого-то приняли) */
  cases: number;
  days: number;
  /** верных диагнозов подряд — сейчас */
  run: number;
  /** приёмов с итоговой оценкой A; верных и бережливых; с вопросом об аллергии перед лекарством */
  gradeA: number;
  thrift: number;
  allergy: number;
  /** дней, когда приняты все, кто пришёл */
  noLeftDays: number;
  /** сыгранных случаев дня (первые попытки) */
  daily: number;
  /** болезнь → сколько раз встречалась в практике */
  seen: Readonly<Record<Id, number>>;
  /** какие помещения своей больницы работали в закрытый день */
  rooms: readonly Id[];
  /** выполненные главы кампании */
  chapters: readonly Id[];
}

const COUNTED: Record<Extract<Achievement, { count: number }>['kind'], (f: CareerFacts) => number> = {
  cases: f => f.cases,
  days: f => f.days,
  correctRun: f => f.run,
  gradeA: f => f.gradeA,
  thriftCase: f => f.thrift,
  allergyAsked: f => f.allergy,
  noLeftDay: f => f.noLeftDays,
  seenConditions: f => Object.values(f.seen).filter(n => n > 0).length,
  dailyCases: f => f.daily,
};

/** Выполнено ли условие достижения. */
export function achieved(db: ContentDb, a: Achievement, f: CareerFacts): boolean {
  switch (a.kind) {
    case 'department':
      return Object.values(db.conditions).filter(c => c.presenting && c.department === a.department).every(c => (f.seen[c.id] ?? 0) > 0);
    case 'roomWorks':
      return f.rooms.includes(a.room);
    case 'chapter':
      return f.chapters.includes(a.chapter);
    default:
      return COUNTED[a.kind](f) >= a.count;
  }
}

/** Новые достижения: ещё не полученные, чьё условие выполнено, — в порядке записи. */
export function newAchievements(db: ContentDb, f: CareerFacts, got: Readonly<Record<Id, unknown>>): Id[] {
  return Object.values(db.achievements).filter(a => got[a.id] === undefined && achieved(db, a, f)).map(a => a.id);
}

export interface CaseFacts {
  correct: boolean;
  gradeA: boolean;
  thrift: boolean;
  allergy: boolean;
  /** назначен антибиотик — и все назначенные показаны настоящей болезни (первая линия или замена) */
  antibiotic: boolean;
  antibioticIndicated: boolean;
  /** лечить надо не дома — и врач выбрал место не ниже нужного */
  danger: boolean;
  caught: boolean;
}

const NONE: CaseFacts = { correct: false, gradeA: false, thrift: false, allergy: false, antibiotic: false, antibioticIndicated: false, danger: false, caught: false };

/**
 * Что закрытый приём даёт достижениям и статистике профиля: верный ли диагноз, итог A,
 * бережливость (верный диагноз и обследования не дороже, чем у разумного врача), вопрос об
 * аллергии перед лекарством; антибиотик по показаниям — та же мерка ролей лечения, что у
 * «виртуального врача»; опасное распознано — место лечения не ниже нужного
 * (spec 2026-09-profile, часть 16).
 */
export function caseFacts(db: ContentDb, p: ShiftPatient): CaseFacts {
  const c = p.closed;
  if (!c) return NONE;
  const drug = c.plan.treatments.some(id => db.treatments[id]?.kind === 'drug');
  const { id: primary, params } = primaryOf(p.patient);
  const antibiotics = c.plan.treatments.filter(id => db.treatments[id]?.class?.startsWith('antibiotic.'));
  const recommended = recommendedSetting(db, p.patient);
  const danger = SETTING_ORDER[recommended] > SETTING_ORDER.home;
  return {
    correct: c.verdict === 'correct',
    gradeA: c.grades.overall === 'A',
    thrift: c.verdict === 'correct' && c.grades.thrift === 'A',
    allergy: drug && p.done.includes(ALLERGY_EXAM),
    antibiotic: antibiotics.length > 0,
    antibioticIndicated: antibiotics.length > 0 && antibiotics.every(id => ['firstLine', 'acceptable'].includes(txRole(db, primary, id, params))),
    danger,
    caught: danger && settingFit(recommended, c.plan.setting, alsoSettings(db, p.patient)) !== 'under',
  };
}
