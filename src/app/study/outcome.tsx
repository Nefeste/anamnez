// «Разобрать случай» · итог и разбор (общий экран src/ui/case); внизу — к статье, под разбором — ещё один такой больной.
import { useStudy } from '@/state/study';
import { OutcomeScreen } from '@/ui/case/OutcomeScreen';
import { studyBack, studyNext } from '@/ui/case/study';

export default function StudyOutcome() {
  return <OutcomeScreen view={useStudy()} next={studyBack()} back={studyBack()} more={studyNext()} />;
}
