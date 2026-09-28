// Главное меню (03-game-design.md §10; spec 2026-09-campaign): продолжить последнюю партию,
// кампания, быстрая игра (практика и песочница), энциклопедия, профиль, настройки. При первом
// запуске вместо меню — медицинская оговорка (11-publishing.md §3), потом — имя и пол врача.
// Шапки нет: сверху — обложка в виде темы (spec 2026-09-own-look, часть 25).
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
import { Cover, type MenuItem, MenuList } from '@/ui/menu';
import { DoctorForm } from '@/ui/profile';

export default function Menu() {
  const settings = useSettings();
  const profile = useProfile();
  // null — сохранения ещё не прочитаны: меню ждёт их, чтобы «Продолжить» не появлялось
  // позже остальных и не сдвигало пункты под пальцем
  const [games, setGames] = useState<GameSummary[] | null>(null);
  useEffect(() => {
    loadSettings();
    loadProfile();
  }, []);
  // сохранения — с диска, каждый раз, когда меню снова на виду
  useFocusEffect(
    useCallback(() => {
      let live = true;
      savedGames()
        .catch(() => [])
        .then(g => {
          if (live) setGames(g);
        });
      return () => {
        live = false;
      };
    }, []),
  );

  // настройки и профиль читаются доли секунды: не мелькать меню перед оговоркой
  if (settings.status !== 'ready' || profile.status !== 'ready') return <Screen bare>{null}</Screen>;
  if (!settings.disclaimerAccepted) return <Disclaimer />;
  if (!profile.doctor) return <DoctorForm bare submitTitle={T.profile.start} onSubmit={setDoctor} />;
  if (games === null) return <Screen bare>{null}</Screen>;

  const t = T.menu;
  const last = games[0];
  const open = async (g: GameSummary) => {
    await loadShift(g.mode, g.career);
    router.push('/shift');
  };
  // главная кнопка — «Продолжить», а нет сохранений — «Кампания»; остальное — пунктами под ней
  const campaign: MenuItem = { testID: 'menu-campaign', title: t.campaign, hint: T.campaign.menuHint, onPress: () => router.push('/campaign') };
  const items: MenuItem[] = [
    ...(last ? [campaign] : []),
    { testID: 'menu-quick', title: T.campaign.quick, hint: T.campaign.quickHint, onPress: () => router.push('/quick') },
    { testID: 'menu-encyclopedia', title: t.encyclopedia, hint: t.encyclopediaHint, onPress: () => router.push('/encyclopedia') },
    { testID: 'menu-profile', title: t.profile, hint: T.profile.menuHint(doctorName(profile.doctor), profile.stats.cases), onPress: () => router.push('/profile') },
    { testID: 'menu-settings', title: t.settings, onPress: () => router.push('/settings') },
  ];
  return (
    <Screen bare>
      <Cover version={VERSION} />
      {last
        ? <Button testID="menu-continue" title={t.continue} hint={continueHint(last)} onPress={() => open(last)} />
        : <Button testID={campaign.testID} title={campaign.title} hint={campaign.hint} onPress={campaign.onPress} />}
      <MenuList items={items} />
    </Screen>
  );
}

/** Что продолжим: практика — день и время; песочница — день и касса; карьера — глава и день. */
export function continueHint(g: GameSummary): string {
  if (g.mode === 'sandbox') return T.sandbox.continueHint(g.day, T.common.rub(g.cash ?? 0));
  if (g.mode === 'single') return T.single.continueHint(g.venue ?? '', g.clock);
  if (g.mode === 'campaign') {
    const ch = g.chapter ? db.chapters[g.chapter] : undefined;
    return `${T.campaign.career(g.career ?? 1)}: ${ch ? T.campaign.chapter(ch.order, ch.name.ru) : ''} · ${T.campaign.day(g.day)}`;
  }
  return T.menu.continueHint(g.day, g.clock, T.shift.difficulty[g.difficulty]);
}

function Disclaimer() {
  return (
    <Screen bare footer={<Button testID="accept-disclaimer" title={T.common.understood} onPress={() => updateSettings({ disclaimerAccepted: true })} />}>
      <Card>
        <H>{T.common.disclaimerTitle}</H>
        <P>{T.common.disclaimer}</P>
      </Card>
    </Screen>
  );
}
