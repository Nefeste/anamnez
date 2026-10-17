// Вкладки карты пациента внизу, под большим пальцем (spec 2026-10-patient-card, 0.6.0): «Карта · Спросить · Осмотреть ·
// Назначить» и «Решение» — пятой, шире и цвета главной кнопки. На «Карте» — сколько пришло нового.
import { Pressable, View } from 'react-native';
import { T } from '@/i18n';
import { Icon } from '@/ui/Icon';
import { CARD_ICONS } from '@/ui/iconShapes';
import { makeStyles, space, touch, useTheme } from '@/ui/theme';
import { Text } from '../text';

export type CardTab = 'card' | 'ask' | 'examine' | 'order';
export const CARD_TABS: readonly CardTab[] = ['card', 'ask', 'examine', 'order'];

export function CardTabs({ value, onChange, fresh, decide }: {
  value: CardTab; onChange: (tab: CardTab) => void;
  /** новых результатов — числом на «Карте» */
  fresh: number;
  decide: { title: string; hint?: string; onPress: () => void };
}) {
  const styles = useStyles();
  const theme = useTheme();
  const t = T.spikes.patient;
  const title: Record<CardTab, string> = { card: t.card, ask: t.ask, examine: t.examine, order: t.order };
  return (
    <View style={styles.bar}>
      <View style={styles.tabs} accessibilityRole="tablist">
        {CARD_TABS.map(key => {
          const on = key === value;
          const count = key === 'card' && fresh > 0 ? fresh : 0;
          return (
            <Pressable key={key} testID={`tab-${key}`} accessibilityRole="tab" aria-selected={on}
              accessibilityLabel={count > 0 ? `${title[key]}, ${t.freshCount(count)}` : title[key]}
              onPress={() => onChange(key)} style={({ pressed }) => [styles.tab, pressed && styles.pressed]}>
              {on ? <View style={styles.mark} /> : null}
              <Icon shape={CARD_ICONS[key]} size={22} color={on ? theme.colors.accent : theme.colors.muted} />
              <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={[styles.label, on && styles.labelOn]}>{title[key]}</Text>
              {count > 0 ? <Text testID="visit-card-count" style={styles.count}>{count}</Text> : null}
            </Pressable>
          );
        })}
      </View>
      <Pressable testID="visit-decide" accessibilityRole="button" accessibilityHint={decide.hint} onPress={decide.onPress} hitSlop={DECIDE_SLOP}
        style={({ pressed }) => [styles.decide, pressed && styles.pressed]}>
        {/* оттиск штампа «Медкарты», как у главной кнопки */}
        {theme.shape.stamp ? <View style={styles.stamp} /> : null}
        <Icon shape={CARD_ICONS.decide} size={22} color={theme.colors.onAccent} />
        <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={styles.decideText}>{decide.title}</Text>
      </Pressable>
    </View>
  );
}

/** «Решение» — с отступом от края полосы: касание — на всю её высоту, не 44 dp (NFR-ACC-1). */
const DECIDE_SLOP = { top: space.s - 2, bottom: space.s - 2 };

const useStyles = makeStyles(t => ({
  bar: { flexDirection: 'row', alignItems: 'stretch', backgroundColor: t.colors.card, borderTopWidth: 1, borderTopColor: t.colors.edge },
  tabs: { flex: 4, flexDirection: 'row' },
  tab: { flex: 1, minHeight: touch + space.s, alignItems: 'center', justifyContent: 'center', gap: 2, paddingHorizontal: 1, paddingVertical: space.xs },
  mark: { position: 'absolute', top: 0, left: '18%', right: '18%', height: 3, borderBottomLeftRadius: 3, borderBottomRightRadius: 3, backgroundColor: t.colors.accent },
  label: { fontSize: 11, color: t.colors.muted },
  labelOn: { color: t.colors.accent, fontWeight: '700' },
  count: {
    position: 'absolute', top: space.xs, left: '50%', marginLeft: 6, minWidth: 16, paddingHorizontal: 5, borderRadius: 8, overflow: 'hidden',
    backgroundColor: t.colors.freshLine, color: t.colors.onYellow, fontSize: 11, fontWeight: '700', lineHeight: 16, textAlign: 'center',
  },
  decide: {
    flex: 1.15, margin: space.s - 2, marginLeft: 2, borderRadius: t.shape.radius, backgroundColor: t.colors.accent,
    alignItems: 'center', justifyContent: 'center', gap: 2, paddingHorizontal: space.xs,
  },
  stamp: { position: 'absolute', top: 3, right: 3, bottom: 3, left: 3, pointerEvents: 'none', borderWidth: 1, borderColor: t.colors.onAccentHint, borderRadius: Math.max(0, t.shape.radius - 2) },
  decideText: { fontSize: 13, fontWeight: '700', color: t.colors.onAccent },
  pressed: { opacity: 0.75 },
}));
