// Смена · приём пациента в кабинете: общая карта пациента (src/ui/case) над движком смены;
// в первую смену главы кампании — подсказки наставника поверх неё.
import { usePrepareIdle, useShiftCase } from '@/state/session';
import { NoPatient } from '@/ui/case/NoPatient';
import { PatientCard } from '@/ui/case/PatientCard';
import { shiftActions } from '@/ui/case/shift';
import { MentorTip } from '@/ui/campaign';

export default function ShiftPatient() {
  const v = useShiftCase();
  // пока игрок думает — разбор этого приёма считается заранее (0.5.11, NFR-PRF-1)
  usePrepareIdle();
  if (!v) return <NoPatient />;
  return (
    <>
      <PatientCard view={v} actions={shiftActions} />
      <MentorTip screen="card" />
    </>
  );
}
