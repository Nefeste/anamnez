// «Испытания» (часть 91, spec 2026-10-challenges, вопрос 50): обычная «Смена» на один день — с условием, одним или
// несколькими: без расспроса, без анализов и снимков, обследования пациента до 1 500 ₽. Больница и сложность — как у
// «Смены»; у каждого испытания — его лучший итог.
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { BUDGET, type Challenge, CHALLENGES } from '@/engine/shift/challenges';
import type { Difficulty } from '@/engine/shift/types';
import { T } from '@/i18n';
import { challengeBest, singleVenues, startSingle, type VenueView } from '@/state/session';
import { Button, Card, P, Screen } from '@/ui/components';
import { DifficultyChoice } from '@/ui/difficulty';
import { Text } from '@/ui/text';
import { makeStyles, space } from '@/ui/theme';

export default function ChallengesScreen() {
  const styles = useStyles();
  const t = T.challenges;
  const [venues, setVenues] = useState<VenueView[]>([]);
  const [venue, setVenue] = useState('preset.clinic');
  const [difficulty, setDifficulty] = useState<Difficulty>('student');
  const [picked, setPicked] = useState<Challenge[]>([]);
  const [failed, setFailed] = useState(false);
  useFocusEffect(
    useCallback(() => {
      let live = true;
      singleVenues().then(v => {
        if (live) setVenues(v);
      });
      return () => {
        live = false;
      };
    }, []),
  );
  const toggle = (c: Challenge) => setPicked(picked.includes(c) ? picked.filter(x => x !== c) : [...picked, c]);
  const start = async () => {
    setFailed(false);
    const ok = await startSingle({ venue, difficulty, challenges: picked });
    if (ok) router.push('/shift');
    else setFailed(true);
  };
  return (
    <Screen footer={<Button testID="challenge-start" title={t.start} hint={picked.length === 0 ? t.pick : undefined} disabled={picked.length === 0} onPress={start} />}>
      <Card>
        <P>{t.intro}</P>
      </Card>
      <Card>
        <Text style={styles.label}>{t.list}</Text>
        {CHALLENGES.map(c => {
          const best = challengeBest(c);
          return (
            <Button key={c} testID={`challenge-${c}`} kind={picked.includes(c) ? 'primary' : 'plain'} checked={picked.includes(c)} title={t.names[c]}
              hint={best ? `${t.rule(c, T.common.rub(BUDGET))} ${t.best(best.best.overall, best.best.seen)}` : t.rule(c, T.common.rub(BUDGET))}
              onPress={() => toggle(c)} />
          );
        })}
      </Card>
      <Card>
        <Text style={styles.label}>{T.single.venues}</Text>
        {venues.map(v => (
          <Button key={v.venue} testID={`venue-${v.venue}`} kind={v.venue === venue ? 'primary' : 'plain'} disabled={!v.ok} title={v.name}
            hint={v.ok ? undefined : v.hint} onPress={() => setVenue(v.venue)} />
        ))}
      </Card>
      <Card>
        <DifficultyChoice value={difficulty} onChange={setDifficulty} />
        {failed && <P testID="challenge-failed">{T.single.cantStart}</P>}
      </Card>
    </Screen>
  );
}

const useStyles = makeStyles(t => ({
  label: { fontSize: 13, fontWeight: '700', letterSpacing: 1.2, color: t.colors.muted, textTransform: 'uppercase', marginBottom: space.xs },
}));
