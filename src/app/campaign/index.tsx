// Кампания (spec 2026-09-campaign): три карьеры, у каждой своё сохранение. Пустая — «Новая
// карьера» со сложностью; занятая — глава, день и задания; касание — «Продолжить» или «Начать
// заново» с подтверждением.
import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { db } from '@/content';
import type { Difficulty } from '@/engine/shift/types';
import { T } from '@/i18n';
import { CAREERS, type GameSummary, loadShift, savedGames, startCampaign } from '@/state/session';
import { updateSettings, useSettings } from '@/state/settings';
import { Button, Card, H, P, Screen, Sheet, Toggle } from '@/ui/components';
import { DifficultyChoice } from '@/ui/difficulty';

type Pick = { career: number; saved?: GameSummary; confirm?: boolean; fresh?: boolean };

export default function CampaignScreen() {
  const t = T.campaign;
  const [games, setGames] = useState<GameSummary[]>([]);
  const [pick, setPick] = useState<Pick>();
  const [difficulty, setDifficulty] = useState<Difficulty>('student');
  const settings = useSettings();
  useFocusEffect(
    useCallback(() => {
      let live = true;
      savedGames().then(g => {
        if (live) setGames(g.filter(x => x.mode === 'campaign'));
      });
      return () => {
        live = false;
      };
    }, []),
  );
  const saved = (career: number) => games.find(g => g.career === career);
  const line = (g: GameSummary) => {
    const ch = g.chapter ? db.chapters[g.chapter] : undefined;
    return t.careerLine(ch ? t.chapter(ch.order, ch.name.ru) : '', Math.max(0, g.day), g.mains?.done ?? 0, g.mains?.of ?? 0);
  };
  const choose = (career: number) => {
    const g = saved(career);
    if (g) setDifficulty(g.difficulty);
    setPick(g ? { career, saved: g } : { career, fresh: true });
  };
  const open = async (career: number) => {
    setPick(undefined);
    await loadShift('campaign', career);
    router.push('/shift');
  };
  const begin = (career: number) => {
    setPick(undefined);
    startCampaign({ career, difficulty });
    router.push('/shift');
  };
  return (
    <Screen>
      <Stack.Screen options={{ title: t.title }} />
      <Card>
        <H>{t.careers}</H>
        <P muted>{t.careersHint}</P>
        {CAREERS.map(c => {
          const g = saved(c);
          return (
            <Button key={c} testID={`career-${c}`} kind="plain" title={g ? t.career(c) : `${t.career(c)} — ${t.newCareer.toLowerCase()}`} hint={g ? line(g) : t.newCareerHint} onPress={() => choose(c)} />
          );
        })}
      </Card>
      <Sheet visible={!!pick} onClose={() => setPick(undefined)} closeTitle={t.cancel} testID="career-sheet">
        {pick?.saved && !pick.confirm && !pick.fresh && (
          <>
            <H>{t.career(pick.career)}</H>
            <P muted>{line(pick.saved)}</P>
            <Button testID="career-continue" title={t.continue} onPress={() => open(pick.career)} />
            <Button testID="career-restart" kind="plain" title={t.restart} onPress={() => setPick({ ...pick, confirm: true })} />
          </>
        )}
        {pick?.confirm && !pick.fresh && (
          <>
            <H>{t.restartTitle(pick.career)}</H>
            <P>{t.restartText}</P>
            <Button testID="career-restart-yes" title={t.restart} onPress={() => setPick({ career: pick.career, fresh: true })} />
          </>
        )}
        {pick?.fresh && (
          <>
            <H>{t.newTitle}</H>
            <P>{t.newText}</P>
            <DifficultyChoice value={difficulty} onChange={setDifficulty} />
            {/* «мягкий режим» — при начале карьеры и в настройках (часть 28б): это одна настройка */}
            <Toggle testID="career-soft" title={T.settings.softMode} hint={T.settings.softModeHint} value={settings.softMode} onChange={v => updateSettings({ softMode: v })} />
            <Button testID="career-begin" title={t.begin} onPress={() => begin(pick.career)} />
          </>
        )}
      </Sheet>
    </Screen>
  );
}
