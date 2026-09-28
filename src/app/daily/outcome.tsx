// «Случай дня» · итог и разбор (общий экран src/ui/case); внизу — к списку дней.
import { useDaily } from '@/state/daily';
import { OutcomeScreen } from '@/ui/case/OutcomeScreen';
import { dailyBack } from '@/ui/case/daily';

export default function DailyOutcome() {
  return <OutcomeScreen view={useDaily()} next={dailyBack()} back={dailyBack()} />;
}
