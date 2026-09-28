// Быстрая игра (03-game-design.md §10; spec 2026-09-campaign): практика в амбулатории, «Смена»
// в выбранной больнице, «Случай дня» и песочница — своя больница. У практики и песочницы по
// сохранению: есть оно — лист «продолжить или начать заново».
import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import type { Difficulty, Mode } from '@/engine/shift/types';
import { T } from '@/i18n';
import { dailyMenuHint } from '@/state/daily';
import { useProfile } from '@/state/profile';
import { type GameSummary, loadShift, savedGames, startShift } from '@/state/session';
import { Button, H, P, Screen, Sheet } from '@/ui/components';
import { DifficultyChoice } from '@/ui/difficulty';

export default function QuickGame() {
  const t = T.menu;
  const sb = T.sandbox;
  const [games, setGames] = useState<GameSummary[]>([]);
  const [sheet, setSheet] = useState<Mode>();
  const [difficulty, setDifficulty] = useState<Difficulty>('student');
  // подпись «Случая дня» — из профиля: сегодняшний сыгран — с оценкой
  const p = useProfile();
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
  return (
    <Screen>
      <Stack.Screen options={{ title: T.campaign.quick }} />
      <Button
        testID="menu-shift"
        title={t.practice}
        hint={practice ? t.practiceSavedHint(practice.day, practice.clock) : t.practiceHint}
        onPress={() => pick('shift', practice)}
      />
      <Button testID="menu-single" kind="plain" title={T.single.title} hint={T.single.menuHint} onPress={() => router.push('/single')} />
      <Button testID="menu-daily" kind="plain" title={T.daily.title} hint={dailyMenuHint(p.daily)} onPress={() => router.push('/daily')} />
      <Button
        testID="menu-sandbox"
        kind="plain"
        title={sb.menu}
        hint={sandbox ? sb.menuSaved(sandbox.day, T.common.rub(sandbox.cash ?? 0)) : sb.menuHint}
        onPress={() => pick('sandbox', sandbox)}
      />
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
