// Что умеет приём: у прототипа П4 (state/visit.ts) и у смены (state/session.ts) — свои
// действия, а экраны карты пациента, решения и итога — общие (src/ui/case).
import type { Href } from 'expo-router';
import type { Id, Setting } from '@/content/types';

export interface CaseActions {
  act(exam: Id): void;
  /** бланк направления (0.6.0): отмеченное — разом; нет — по одному через `act` */
  actAll?(exams: readonly Id[]): void;
  waitForResults(): void;
  /** смена: отпустить ждать результатов и пока принять другого */
  sendAway?(): void;
  chooseDiagnosis(id: Id): void;
  toggleTreatment(id: Id): void;
  chooseSetting(setting: Setting): void;
  /** дифференциальный ряд (spec 2026-10-differential): добавить гипотезу или убрать её */
  toggleHypothesis(id: Id): void;
  finish(): void;
  routes: { decision: Href; outcome: Href };
}

/** Главная кнопка внизу экрана — что она делает, решает хозяин экрана. */
export interface FooterAction {
  title: string;
  testID: string;
  run(): void;
}
