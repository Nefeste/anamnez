// Главное меню (03-game-design.md §10; spec 2026-09-campaign): продолжить последнюю партию,
// кампания, быстрая игра (практика и песочница), энциклопедия, профиль, настройки. При первом
// запуске вместо меню — медицинская оговорка (11-publishing.md §3), потом — имя и пол врача.
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { db } from '@/content';
import { T } from '@/i18n';
import { VERSION } from '@/info';
import { loadProfile, setDoctor, useProfile } from '@/state/profile';
import { doctorName } from '@/state/profileView';
import { type GameSummary, loadShift, savedGames } from '@/state/session';
import { loadSettings, updateSettings, useSettings } from '@/state/settings';
import { Button, Card, H, P, Screen } from '@/ui/components';
import { DoctorForm } from '@/ui/profile';

export default function Menu() {
  const settings = useSettings();
  const profile = useProfile();
  const [games, setGames] = useState<GameSummary[]>([]);
  useEffect(() => {
    loadSettings();
    loadProfile();
  }, []);
  // сохранения — с диска, каждый раз, когда меню снова на виду
  useFocusEffect(
    useCallback(() => {
      let live = true;
      savedGames().then(g => {
        if (live) setGames(g);
      });
      return () => {
        live = false;
      };
    }, []),
  );

  // настройки и профиль читаются доли секунды: не мелькать меню перед оговоркой
  if (settings.status !== 'ready' || profile.status !== 'ready') return <Screen>{null}</Screen>;
  if (!settings.disclaimerAccepted) return <Disclaimer />;
  if (!profile.doctor) return <DoctorForm submitTitle={T.profile.start} onSubmit={setDoctor} />;

  const t = T.menu;
  const last = games[0];
  const open = async (g: GameSummary) => {
    await loadShift(g.mode, g.career);
    router.push('/shift');
  };
  return (
    <Screen>
      <P muted>{t.subtitle(VERSION)}</P>
      {last && <Button testID="menu-continue" title={t.continue} hint={continueHint(last)} onPress={() => open(last)} />}
      <Button testID="menu-campaign" kind={last ? 'plain' : 'primary'} title={t.campaign} hint={T.campaign.menuHint} onPress={() => router.push('/campaign')} />
      <Button testID="menu-quick" kind="plain" title={T.campaign.quick} hint={T.campaign.quickHint} onPress={() => router.push('/quick')} />
      <Button testID="menu-encyclopedia" kind="plain" title={t.encyclopedia} hint={t.encyclopediaHint} onPress={() => router.push('/encyclopedia')} />
      <Button testID="menu-profile" kind="plain" title={t.profile} hint={T.profile.menuHint(doctorName(profile.doctor), profile.stats.cases)} onPress={() => router.push('/profile')} />
      <Button testID="menu-settings" kind="plain" title={t.settings} onPress={() => router.push('/settings')} />
    </Screen>
  );
}

/** Что продолжим: практика — день и время; песочница — день и касса; карьера — глава и день. */
export function continueHint(g: GameSummary): string {
  if (g.mode === 'sandbox') return T.sandbox.continueHint(g.day, T.common.rub(g.cash ?? 0));
  if (g.mode === 'campaign') {
    const ch = g.chapter ? db.chapters[g.chapter] : undefined;
    return `${T.campaign.career(g.career ?? 1)}: ${ch ? T.campaign.chapter(ch.order, ch.name.ru) : ''} · ${T.campaign.day(g.day)}`;
  }
  return T.menu.continueHint(g.day, g.clock, T.shift.difficulty[g.difficulty]);
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
