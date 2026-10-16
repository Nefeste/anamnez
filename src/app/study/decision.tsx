// «Разобрать случай» · решение: диагноз, затем лечение и место — что есть в этой больнице (общий экран src/ui/case).
import { useStudy } from '@/state/study';
import { DecisionScreen } from '@/ui/case/DecisionScreen';
import { studyActions } from '@/ui/case/study';

export default function StudyDecision() {
  return <DecisionScreen view={useStudy()} actions={studyActions} />;
}
