// Смена · итог приёма и разбор: только что закрытый случай или выбранный в итогах дня; в первую
// смену главы — подсказка наставника.
import { useShift, useShiftCase } from '@/state/session';
import { OutcomeScreen } from '@/ui/case/OutcomeScreen';
import { shiftBack, shiftNext } from '@/ui/case/shift';
import { MentorTip } from '@/ui/campaign';

export default function ShiftOutcome() {
  const v = useShiftCase();
  const shift = useShift();
  return (
    <>
      <OutcomeScreen view={v} next={shiftNext(shift.dayOpen)} back={shiftBack()} />
      <MentorTip screen="review" />
    </>
  );
}
