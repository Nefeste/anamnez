// «Случай дня» (spec 2026-09-campaign, часть 14): последние 30 дней, сегодня первым. У
// сыгранных — оценка первой попытки, остальные можно сыграть когда угодно; серии нет.
import { router } from 'expo-router';
import { useEffect } from 'react';
import { db } from '@/content';
import { T } from '@/i18n';
import { dailyRows, openDaily } from '@/state/daily';
import { loadProfile, useProfile } from '@/state/profile';
import { Button, Card, P, Screen } from '@/ui/components';

export default function DailyScreen() {
  // список — из профиля: сыгранный день отмечается, как только закрыт приём
  const p = useProfile();
  useEffect(() => {
    loadProfile();
  }, []);
  const t = T.daily;
  const open = (day: string) => {
    openDaily(day);
    router.push('/daily/patient');
  };
  return (
    <Screen>
      <Card>
        <P>{t.intro}</P>
        <P muted testID="daily-base">{t.base(db.contentVersion)}</P>
      </Card>
      <Card>
        {dailyRows(p.daily).map((r, i) => (
          <Button key={r.day} testID={`daily-${r.day}`} kind={i === 0 && !r.played ? 'primary' : 'plain'} title={r.title} hint={r.hint} onPress={() => open(r.day)} />
        ))}
      </Card>
    </Screen>
  );
}
