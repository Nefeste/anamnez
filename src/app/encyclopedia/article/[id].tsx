// Статья энциклопедии (05-content.md §4): разделы из записи базы, ссылки на другие статьи —
// плашками. Открывается и из «Что это?» в карте пациента, и из разбора случая.
import { Stack, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { db } from '@/content';
import { T } from '@/i18n';
import { article } from '@/state/encyclopedia';
import { Card, Chips, P, Screen } from '@/ui/components';
import { EncyclopediaNote, RefChip } from '@/ui/encyclopedia';
import { colors, space } from '@/ui/theme';

export default function ArticleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = T.encyclopedia;
  const a = article(db, String(id));
  if (!a) {
    return (
      <Screen>
        <EncyclopediaNote />
        <Card>
          <P muted>{t.nothing}</P>
        </Card>
      </Screen>
    );
  }
  return (
    <Screen resetKey={a.id}>
      <Stack.Screen options={{ title: t.sections[a.section] }} />
      <EncyclopediaNote />
      <Card>
        <Text testID="enc-article-title" style={styles.title}>{a.title}</Text>
        {a.subtitle ? <P muted>{a.subtitle}</P> : null}
      </Card>
      {a.blocks.map(b => (
        <Card key={b.key}>
          <Text testID={`enc-block-${b.key}`} style={styles.label}>{b.title}</Text>
          {b.text?.map((line, i) => <P key={i}>{line}</P>)}
          {b.rows?.map(r => (
            <View key={r.label} style={styles.row}>
              <Text style={styles.rowLabel}>{r.label}</Text>
              <Chips>{r.refs.map(x => <RefChip key={x.id} r={x} />)}</Chips>
            </View>
          ))}
          {b.refs ? <Chips>{b.refs.map(x => <RefChip key={x.id} r={x} />)}</Chips> : null}
          {b.note ? <P muted>{b.note}</P> : null}
        </Card>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '700', color: colors.ink },
  label: { fontSize: 13, fontWeight: '700', color: colors.muted, textTransform: 'uppercase' },
  row: { gap: space.xs, marginTop: space.xs },
  rowLabel: { fontSize: 14, fontWeight: '600', color: colors.ink },
});
