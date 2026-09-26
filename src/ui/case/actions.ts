// Что умеет приём: у прототипа П4 (state/visit.ts) и у смены (state/session.ts) — свои
// действия, а экраны карты пациента, решения и итога — общие (src/ui/case).
import type { Href } from 'expo-router';
import type { Id, Setting } from '@/content/types';

export interface CaseActions {
  act(exam: Id): void;
  waitForResults(): void;
  /** смена: отпустить ждать результатов и пока принять другого */
  sendAway?(): void;
  chooseDiagnosis(id: Id): void;
  toggleTreatment(id: Id): void;
  chooseSetting(setting: Setting): void;
  finish(): void;
  routes: { decision: Href; outcome: Href };
}

/** Главная кнопка внизу экрана — что она делает, решает хозяин экрана. */
export interface FooterAction {
  title: string;
  testID: string;
  run(): void;
}
