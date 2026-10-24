// Сценарий «Быстрой игры» (часть 91, spec 2026-10-scenarios, вопрос 55): что за неделя, цель, где можно; больница — из
// тех, что подходят сценарию, сложность — как у «Смены»; «Начать неделю» — пять смен подряд.
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { type Scenario, SCENARIOS } from '@/engine/shift/scenarios';
import type { Difficulty } from '@/engine/shift/types';
import { T } from '@/i18n';
import { DEATHS, NEEDLESS_ANTIBIOTIC, PNEUMONIA_CAUGHT, QUEUE_LOST, WEEK_GRADE, WEEK_SEEN } from '@/state/scenario';
import { scenarioVenues, startScenario, type VenueView } from '@/state/session';
import { Button, Card, P, Screen } from '@/ui/components';
import { DifficultyChoice } from '@/ui/difficulty';
import { Text } from '@/ui/text';
import { makeStyles, space } from '@/ui/theme';

/** Цель сценария — словами, с порогами из src/state/scenario.ts. */
const goalOf = (sc: Scenario) =>
  (sc === 'flu' ? T.scenarios.goals.flu(PNEUMONIA_CAUGHT, NEEDLESS_ANTIBIOTIC) : sc === 'neighbor' ? T.scenarios.goals.neighbor(QUEUE_LOST, DEATHS) : T.scenarios.goals.xray(WEEK_GRADE));

export default function ScenarioScreen() {
  const styles = useStyles();
  const { id } = useLocalSearchParams<{ id: string }>();
  const sc: Scenario = SCENARIOS.includes(id as Scenario) ? (id as Scenario) : 'flu';
  const [venues, setVenues] = useState<VenueView[]>([]);
  const [venue, setVenue] = useState<string | undefined>(undefined);
  const [difficulty, setDifficulty] = useState<Difficulty>('student');
  const [failed, setFailed] = useState(false);
  useFocusEffect(
    useCallback(() => {
      let live = true;
      scenarioVenues(sc).then(v => {
        if (!live) return;
        setVenues(v);
        // первая подходящая — выбрана сразу
        setVenue(cur => (cur && v.some(x => x.venue === cur && x.ok) ? cur : v.find(x => x.ok)?.venue));
      });
      return () => {
        live = false;
      };
    }, [sc]),
  );
  const start = async () => {
    if (!venue) return;
    setFailed(false);
    const ok = await startScenario({ scenario: sc, venue, difficulty });
    if (ok) router.push('/shift');
    else setFailed(true);
  };
  return (
    <Screen footer={<Button testID="scenario-start" title={T.scenarios.start} disabled={!venue} onPress={start} />}>
      <Stack.Screen options={{ title: T.scenarios.names[sc] }} />
      <Card testID="scenario-about">
        <P>{T.scenarios.rules[sc]}</P>
        <P testID="scenario-goal">{goalOf(sc)}</P>
        <P muted>{T.scenarios.seenGoal(WEEK_SEEN)}</P>
        <P muted>{T.scenarios.where[sc]}</P>
      </Card>
      <Card>
        <Text style={styles.label}>{T.single.venues}</Text>
        {venues.map(v => (
          <Button key={v.venue} testID={`venue-${v.venue}`} kind={v.venue === venue ? 'primary' : 'plain'} disabled={!v.ok} title={v.name}
            hint={v.hint || undefined} onPress={() => setVenue(v.venue)} />
        ))}
      </Card>
      <Card>
        <DifficultyChoice value={difficulty} onChange={setDifficulty} />
        {failed && <P testID="scenario-failed">{T.single.cantStart}</P>}
      </Card>
    </Screen>
  );
}

const useStyles = makeStyles(t => ({
  label: { fontSize: 13, fontWeight: '700', letterSpacing: 1.2, color: t.colors.muted, textTransform: 'uppercase', marginBottom: space.xs },
}));
