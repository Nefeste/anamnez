// «Разобрать случай» · приём: общая карта пациента (src/ui/case) над больным болезни из статьи (часть 74).
import { useStudy } from '@/state/study';
import { PatientCard } from '@/ui/case/PatientCard';
import { studyActions } from '@/ui/case/study';

export default function StudyPatient() {
  return <PatientCard view={useStudy()} actions={studyActions} />;
}
