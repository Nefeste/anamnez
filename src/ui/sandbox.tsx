// Начало песочницы — своя больница (spec 2026-09-own-hospital): с чего начать, бюджет,
// сложность. Общее для экрана смены (песочницы ещё нет) и «Начать заново» из меню.
import { Stack } from 'expo-router';
import { useState } from 'react';
import { db } from '@/content';
import type { Difficulty } from '@/engine/shift/types';
import { T } from '@/i18n';
import type { Budget } from '@/state/session';
import { Button, Card, H, P, Screen, Tabs } from './components';
import { DifficultyChoice } from './difficulty';

export interface SandboxStart {
  start: 'empty' | 'clinic';
  budget: Budget;
  difficulty: Difficulty;
}

export function NewSandbox({ onStart }: { onStart: (opts: SandboxStart) => void }) {
  const t = T.sandbox;
  const sb = db.economy.sandbox;
  const [start, setStart] = useState<'empty' | 'clinic'>('empty');
  const [budget, setBudget] = useState<Budget>('normal');
  const [difficulty, setDifficulty] = useState<Difficulty>('student');
  const cash = start === 'clinic' ? Math.floor((sb.budgets[budget] * sb.clinicShare) / 100) : sb.budgets[budget];
  return (
    <Screen footer={<Button testID="sandbox-start" title={t.begin} onPress={() => onStart({ start, budget, difficulty })} />}>
      <Stack.Screen options={{ title: t.title }} />
      <Card>
        <H>{t.newTitle}</H>
        <P>{t.newText(sb.plot[0], sb.plot[1])}</P>
      </Card>
      <Card>
        <H>{t.startTitle}</H>
        <Tabs<'empty' | 'clinic'> testPrefix="sandbox-from" value={start} onChange={setStart} items={[{ key: 'empty', title: t.starts.empty }, { key: 'clinic', title: t.starts.clinic }]} />
        <P muted>{start === 'empty' ? t.startHints.empty : t.startHints.clinic(sb.clinicShare)}</P>
      </Card>
      <Card>
        <H>{t.budgetTitle}</H>
        <Tabs<Budget>
          testPrefix="sandbox-budget"
          value={budget}
          onChange={setBudget}
          items={(['modest', 'normal', 'generous'] as const).map(k => ({ key: k, title: t.budgets[k] }))}
        />
        <P testID="sandbox-cash">{t.cash(T.common.rub(cash))}</P>
      </Card>
      <Card>
        <DifficultyChoice value={difficulty} onChange={setDifficulty} />
      </Card>
    </Screen>
  );
}
