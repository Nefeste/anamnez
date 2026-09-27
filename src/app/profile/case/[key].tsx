// Приём из архива профиля: итог и разбор — тот же экран и тот же разбор, что в итогах дня
// (session.ts, archiveCaseView).
import { router, useLocalSearchParams } from 'expo-router';
import { T } from '@/i18n';
import { archiveCaseView } from '@/state/session';
import { OutcomeScreen } from '@/ui/case/OutcomeScreen';

export default function ArchiveCase() {
  const { key } = useLocalSearchParams<{ key: string }>();
  const view = archiveCaseView(String(key));
  const back = { testID: 'archive-back', title: T.profile.back, run: () => router.back() };
  return <OutcomeScreen view={view} next={back} back={back} />;
}
