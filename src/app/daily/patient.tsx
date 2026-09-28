// «Случай дня» · приём: общая карта пациента (src/ui/case) над приёмом одного пациента.
import { useDaily } from '@/state/daily';
import { PatientCard } from '@/ui/case/PatientCard';
import { dailyActions } from '@/ui/case/daily';

export default function DailyPatient() {
  return <PatientCard view={useDaily()} actions={dailyActions} />;
}
