// Раздел энциклопедии: болезни по системам органов, признаки и обследования по видам, лечение
// по группам — как в карте пациента и решении.
import { Stack, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text } from 'react-native';
import { db } from '@/content';
import { type Section, SECTIONS, sectionView } from '@/state/encyclopedia';
import { Card, Screen } from '@/ui/components';
import { EncyclopediaNote, ListRow, openArticle } from '@/ui/encyclopedia';
import { colors, space } from '@/ui/theme';

export default function SectionScreen() {
  const { section } = useLocalSearchParams<{ section: string }>();
  const s: Section = SECTIONS.find(x => x === section) ?? 'conditions';
  const v = sectionView(db, s);
  return (
    <Screen>
      <Stack.Screen options={{ title: v.title }} />
      <EncyclopediaNote />
      {v.groups.map(g => (
        <Card key={g.key}>
          <Text style={styles.label}>{g.title}</Text>
          {g.items.map(i => <ListRow key={i.id} testID={`enc-item-${i.id}`} title={i.title} onPress={() => openArticle(i.id)} />)}
        </Card>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 13, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', marginBottom: space.xs },
});
