// «Смена» (spec 2026-09-campaign, часть 14): один день в выбранной больнице — амбулатории
// практики, больнице главы (если глава открыта в какой-нибудь карьере) или копии своей из
// песочницы; сложность; зерно — случайное или своё. Где смену не открыть — с причиной.
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet } from 'react-native';
import type { Difficulty } from '@/engine/shift/types';
import { T } from '@/i18n';
import { singleVenues, startSingle, type VenueView } from '@/state/session';
import { Button, Card, Chip, Chips, P, Screen } from '@/ui/components';
import { DifficultyChoice } from '@/ui/difficulty';
import { Text, TextInput } from '@/ui/text';
import { colors, radius, space, touch } from '@/ui/theme';

export default function SingleScreen() {
  const t = T.single;
  const [venues, setVenues] = useState<VenueView[]>([]);
  const [venue, setVenue] = useState('preset.clinic');
  const [difficulty, setDifficulty] = useState<Difficulty>('student');
  const [own, setOwn] = useState(false);
  const [seed, setSeed] = useState('');
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
  const n = Number.parseInt(seed, 10);
  const valid = !own || (Number.isFinite(n) && n >= 0);
  const start = async () => {
    setFailed(false);
    const ok = await startSingle({ venue, difficulty, ...(own ? { seed: n } : {}) });
    if (ok) router.push('/shift');
    else setFailed(true);
  };
  return (
    <Screen footer={<Button testID="single-start" title={t.start} disabled={!valid} onPress={start} />}>
      <Card>
        <P>{t.intro}</P>
      </Card>
      <Card>
        <Text style={styles.label}>{t.venues}</Text>
        {venues.map(v => (
          <Button key={v.venue} testID={`venue-${v.venue}`} kind={v.venue === venue ? 'primary' : 'plain'} disabled={!v.ok} title={v.name} hint={v.hint}
            onPress={() => setVenue(v.venue)} />
        ))}
      </Card>
      <Card>
        <DifficultyChoice value={difficulty} onChange={setDifficulty} />
      </Card>
      <Card>
        <Text style={styles.label}>{t.seed}</Text>
        <Chips>
          <Chip testID="seed-random" text={t.seedRandom} strong={!own} onPress={() => setOwn(false)} />
          <Chip testID="seed-own" text={t.seedOwn} strong={own} onPress={() => setOwn(true)} />
        </Chips>
        {own && (
          <TextInput testID="seed-input" value={seed} onChangeText={setSeed} keyboardType="number-pad" placeholder={t.seedPlaceholder}
            placeholderTextColor={colors.muted} style={styles.input} />
        )}
        <P muted>{t.seedHint}</P>
        {failed && <P testID="single-failed">{t.cantStart}</P>}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 13, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', marginBottom: space.xs },
  input: {
    minHeight: touch, backgroundColor: colors.card, borderRadius: radius, borderWidth: 1, borderColor: colors.line, paddingHorizontal: space.l,
    fontSize: 16, color: colors.ink,
  },
});
