// Смена · решение по пациенту в кабинете (общий экран src/ui/case); в первую смену главы —
// подсказка наставника.
import { usePrepareIdle, useShiftCase } from '@/state/session';
import { DecisionScreen } from '@/ui/case/DecisionScreen';
import { NoPatient } from '@/ui/case/NoPatient';
import { shiftActions } from '@/ui/case/shift';
import { MentorTip } from '@/ui/campaign';

export default function ShiftDecision() {
  const v = useShiftCase();
  // пока игрок думает — разбор этого приёма считается заранее (0.5.11, NFR-PRF-1)
  usePrepareIdle();
  if (!v) return <NoPatient />;
  return (
    <>
      <DecisionScreen view={v} actions={shiftActions} />
      <MentorTip screen="decision" />
    </>
  );
}
