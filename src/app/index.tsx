// Главное меню (spec 2026-09-first-shift, «Что увидит игрок»; песочница — spec
// 2026-09-own-hospital): продолжить последнюю партию, практика в амбулатории, песочница — своя
// больница, энциклопедия, профиль, настройки; кампания — «скоро». У практики и песочницы по
// сохранению: есть оно — лист «продолжить или начать заново». При первом запуске вместо меню —
// медицинская оговорка (11-publishing.md §3), потом — имя и пол врача.
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { T } from '@/i18n';
import { VERSION } from '@/info';
import type { Difficulty, Mode } from '@/engine/shift/types';
import { loadProfile, setDoctor, useProfile } from '@/state/profile';
import { doctorName } from '@/state/profileView';
import { type GameSummary, loadShift, savedGames, startShift } from '@/state/session';
import { loadSettings, updateSettings, useSettings } from '@/state/settings';
import { Button, Card, H, P, Screen, Sheet } from '@/ui/components';
import { DifficultyChoice } from '@/ui/difficulty';
import { DoctorForm } from '@/ui/profile';

export default function Menu() {
  const settings = useSettings();
  const profile = useProfile();
  const [games, setGames] = useState<GameSummary[]>([]);
  const [sheet, setSheet] = useState<Mode>();
  const [difficulty, setDifficulty] = useState<Difficulty>('student');
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
  const sb = T.sandbox;
  const last = games[0];
  const practice = games.find(g => g.mode === 'shift');
  const sandbox = games.find(g => g.mode === 'sandbox');
  const open = async (m: Mode) => {
    setSheet(undefined);
    await loadShift(m);
    router.push('/shift');
  };
  // нет сохранения — сразу к началу; есть — лист: продолжить или заново (с той же сложностью)
  const pick = (m: Mode, g?: GameSummary) => {
    if (!g) {
      open(m);
      return;
    }
    setDifficulty(g.difficulty);
    setSheet(m);
  };
  // песочница заново — к выбору участка и бюджета; прежняя сотрётся, только когда начнут новую
  const again = async () => {
    const m = sheet;
    setSheet(undefined);
    if (m === 'sandbox') {
      router.push('/sandbox/new');
      return;
    }
    await loadShift('shift');
    startShift(undefined, undefined, difficulty);
    router.push('/shift');
  };
  const continueHint = (g: GameSummary) =>
    g.mode === 'sandbox' ? sb.continueHint(g.day, T.common.rub(g.cash ?? 0)) : t.continueHint(g.day, g.clock, T.shift.difficulty[g.difficulty]);
  return (
    <Screen>
      <P muted>{t.subtitle(VERSION)}</P>
      {last && <Button testID="menu-continue" title={t.continue} hint={continueHint(last)} onPress={() => open(last.mode)} />}
      <Button
        testID="menu-shift"
        kind={last ? 'plain' : 'primary'}
        title={t.practice}
        hint={practice ? t.practiceSavedHint(practice.day, practice.clock) : t.practiceHint}
        onPress={() => pick('shift', practice)}
      />
      <Button
        testID="menu-sandbox"
        kind="plain"
        title={sb.menu}
        hint={sandbox ? sb.menuSaved(sandbox.day, T.common.rub(sandbox.cash ?? 0)) : sb.menuHint}
        onPress={() => pick('sandbox', sandbox)}
      />
      <Button testID="menu-encyclopedia" kind="plain" title={t.encyclopedia} hint={t.encyclopediaHint} onPress={() => router.push('/encyclopedia')} />
      <Button testID="menu-campaign" kind="plain" disabled title={t.campaign} hint={t.soon} onPress={() => undefined} />
      <Button testID="menu-profile" kind="plain" title={t.profile} hint={T.profile.menuHint(doctorName(profile.doctor), profile.stats.cases)} onPress={() => router.push('/profile')} />
      <Button testID="menu-settings" kind="plain" title={t.settings} onPress={() => router.push('/settings')} />
      <Sheet visible={sheet !== undefined} onClose={() => setSheet(undefined)} closeTitle={t.cancel} testID="restart-sheet">
        <H>{sheet === 'sandbox' ? sb.restartTitle : t.restartTitle}</H>
        <Button testID="restart-continue" title={t.continue} onPress={() => sheet && open(sheet)} />
        <P>{sheet === 'sandbox' ? sb.restartText : t.restartText(practice?.day ?? 1)}</P>
        {sheet === 'shift' && <DifficultyChoice value={difficulty} onChange={setDifficulty} />}
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
