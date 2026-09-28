// Смена · решение по пациенту в кабинете (общий экран src/ui/case); в первую смену главы —
// подсказка наставника.
import { useShiftCase } from '@/state/session';
import { DecisionScreen } from '@/ui/case/DecisionScreen';
import { NoPatient } from '@/ui/case/NoPatient';
import { shiftActions } from '@/ui/case/shift';
import { MentorTip } from '@/ui/campaign';

export default function ShiftDecision() {
  const v = useShiftCase();
  if (!v) return <NoPatient />;
  return (
    <>
      <DecisionScreen view={v} actions={shiftActions} />
      <MentorTip screen="decision" />
    </>
  );
}
