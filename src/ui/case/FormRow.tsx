// Строки бланка (0.6.0, вопрос 45): бланк направления в «Назначить» и лист назначений в «Решении» — одного вида.
// Обследование или лечение отмечают галочкой, место лечения — кружком; «?» — что это; разделы — свёрнуты. Со значком строки
// (0.6.8, вопрос 49): обследование — рисунок способа, ещё не сделано — серым пунктиром с «?»; лечение — путь введения.
import { Pressable, View } from 'react-native';
import { InfoButton } from '@/ui/components';
import type { ItemIcon } from '@/ui/itemIcons';
import { RowIcon, type RowState } from '@/ui/RowIcon';
import { makeStyles, space, touch } from '@/ui/theme';
import { Text } from '../text';

/** Строка с галочкой (`radio` — с кружком: одно из нескольких). Не сделать — серым, с причиной в `hint`. */
export function CheckRow({ testID, title, hint, hintMono, on, disabled, onPress, onInfo, infoLabel, radio, indent, icon }: {
  testID: string; title: string; hint?: string;
  /** значок строки: рисунок и что известно */
  icon?: { icon: ItemIcon; state: RowState };
  /** пояснение — минуты и рубли: моноширинным, как у кнопок */
  hintMono?: boolean;
  on: boolean; disabled?: boolean; onPress: () => void; onInfo?: () => void; infoLabel?: string; radio?: boolean;
  /** строка раздела — с отступом под заголовком */
  indent?: boolean;
}) {
  const styles = useStyles();
  return (
    <View style={[styles.row, indent && styles.indent]}>
      <Pressable testID={testID} accessibilityRole={radio ? 'radio' : 'checkbox'} aria-checked={on} disabled={disabled} onPress={onPress}
        style={({ pressed }) => [styles.check, on && styles.checkOn, disabled && styles.disabled, pressed && styles.pressed]}>
        <View style={[radio ? styles.round : styles.box, on && styles.boxOn]}>
          {on ? radio ? <View style={styles.dot} /> : <Text style={styles.tick}>✓</Text> : null}
        </View>
        {icon ? <RowIcon icon={icon.icon} state={icon.state} size={26} testID={`ic-${icon.state}`} /> : null}
        <View style={styles.fill}>
          <Text style={styles.title}>{title}</Text>
          {hint ? <Text style={[styles.hint, hintMono && styles.mono]}>{hint}</Text> : null}
        </View>
      </Pressable>
      {onInfo ? <InfoButton testID={`${testID}-info`} label={infoLabel} onPress={onInfo} /> : null}
    </View>
  );
}

/** Заголовок раздела: название, что отмечено и сделано, стрелка; касание раскрывает и сворачивает. */
export function SectionHead({ testID, title, state, marked, open, onPress }: {
  testID: string; title: string; state: string;
  /** в разделе что-то отмечено — число цветом главной кнопки */
  marked?: boolean;
  open: boolean; onPress: () => void;
}) {
  const styles = useStyles();
  return (
    <Pressable testID={testID} accessibilityRole="button" aria-expanded={open} onPress={onPress}
      style={({ pressed }) => [styles.head, open && styles.headOpen, pressed && styles.pressed]}>
      <Text style={styles.headTitle}>{title}</Text>
      <Text style={[styles.state, marked && styles.stateMarked]}>{state}</Text>
      <Text style={styles.chevron}>{open ? '▴' : '▾'}</Text>
    </Pressable>
  );
}

const useStyles = makeStyles(t => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  indent: { marginLeft: space.m },
  check: {
    flex: 1, minHeight: touch, flexDirection: 'row', alignItems: 'center', gap: space.m, paddingHorizontal: space.m, paddingVertical: space.s,
    borderRadius: t.shape.radius, borderWidth: 1.5, borderColor: t.colors.edge, backgroundColor: t.colors.card,
  },
  checkOn: { borderColor: t.colors.accent, backgroundColor: t.colors.accentSoft },
  box: { width: 24, height: 24, borderRadius: 4, borderWidth: 2, borderColor: t.colors.accent, alignItems: 'center', justifyContent: 'center' },
  round: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: t.colors.accent, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: t.colors.accent },
  tick: { fontSize: 15, lineHeight: 18, fontWeight: '700', color: t.colors.onAccent },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: t.colors.onAccent },
  fill: { flex: 1 },
  title: { fontSize: 16, fontWeight: '700', color: t.colors.ink },
  hint: { fontSize: 13, marginTop: 2, color: t.colors.muted },
  mono: { fontFamily: t.fonts.mono, color: t.shape.ruled ? t.colors.muted : t.colors.info },
  head: {
    minHeight: touch, flexDirection: 'row', alignItems: 'center', gap: space.s, paddingHorizontal: space.m,
    borderRadius: t.shape.radius, borderWidth: 1, borderColor: t.colors.edge, backgroundColor: t.colors.card,
  },
  headOpen: { borderColor: t.colors.accent, marginTop: space.s },
  headTitle: { flex: 1, fontSize: 16, fontWeight: '700', color: t.colors.ink },
  state: { fontSize: 13, color: t.colors.muted },
  stateMarked: { color: t.colors.accent, fontWeight: '700' },
  chevron: { fontSize: 14, color: t.colors.muted },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.8 },
}));
