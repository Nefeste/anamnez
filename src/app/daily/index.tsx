// «Случай дня» (spec 2026-09-campaign, часть 14): последние 30 дней, сегодня первым. У
// сыгранных — оценка первой попытки, остальные можно сыграть когда угодно; серии нет.
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { db } from '@/content';
import { T } from '@/i18n';
import { dailyDays, dailyPicked, dailyRows, openDaily, pickDaily, prepareDailyEvery, useDailyStarted } from '@/state/daily';
import { loadProfile, useProfile } from '@/state/profile';
import { Button, Card, P, Screen } from '@/ui/components';

/** Открыть приём дня. */
function go(day: string) {
  openDaily(day);
  router.push('/daily/patient');
}

export default function DailyScreen() {
  // список — из профиля: сыгранный день отмечается, как только закрыт приём
  const p = useProfile();
  // начатые приёмы: «Назад» с приёма — и строка дня говорит, что он начат
  const begun = useDailyStarted();
  // трудный случай дня (часть 92) подбирается заранее, пока список на экране: сегодняшний, затем прошлые дни по порядку
  useFocusEffect(useCallback(() => prepareDailyEvery(() => dailyDays(new Date())), []));
  // день, чей случай не успели подобрать: касание не ждёт — строка говорит «Подбираю случай…», приём откроется сам
  const [picking, setPicking] = useState<string>();
  useEffect(() => {
    loadProfile();
  }, []);
  useEffect(() => {
    if (!picking) return;
    return pickDaily(picking, () => {
      setPicking(undefined);
      go(picking);
    });
  }, [picking]);
  const t = T.daily;
  const open = (day: string) => (dailyPicked(day) ? go(day) : setPicking(day));
  return (
    <Screen>
      <Card>
        <P>{t.intro}</P>
        <P muted testID="daily-base">{t.base(db.contentVersion)}</P>
      </Card>
      <Card>
        {dailyRows(p.daily, new Date(), begun).map((r, i) => (
          <Button key={r.day} testID={`daily-${r.day}`} kind={i === 0 && !r.played ? 'primary' : 'plain'} title={r.title} hint={picking === r.day ? t.picking : r.hint} onPress={() => open(r.day)} />
        ))}
      </Card>
    </Screen>
  );
}
