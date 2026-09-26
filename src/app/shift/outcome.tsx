// Смена · итог приёма и разбор: только что закрытый случай или выбранный в итогах дня.
import { useShift, useShiftCase } from '@/state/session';
import { OutcomeScreen } from '@/ui/case/OutcomeScreen';
import { shiftBack, shiftNext } from '@/ui/case/shift';

export default function ShiftOutcome() {
  const v = useShiftCase();
  const shift = useShift();
  return <OutcomeScreen view={v} next={shiftNext(shift.dayOpen)} back={shiftBack()} />;
}
