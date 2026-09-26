// П4 · Итог приёма и разбор (общий экран src/ui/case). «Следующий пациент» — внизу.
import { useVisit } from '@/state/visit';
import { OutcomeScreen } from '@/ui/case/OutcomeScreen';
import { visitBack, visitNext } from '@/ui/case/visit';

export default function Outcome() {
  return <OutcomeScreen view={useVisit()} next={visitNext()} back={visitBack()} />;
}
