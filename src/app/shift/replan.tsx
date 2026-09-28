// Смена · сменить лечение лежащего (spec 2026-09-chapter-2, часть 26): то же лечение по группам,
// что на экране решения, с предупреждениями о том, что о пациенте известно; «Готово» — болезнь
// идёт дальше с новым планом с этих суток.
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { T } from '@/i18n';
import { replanChoices, replanPatient, useRounds } from '@/state/session';
import { Button, Card, H, P, Screen } from '@/ui/components';

export default function Replan() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const card = useRounds().find(c => c.id === id);
  const [chosen, setChosen] = useState<string[]>(card?.treatmentIds ?? []);
  const t = T.shift.ward;
  if (!card) {
    return (
      <Screen>
        <Card>
          <P>{t.empty}</P>
        </Card>
      </Screen>
    );
  }
  const toggle = (tx: string) => setChosen(c => (c.includes(tx) ? c.filter(x => x !== tx) : [...c, tx].sort()));
  const done = () => {
    replanPatient(card.id, chosen);
    router.back();
  };
  return (
    <Screen footer={<Button testID="replan-done" title={t.replanDone} onPress={done} />}>
      <Card>
        <H>{card.title}</H>
        <P>{card.diagnosis}</P>
      </Card>
      {replanChoices(card.id).map(g => (
        <Card key={g.key}>
          <H>{g.title}</H>
          {g.items.map(x => (
            <Button key={x.id} testID={`replan-${x.id}`} kind={chosen.includes(x.id) ? 'primary' : 'plain'} title={x.name} hint={x.warning} onPress={() => toggle(x.id)} />
          ))}
        </Card>
      ))}
    </Screen>
  );
}
