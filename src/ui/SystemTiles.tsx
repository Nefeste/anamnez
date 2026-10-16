// Группы болезней плитками (0.5.20, отзыв владельца 16.10.2026): две колонки, у каждой группы — значок и название,
// как в выборе диагноза. Отмеченная — рамкой цвета главной кнопки и галочкой на значке: цвет один различают не все.
// Плитка — флажок для чтения с экрана (`aria-checked`).
import { Pressable, View } from 'react-native';
import { type BodySystem, SYSTEMS } from '@/content/types';
import { T } from '@/i18n';
import { Icon } from './Icon';
import { SYSTEM_ICONS } from './iconShapes';
import { Text } from './text';
import { makeStyles, space, touch, useTheme } from './theme';

export function SystemTiles({ value, onChange, testPrefix }: { value: readonly BodySystem[]; onChange: (next: BodySystem[]) => void; testPrefix: string }) {
  const styles = useStyles();
  const t = useTheme();
  // порядок — как в выборе диагноза, а не как отмечали
  const toggle = (k: BodySystem) => onChange(SYSTEMS.filter(x => (x === k ? !value.includes(k) : value.includes(x))));
  return (
    <View style={styles.grid}>
      {SYSTEMS.map(k => {
        const on = value.includes(k);
        return (
          <Pressable key={k} testID={`${testPrefix}-${k}`} accessibilityRole="checkbox" aria-checked={on} onPress={() => toggle(k)}
            style={({ pressed }) => [styles.tile, on && styles.tileOn, pressed && styles.pressed]}>
            <View style={[styles.badge, on && styles.badgeOn]}>
              <Icon shape={SYSTEM_ICONS[k]} size={24} color={on ? t.colors.accent : t.colors.muted} />
              {on && (
                <View style={styles.check}>
                  <Text style={styles.checkMark}>✓</Text>
                </View>
              )}
            </View>
            {/* название целиком: в две строки при обычном шрифте, в три — при крупном */}
            <Text style={[styles.title, on && styles.titleOn]} numberOfLines={3}>{T.spikes.decision.system[k]}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const useStyles = makeStyles(t => ({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  // две в ряд при любой ширине: основа меньше половины, остальное — поровну
  tile: {
    flexBasis: '45%', flexGrow: 1, minHeight: touch + space.l, flexDirection: 'row', alignItems: 'center', gap: space.s,
    paddingVertical: space.s, paddingHorizontal: space.s,
    borderRadius: t.shape.radius, borderWidth: 1.5, borderColor: t.colors.edge, backgroundColor: t.colors.card,
  },
  tileOn: { borderColor: t.colors.accent, backgroundColor: t.colors.accentSoft },
  pressed: { opacity: 0.8 },
  badge: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.chip },
  badgeOn: { backgroundColor: t.colors.card },
  title: { flex: 1, fontSize: 14, lineHeight: 18, color: t.colors.ink },
  titleOn: { fontWeight: '700' },
  // галочка — на краю значка, с кромкой цвета плитки: видна и на мягком фоне
  check: {
    position: 'absolute', right: -5, bottom: -5, width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: t.colors.accentSoft,
    alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.accent,
  },
  checkMark: { fontSize: 10, lineHeight: 12, fontWeight: '700', color: t.colors.onAccent },
}));
