// «Случай дня» · решение: диагноз, затем лечение и место (общий экран src/ui/case).
import { useDaily } from '@/state/daily';
import { DecisionScreen } from '@/ui/case/DecisionScreen';
import { dailyActions } from '@/ui/case/daily';

export default function DailyDecision() {
  return <DecisionScreen view={useDaily()} actions={dailyActions} />;
}
