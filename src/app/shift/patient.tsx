// Смена · приём пациента в кабинете: общая карта пациента (src/ui/case) над движком смены.
import { useShiftCase } from '@/state/session';
import { NoPatient } from '@/ui/case/NoPatient';
import { PatientCard } from '@/ui/case/PatientCard';
import { shiftActions } from '@/ui/case/shift';

export default function ShiftPatient() {
  const v = useShiftCase();
  if (!v) return <NoPatient />;
  return <PatientCard view={v} actions={shiftActions} />;
}
