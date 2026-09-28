// Подсказки наставника (spec 2026-09-campaign): в первую смену главы с обучением — по одной, в
// момент, когда подсказка к месту, и каждая — один раз за карьеру. Это не движок: смена о них
// не знает, вид решает по состоянию приёма и по тому, что уже показано. База приходит
// параметром, как у движка: тесты подставляют ту же собранную базу.
import type { ContentDb, Id, Tip } from '@/content/types';
import type { CampaignProgress } from '@/engine/campaign/campaign';
import type { ShiftPatient } from '@/engine/shift/types';

/** Где врач: карта пациента, «Решение», итог приёма с разбором. */
export type TipScreen = 'card' | 'decision' | 'review';

/** Подсказки карьеры: какие показаны, выключены ли. */
export type TipsState = NonNullable<CampaignProgress['tips']>;

/** Что сейчас с приёмом — всё, по чему видно, к месту ли подсказка. */
export interface TipMoment {
  screen: TipScreen;
  patient: string;
  /** основная болезнь: первых пациентов задала глава, наставник их знает */
  condition: Id;
  /** сколько задано вопросов и сколько раз осмотрен; давление в доврачебном — не в счёт */
  asked: number;
  examined: number;
  decided: boolean;
}

export function momentOf(db: ContentDb, screen: TipScreen, p: ShiftPatient): TipMoment {
  const kinds = p.done.map(id => db.exams[id]?.kind);
  return {
    screen,
    patient: p.id,
    condition: p.patient.truth.conditions[0].id,
    asked: kinds.filter(k => k === 'ask').length,
    examined: kinds.filter(k => k === 'physical').length,
    decided: !!p.closed,
  };
}

/** Момент одной строкой: пока он тот же, вторая подсказка подряд не показывается. */
export const momentKey = (m: TipMoment) => `${m.screen}:${m.patient}:${m.asked}:${m.examined}`;

/**
 * К месту ли подсказка: карта открылась, а врач ещё не спрашивал и не осматривал; задал два
 * вопроса и ещё не осматривал; у пациента с болезнью подсказки — после первого вопроса или
 * осмотра; «Решение»; разбор.
 */
export function tipFits(t: Tip, m: TipMoment): boolean {
  const w = t.when;
  const card = m.screen === 'card' && !m.decided;
  if (typeof w === 'object') return card && m.condition === w.condition && m.asked + m.examined > 0;
  switch (w) {
    case 'caseOpen':
      return card && m.asked + m.examined === 0;
    case 'afterAsk':
      return card && m.asked >= 2 && m.examined === 0;
    case 'decision':
      return m.screen === 'decision' && !m.decided;
    case 'review':
      return m.screen === 'review' && m.decided;
  }
}

/**
 * Какую подсказку показать: первую по порядку, что к месту и ещё не показана. Только что
 * закрыли подсказку в этот же момент (`hold`) — следующая ждёт следующего действия врача.
 */
export function tipFor(db: ContentDb, st: TipsState, m: TipMoment, hold?: string): Tip | undefined {
  if (st.off || hold === momentKey(m)) return undefined;
  return Object.values(db.tips).find(t => !st.shown.includes(t.id) && tipFits(t, m));
}
