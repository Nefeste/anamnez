// Общие элементы интерфейса. Без системного Alert: в веб-сборке он не работает (AGENTS.md).
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, radius, space, touch } from './theme';

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  return (
    <SafeAreaView style={styles.screen} edges={['bottom', 'left', 'right']}>
      {scroll ? <ScrollView contentContainerStyle={styles.content}>{children}</ScrollView> : <View style={styles.fill}>{children}</View>}
    </SafeAreaView>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function H({ children }: { children: ReactNode }) {
  return <Text style={styles.h}>{children}</Text>;
}

export function P({ children, muted, testID }: { children: ReactNode; muted?: boolean; testID?: string }) {
  return <Text testID={testID} style={[styles.p, muted && styles.muted]}>{children}</Text>;
}

export function Button({ title, onPress, hint, kind = 'primary', disabled, testID }: {
  title: string; onPress: () => void; hint?: string; kind?: 'primary' | 'plain'; disabled?: boolean; testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.btn, kind === 'plain' && styles.btnPlain, disabled && styles.btnDisabled, pressed && styles.btnPressed]}>
      <Text style={[styles.btnText, kind === 'plain' && styles.btnTextPlain]}>{title}</Text>
      {hint ? <Text style={[styles.btnHint, kind === 'plain' && styles.muted]}>{hint}</Text> : null}
    </Pressable>
  );
}

/** Вкладки одной полосой: подписи в одну строку даже на узком экране. */
export function Tabs<K extends string>({ items, value, onChange }: { items: { key: K; title: string }[]; value: K; onChange: (k: K) => void }) {
  return (
    <View style={styles.tabs} accessibilityRole="tablist">
      {items.map(({ key, title }) => {
        const on = key === value;
        return (
          <Pressable
            key={key}
            testID={`tab-${key}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(key)}
            style={({ pressed }) => [styles.tab, on && styles.tabOn, pressed && styles.btnPressed]}>
            <Text numberOfLines={1} style={[styles.tabText, on && styles.tabTextOn]}>{title}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Ряд плашек с переносом; длинная плашка переносит текст, а не вылезает за край. */
export function Chips({ children }: { children: ReactNode }) {
  return <View style={styles.chips}>{children}</View>;
}

export function Chip({ text, strong, onPress }: { text: string; strong?: boolean; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={[styles.chip, strong ? styles.chipStrong : styles.chipWeak]}>
      <Text style={[styles.chipText, !strong && styles.muted]}>{text}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  fill: { flex: 1 },
  content: { padding: space.l, gap: space.m, maxWidth: 640, width: '100%', alignSelf: 'center' },
  card: { backgroundColor: colors.card, borderRadius: radius, padding: space.l, gap: space.s, borderWidth: 1, borderColor: colors.line },
  h: { fontSize: 18, fontWeight: '700', color: colors.ink },
  p: { fontSize: 15, lineHeight: 21, color: colors.ink },
  muted: { color: colors.muted },
  btn: { minHeight: touch, backgroundColor: colors.accent, borderRadius: radius, paddingHorizontal: space.l, paddingVertical: space.m, justifyContent: 'center' },
  btnPlain: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  btnDisabled: { opacity: 0.45 },
  btnPressed: { opacity: 0.8 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  btnTextPlain: { color: colors.ink },
  btnHint: { color: '#E4F4F2', fontSize: 13, marginTop: 2 },
  tabs: { flexDirection: 'row', backgroundColor: colors.card, borderRadius: radius, borderWidth: 1, borderColor: colors.line, padding: space.xs, gap: space.xs },
  tab: { flex: 1, minHeight: touch - 2 * space.xs, borderRadius: radius - space.xs, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.xs },
  tabOn: { backgroundColor: colors.accent },
  tabText: { fontSize: 15, fontWeight: '600', color: colors.ink },
  tabTextOn: { color: '#fff' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  chip: { maxWidth: '100%', borderRadius: 16, paddingHorizontal: space.m, paddingVertical: 6 },
  chipStrong: { backgroundColor: colors.accentSoft },
  chipWeak: { backgroundColor: '#EEF1F1' },
  chipText: { fontSize: 14, color: colors.ink },
});
