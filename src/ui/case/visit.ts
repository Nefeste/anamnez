// Действия прототипа П4 для общих экранов приёма: один пациент, «Следующий пациент».
import { router } from 'expo-router';
import { T } from '@/i18n';
import { act, chooseDiagnosis, chooseSetting, finish, nextPatient, toggleTreatment, waitForResults } from '@/state/visit';
import type { CaseActions, FooterAction } from './actions';

export const visitActions: CaseActions = {
  act, waitForResults, chooseDiagnosis, toggleTreatment, chooseSetting, finish,
  routes: { decision: '/spikes/decision', outcome: '/spikes/outcome' },
};

// к приёму: экран итога открывают поверх него, поэтому «назад»; прямой адрес — заменой
const toVisit = () => (router.canGoBack() ? router.back() : router.replace('/spikes/patient'));

export function visitNext(): FooterAction {
  return {
    title: T.spikes.patient.next,
    testID: 'visit-next',
    run: () => {
      nextPatient();
      toVisit();
    },
  };
}

export function visitBack(): FooterAction {
  return { title: T.spikes.decision.backToVisit, testID: 'outcome-back', run: toVisit };
}
