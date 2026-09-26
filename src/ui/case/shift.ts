// Действия смены для общих экранов приёма: отпустить ждать результатов, после итога — к
// очереди (или к итогам дня, если разбор открыт из них).
import { router } from 'expo-router';
import { T } from '@/i18n';
import { chooseDiagnosis, chooseSetting, examine, finishCase, sendAway, toggleTreatment, waitForResults } from '@/state/session';
import type { CaseActions, FooterAction } from './actions';

/** К экрану смены: всё, что открыто поверх него, закрывается. */
export const toShift = () => router.dismissTo('/shift');

export const shiftActions: CaseActions = {
  act: examine, waitForResults, chooseDiagnosis, toggleTreatment, chooseSetting, finish: finishCase,
  sendAway: () => {
    sendAway();
    toShift();
  },
  routes: { decision: '/shift/decision', outcome: '/shift/outcome' },
};

export function shiftNext(dayOpen: boolean): FooterAction {
  return dayOpen
    ? { title: T.shift.toQueue, testID: 'shift-to-queue', run: toShift }
    : { title: T.shift.toSummary, testID: 'shift-to-summary', run: toShift };
}

export function shiftBack(): FooterAction {
  return { title: T.shift.toQueue, testID: 'shift-back', run: toShift };
}
