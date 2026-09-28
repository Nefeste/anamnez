// Действия «Случая дня» для общих экранов приёма: один пациент дня; после итога — к списку дней.
import { router } from 'expo-router';
import { T } from '@/i18n';
import { dailyVisit } from '@/state/daily';
import type { CaseActions, FooterAction } from './actions';

export const dailyActions: CaseActions = {
  act: dailyVisit.act,
  waitForResults: dailyVisit.waitForResults,
  chooseDiagnosis: dailyVisit.chooseDiagnosis,
  toggleTreatment: dailyVisit.toggleTreatment,
  chooseSetting: dailyVisit.chooseSetting,
  finish: dailyVisit.finish,
  routes: { decision: '/daily/decision', outcome: '/daily/outcome' },
};

/** К списку дней: всё, что открыто поверх него, закрывается. */
export function dailyBack(): FooterAction {
  return { title: T.daily.toList, testID: 'daily-to-list', run: () => router.dismissTo('/daily') };
}
