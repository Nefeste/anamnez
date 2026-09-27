// Общее для экранов энциклопедии: оговорка одной строкой вверху раздела (11-publishing.md §3),
// переход к статье, ссылка-плашка и строка списка.
import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from './text';
import type { Id } from '@/content/types';
import { T } from '@/i18n';
import type { Ref } from '@/state/encyclopedia';
import { Chip } from './components';
import { colors, space, touch } from './theme';

/** Статья поверх текущего экрана: «назад» возвращает туда, откуда пришли, — в карту пациента тоже. */
export function openArticle(id: Id) {
  router.push({ pathname: '/encyclopedia/article/[id]', params: { id } });
}

export function EncyclopediaNote() {
  return <Text testID="enc-disclaimer" style={styles.note}>{T.encyclopedia.disclaimer}</Text>;
}

export function RefChip({ r }: { r: Ref }) {
  return <Chip testID={`enc-link-${r.id}`} text={r.note ? `${r.title} · ${r.note}` : r.title} strong onPress={() => openArticle(r.id)} />;
}

export function ListRow({ title, hint, onPress, testID }: { title: string; hint?: string; onPress: () => void; testID?: string }) {
  return (
    <Pressable testID={testID} accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <View style={styles.fill}>
        <Text style={styles.rowTitle}>{title}</Text>
        {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  note: { fontSize: 13, lineHeight: 18, color: colors.muted },
  row: { minHeight: touch, flexDirection: 'row', alignItems: 'center', gap: space.s, paddingVertical: space.s, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  pressed: { opacity: 0.6 },
  fill: { flex: 1 },
  rowTitle: { fontSize: 16, color: colors.ink },
  rowHint: { fontSize: 13, color: colors.muted, marginTop: 2 },
  chevron: { fontSize: 22, color: colors.muted },
});
