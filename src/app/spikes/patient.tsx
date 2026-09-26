// П4 · Карта пациента: приём одного пациента, время идёт делами (ADR 0005). Экраны приёма —
// общие со сменой (src/ui/case); решение — decision.tsx, итог и разбор — outcome.tsx.
import { useVisit } from '@/state/visit';
import { PatientCard } from '@/ui/case/PatientCard';
import { visitActions } from '@/ui/case/visit';

export default function PatientSpike() {
  return <PatientCard view={useVisit()} actions={visitActions} />;
}
