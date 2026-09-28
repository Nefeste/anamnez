// Раздел энциклопедии: болезни по системам органов, признаки и обследования по видам, лечение
// по группам — как в карте пациента и решении. У болезней — сколько раз встречались в
// практике игрока (профиль).
import { Stack, useLocalSearchParams } from 'expo-router';
import { Text } from '@/ui/text';
import { db } from '@/content';
import { T } from '@/i18n';
import { type Section, SECTIONS, sectionView } from '@/state/encyclopedia';
import { useProfile } from '@/state/profile';
import { seenCount } from '@/state/profileView';
import { Card, P, Screen } from '@/ui/components';
import { EncyclopediaNote, ListRow, openArticle } from '@/ui/encyclopedia';
import { makeStyles, space } from '@/ui/theme';

export default function SectionScreen() {
  const styles = useStyles();
  const { section } = useLocalSearchParams<{ section: string }>();
  const s: Section = SECTIONS.find(x => x === section) ?? 'conditions';
  const v = sectionView(db, s);
  const profile = useProfile();
  const practice = s === 'conditions' ? profile.seen : undefined;
  const count = seenCount(profile);
  return (
    <Screen>
      <Stack.Screen options={{ title: v.title }} />
      <EncyclopediaNote />
      {practice && count.seen > 0 ? <P muted testID="enc-practice-count">{T.profile.practiceCount(count.seen, count.total)}</P> : null}
      {v.groups.map(g => (
        <Card key={g.key}>
          <Text style={styles.label}>{g.title}</Text>
          {g.items.map(i => (
            <ListRow
              key={i.id}
              testID={`enc-item-${i.id}`}
              title={i.title}
              hint={practice?.[i.id] ? T.profile.practiceShort(practice[i.id]) : undefined}
              onPress={() => openArticle(i.id)}
            />
          ))}
        </Card>
      ))}
    </Screen>
  );
}

const useStyles = makeStyles(t => ({
  label: { fontSize: 13, fontWeight: '700', letterSpacing: 1.2, color: t.colors.muted, textTransform: 'uppercase', marginBottom: space.xs },
}));
