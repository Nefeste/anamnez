// Графики профиля (0.6.2, по правилам визуализации данных): одна цифра — плиткой, доля от предела — шкалой, часть
// целого — полосой из частей с промежутками, ряд величин — горизонтальными полосами. Тонкие полосы с закруглённым
// концом и прямым у основания, промежуток цвета карточки между частями, подписи — цветом текста, а не данных; у полосы
// из частей — легенда со значком, подписью и числом. Каждое число видно и без касаний — подписями. Рисуются View, без
// холста: одинаково на телефоне и в вебе. Цвета — роли темы (`chart`, `chartTrack`, `good`, `warn`, `bad`).
import { View } from 'react-native';
import { makeStyles, space } from '@/ui/theme';
import { Text } from './text';

/** Толщина полосы ряда и полосы из частей (не толще 24), шкалы; радиус закругления конца. */
const BAR = 14;
const TRACK = 8;
const END = 4;
/** Промежуток цвета карточки между частями полосы. */
const GAP = 2;

/** Одна цифра с подписью: подпись — строчными, приглушённо; цифра — крупно, тем же шрифтом без засечек. */
export function StatTile({ label, value, testID }: { label: string; value: string; testID?: string }) {
  const styles = useStyles();
  return (
    <View testID={testID} accessible accessibilityLabel={`${label}: ${value}`} style={styles.tile}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={styles.tileValue}>{value}</Text>
    </View>
  );
}

/** Доля от предела: подпись и «N из M» над шкалой; дорожка — светлый шаг того же цвета. */
export function Meter({ label, value, max, text, hint, testID }: {
  label: string; value: number; max: number; text: string; hint?: string; testID?: string;
}) {
  const styles = useStyles();
  const share = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <View testID={testID} accessible accessibilityRole="progressbar" accessibilityLabel={`${label}: ${text}${hint ? `, ${hint}` : ''}`}
      accessibilityValue={{ min: 0, max: Math.max(1, Math.round(max)), now: Math.round(Math.min(value, max)) }} style={styles.meter}>
      <View style={styles.meterHead}>
        <Text style={styles.meterLabel}>{label}</Text>
        <Text style={styles.meterText}>{text}</Text>
      </View>
      <View style={styles.track}>
        {share > 0 ? <View style={[styles.fill, { width: `${share * 100}%` }]} /> : null}
      </View>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export interface Part {
  key: string;
  value: number;
  color: string;
  /** значок рядом с подписью: цвет не единственный носитель смысла */
  icon: string;
  label: string;
  /** число в легенде: «80 · 67 %» */
  text: string;
}

/** Часть целого — одна полоса; легенда под ней: цветной квадрат, значок, подпись, число. Пустые части не рисуются. */
export function StackBar({ parts, label, testID }: { parts: readonly Part[]; label: string; testID?: string }) {
  const styles = useStyles();
  const shown = parts.filter(p => p.value > 0);
  return (
    <View testID={testID} accessible accessibilityLabel={`${label}: ${parts.map(p => `${p.label} ${p.text}`).join(', ')}`} style={styles.stack}>
      <View style={styles.stackBar}>
        {shown.map((p, i) => (
          <View key={p.key} style={[styles.part, { flexGrow: p.value, backgroundColor: p.color },
            i === 0 && styles.partFirst, i === shown.length - 1 && styles.partLast]} />
        ))}
      </View>
      <View style={styles.legend}>
        {parts.map(p => (
          <View key={p.key} testID={testID ? `${testID}-${p.key}` : undefined} style={styles.legendItem}>
            <View style={[styles.swatch, { backgroundColor: p.color }]} />
            <Text style={styles.legendLabel}>{`${p.icon} ${p.label}`}</Text>
            <Text style={styles.legendValue}>{p.text}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** Ряд величин одного вида — горизонтальными полосами от общего основания; число — у конца полосы. */
export function BarList({ rows, label, testID }: { rows: readonly { key: string; label: string; value: number }[]; label: string; testID?: string }) {
  const styles = useStyles();
  const top = Math.max(1, ...rows.map(r => r.value));
  return (
    <View testID={testID} accessible accessibilityLabel={`${label}: ${rows.map(r => `${r.label} — ${r.value}`).join(', ')}`}>
      {rows.map(r => (
        <View key={r.key} testID={testID ? `${testID}-${r.key}` : undefined} style={styles.barRow}>
          <Text style={styles.barLabel}>{r.label}</Text>
          <View style={styles.barArea}>
            {r.value > 0 ? <View style={[styles.bar, { width: `${(r.value / top) * 82}%` }]} /> : null}
            <Text style={styles.barValue}>{String(r.value)}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

const useStyles = makeStyles(t => ({
  // цифры плиток одного ряда — на одной линии, даже когда подпись соседа в две строки
  tile: {
    flexGrow: 1, flexBasis: '45%', gap: 2, justifyContent: 'space-between', paddingVertical: space.m, paddingHorizontal: space.m,
    borderRadius: t.shape.card, borderWidth: 1, borderColor: t.colors.edge, backgroundColor: t.colors.card,
  },
  tileLabel: { fontSize: 13, lineHeight: 17, color: t.colors.muted },
  tileValue: { fontFamily: t.fonts.body, fontSize: 26, lineHeight: 32, fontWeight: '700', color: t.colors.ink },
  meter: { gap: space.xs },
  meterHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space.s },
  meterLabel: { flex: 1, fontSize: 15, lineHeight: 20, color: t.colors.ink },
  meterText: { fontSize: 14, lineHeight: 20, fontWeight: '700', color: t.colors.ink },
  track: { height: TRACK, borderRadius: END, backgroundColor: t.colors.chartTrack, overflow: 'hidden' },
  fill: { height: TRACK, borderRadius: END, backgroundColor: t.colors.chart },
  hint: { fontSize: 13, lineHeight: 17, color: t.colors.muted },
  stack: { gap: space.m },
  stackBar: { flexDirection: 'row', gap: GAP, height: BAR },
  part: { height: BAR, flexBasis: 0 },
  partFirst: { borderTopLeftRadius: END, borderBottomLeftRadius: END },
  partLast: { borderTopRightRadius: END, borderBottomRightRadius: END },
  legend: { gap: space.xs },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: space.s, minHeight: 24 },
  swatch: { width: 12, height: 12, borderRadius: 2 },
  legendLabel: { flex: 1, fontSize: 15, lineHeight: 20, color: t.colors.ink },
  legendValue: { fontSize: 14, lineHeight: 20, fontWeight: '700', color: t.colors.ink },
  barRow: { flexDirection: 'row', alignItems: 'stretch', gap: space.s },
  barLabel: { width: 18, fontSize: 15, lineHeight: 20, fontWeight: '700', color: t.colors.ink, textAlign: 'center', alignSelf: 'center' },
  // основание — тонкая линия слева, сплошная: ряды без промежутков, воздух — внутри ряда
  barArea: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.s, paddingVertical: space.xs, minHeight: 32,
    borderLeftWidth: 1, borderLeftColor: t.colors.edge,
  },
  bar: { height: BAR, borderTopRightRadius: END, borderBottomRightRadius: END, backgroundColor: t.colors.chart },
  barValue: { fontSize: 14, lineHeight: 20, fontWeight: '700', color: t.colors.ink },
}));
