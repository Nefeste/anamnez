// Действия «Случая дня» для общих экранов приёма: один пациент дня; после итога — к списку дней.
import { router } from 'expo-router';
import { T } from '@/i18n';
import { dailyPlay } from '@/state/daily';
import type { CaseActions, FooterAction } from './actions';

// шаги записываются: «Назад» с приёма и снова в тот же день — то же место (0.6.3)
export const dailyActions: CaseActions = {
  ...dailyPlay,
  routes: { decision: '/daily/decision', outcome: '/daily/outcome' },
};

/** К списку дней: всё, что открыто поверх него, закрывается. */
export function dailyBack(): FooterAction {
  return { title: T.daily.toList, testID: 'daily-to-list', run: () => router.dismissTo('/daily') };
}
