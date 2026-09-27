// Главное меню (spec 2026-09-first-shift, «Что увидит игрок»): продолжить, быстрая игра —
// практика в амбулатории, энциклопедия, профиль, настройки; кампания — «скоро».
// При первом запуске вместо меню — медицинская оговорка (11-publishing.md §3): закрыл — она
// больше не показывается, полный текст остаётся в «Об игре». Потом — имя и пол врача.
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { T } from '@/i18n';
import { VERSION } from '@/info';
import { loadProfile, setDoctor, useProfile } from '@/state/profile';
import { doctorName } from '@/state/profileView';
import { loadShift, startShift, useShift } from '@/state/session';
import { loadSettings, updateSettings, useSettings } from '@/state/settings';
import { Button, Card, H, P, Screen, Sheet } from '@/ui/components';
import { DoctorForm } from '@/ui/profile';

export default function Menu() {
  const settings = useSettings();
  const profile = useProfile();
  const shift = useShift();
  const [restart, setRestart] = useState(false);
  useEffect(() => {
    loadSettings();
    loadProfile();
    loadShift();
  }, []);

  // настройки и профиль читаются доли секунды: не мелькать меню перед оговоркой
  if (settings.status !== 'ready' || profile.status !== 'ready') return <Screen>{null}</Screen>;
  if (!settings.disclaimerAccepted) return <Disclaimer />;
  if (!profile.doctor) return <DoctorForm submitTitle={T.profile.start} onSubmit={setDoctor} />;

  const t = T.menu;
  const saved = shift.status === 'ready';
  const again = () => {
    setRestart(false);
    startShift();
    router.push('/shift');
  };
  return (
    <Screen>
      <P muted>{t.subtitle(VERSION)}</P>
      {saved && <Button testID="menu-continue" title={t.continue} hint={t.continueHint(shift.day, shift.clock)} onPress={() => router.push('/shift')} />}
      <Button
        testID="menu-shift"
        kind={saved ? 'plain' : 'primary'}
        title={t.practice}
        hint={saved ? t.practiceAgainHint : t.practiceHint}
        onPress={() => (saved ? setRestart(true) : router.push('/shift'))}
      />
      <Button testID="menu-encyclopedia" kind="plain" title={t.encyclopedia} hint={t.encyclopediaHint} onPress={() => router.push('/encyclopedia')} />
      <Button testID="menu-campaign" kind="plain" disabled title={t.campaign} hint={t.soon} onPress={() => undefined} />
      <Button testID="menu-profile" kind="plain" title={t.profile} hint={T.profile.menuHint(doctorName(profile.doctor), profile.stats.cases)} onPress={() => router.push('/profile')} />
      <Button testID="menu-settings" kind="plain" title={t.settings} onPress={() => router.push('/settings')} />
      <Sheet visible={restart} onClose={() => setRestart(false)} closeTitle={t.cancel} testID="restart-sheet">
        <H>{t.restartTitle}</H>
        <P>{t.restartText(shift.day)}</P>
        <Button testID="restart-confirm" kind="plain" title={t.restart} onPress={again} />
      </Sheet>
    </Screen>
  );
}

function Disclaimer() {
  return (
    <Screen footer={<Button testID="accept-disclaimer" title={T.common.understood} onPress={() => updateSettings({ disclaimerAccepted: true })} />}>
      <Card>
        <H>{T.common.disclaimerTitle}</H>
        <P>{T.common.disclaimer}</P>
      </Card>
    </Screen>
  );
}
