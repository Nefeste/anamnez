// Действия «Разобрать случай» (spec 2026-10-study-case, часть 74) для общих экранов приёма: один больной болезни из
// статьи; после разбора — к статье или ещё один такой больной.
import { router } from 'expo-router';
import { T } from '@/i18n';
import { studyAgain, studyCondition, studyVisit } from '@/state/study';
import type { CaseActions, FooterAction } from './actions';

export const studyActions: CaseActions = {
  act: studyVisit.act,
  waitForResults: studyVisit.waitForResults,
  chooseDiagnosis: studyVisit.chooseDiagnosis,
  toggleTreatment: studyVisit.toggleTreatment,
  chooseSetting: studyVisit.chooseSetting,
  toggleHypothesis: studyVisit.toggleHypothesis,
  finish: studyVisit.finish,
  routes: { decision: '/study/decision', outcome: '/study/outcome' },
};

/** К статье, из которой начали: всё, что открыто поверх неё, закрывается. */
export function studyBack(): FooterAction {
  return {
    title: T.study.toArticle, testID: 'study-to-article',
    run: () => {
      const id = studyCondition();
      if (id) router.dismissTo({ pathname: '/encyclopedia/article/[id]', params: { id } });
      else router.dismissTo('/encyclopedia');
    },
  };
}

/** Ещё один больной той же болезни — снова карта пациента. */
export function studyNext(): FooterAction {
  return {
    title: T.study.again, testID: 'study-again',
    run: () => {
      studyAgain();
      router.dismissTo('/study/patient');
    },
  };
}
