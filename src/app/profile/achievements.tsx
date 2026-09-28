// Достижения (spec 2026-09-campaign, часть 13): по группам; у полученных — дата, у остальных —
// что нужно сделать, без счётчиков «осталось» и без упрёков.
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { T } from '@/i18n';
import { loadProfile, useProfile } from '@/state/profile';
import { achievementCount, achievementGroups } from '@/state/profileView';
import { Card, P, Screen } from '@/ui/components';
import { Text } from '@/ui/text';
import { colors, space } from '@/ui/theme';

export default function AchievementsScreen() {
  const p = useProfile();
  useEffect(() => {
    loadProfile();
  }, []);
  const t = T.profile;
  const n = achievementCount(p);
  return (
    <Screen>
      <Card>
        <P testID="achievements-count">{t.achievementsCount(n.got, n.total)}</P>
        <P muted>{t.achievementsHint}</P>
      </Card>
      {achievementGroups(p).map(g => (
        <Card key={g.key}>
          <Text style={styles.label}>{g.title}</Text>
          {g.items.map(a => (
            <View key={a.id} testID={`achievement-${a.id}`} style={styles.row}>
              <Text style={[styles.mark, a.got !== undefined && styles.markGot]}>{a.got !== undefined ? '✓' : '○'}</Text>
              <View style={styles.text}>
                <Text style={[styles.name, a.got === undefined && styles.nameMuted]}>{a.name}</Text>
                <Text style={styles.meta}>{a.got ?? a.need}</Text>
              </View>
            </View>
          ))}
        </Card>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 13, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', marginBottom: space.xs },
  row: { flexDirection: 'row', gap: space.s, alignItems: 'flex-start', paddingVertical: 4 },
  mark: { width: 20, fontSize: 16, lineHeight: 22, color: colors.muted },
  markGot: { color: colors.green, fontWeight: '700' },
  text: { flex: 1, gap: 1 },
  name: { fontSize: 15, lineHeight: 21, fontWeight: '600', color: colors.ink },
  nameMuted: { fontWeight: '400' },
  meta: { fontSize: 13, lineHeight: 18, color: colors.muted },
});
