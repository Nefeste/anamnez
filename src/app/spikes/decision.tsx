// П4 · Решение по пациенту: диагноз, затем лечение и место (общий экран src/ui/case).
import { useVisit } from '@/state/visit';
import { DecisionScreen } from '@/ui/case/DecisionScreen';
import { visitActions } from '@/ui/case/visit';

export default function Decision() {
  return <DecisionScreen view={useVisit()} actions={visitActions} />;
}
