// Быстрая игра (09-game-design.md §10; spec 2026-09-campaign): практика в амбулатории, «Смена»
// в выбранной больнице, испытания — «Смена» с условием (spec 2026-10-challenges) — и песочница — своя больница; песочница —
// после главы 2 кампании (spec 2026-10-rules). «Случай
// дня» с 0.6.5 — в главном меню (вопрос 47), а с 1.1.7 — и здесь (просьба владельца 01.11.2026: в списке режимов его
// легче заметить). У практики и песочницы по сохранению: есть оно — лист «продолжить или начать заново».
import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import type { Difficulty, Mode } from '@/engine/shift/types';
import { T } from '@/i18n';
import { dailyMenuHint, useDailyStarted } from '@/state/daily';
import { useProfile } from '@/state/profile';
import { type GameSummary, loadShift, sandboxLock, savedGames, startShift } from '@/state/session';
import { Button, H, P, Screen, Sheet } from '@/ui/components';
import { DifficultyChoice } from '@/ui/difficulty';

export default function QuickGame() {
  const t = T.menu;
  const sb = T.sandbox;
  const [games, setGames] = useState<GameSummary[]>([]);
  const [sheet, setSheet] = useState<Mode>();
  const [difficulty, setDifficulty] = useState<Difficulty>('student');
  // песочница открывается после главы 2 — по достижениям профиля
  const p = useProfile();
  const begun = useDailyStarted();
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
  const locked = sandboxLock(games, p.achievements.got);
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
      <Button testID="quick-daily" kind="plain" title={T.daily.title} hint={dailyMenuHint(p.daily, new Date(), begun)} onPress={() => router.push('/daily')} />
      <Button testID="menu-single" kind="plain" title={T.single.title} hint={T.single.menuHint} onPress={() => router.push('/single')} />
      {/* испытания и сценарии (часть 91, spec 2026-10-challenges и 2026-10-scenarios): «Смена» с условием, неделя с особым потоком */}
      <Button testID="menu-challenges" kind="plain" title={T.challenges.menuTitle} hint={T.challenges.menuHint} onPress={() => router.push('/challenges')} />
      <Button
        testID="menu-sandbox"
        kind="plain"
        title={sb.menu}
        disabled={locked !== undefined}
        hint={sandbox ? sb.menuSaved(sandbox.day, T.common.rub(sandbox.cash ?? 0)) : locked ? sb.menuLocked(locked.order, locked.name) : sb.menuHint}
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
