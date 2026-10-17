// Строка обследования в карте пациента: ещё не сделано — кнопка с минутами и ценой и «?»; сделано — ответ на месте
// (отзыв на 0.0.37): только что пришедшее — целиком, прежнее — строкой «что нашли», касание раскрывает; ещё не пришло —
// штампом «Будет в 10:25». Снимок, лента, срез — всегда на виду. Одна для осмотров места на фигуре и бланка направления
// (0.6.0).
import { type LayoutChangeEvent, Pressable } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { T } from '@/i18n';
import { examInfo, examTerm, findingInfo, type TermInfo, type VisitView } from '@/state/caseView';
import { Button, Chip, Chips } from '@/ui/components';
import { makeStyles, space } from '@/ui/theme';
import { Text } from '../text';
import { ResultPicture } from './ResultPicture';

export function ExamRow({ v, id, open: opened, onToggle, onExam, explain, onLayout, indent }: {
  v: VisitView; id: string;
  /** игрок раскрыл прежний ответ */
  open: boolean; onToggle: () => void;
  onExam: (id: string) => void; explain: (info: TermInfo) => void; onLayout?: (e: LayoutChangeEvent) => void;
  /** строка раздела бланка — с отступом под заголовком */
  indent?: boolean;
}) {
  const styles = useStyles();
  const t = T.spikes.patient;
  const info = examInfo(id);
  if (v.done.includes(id)) {
    // все результаты назначения — и повторного забора (часть 39в: тропонин через час), новые сверху
    const gs = v.groups.filter(x => x.exam === id);
    const g = gs[0];
    const lines = gs.flatMap(x => x.lines);
    const ready = v.pending.find(x => x.exam === id);
    const open = !!g && (g.fresh || opened);
    const seen = lines.filter(l => l.shown).map(l => l.text).join('; ') || t.nothingFound;
    const summary = g ? (ready ? `${seen} · ${t.readyAt(ready.at)}` : seen) : ready ? t.readyAt(ready.at) : t.done;
    return (
      <Animated.View entering={FadeInDown.duration(250)} testID={`done-${id}`} onLayout={onLayout} style={[styles.done, indent && styles.indent, g?.fresh && styles.fresh]}>
        <Pressable accessibilityRole="button" aria-expanded={open} accessibilityLabel={`${info.name}: ${open ? t.collapse : t.expand}`} disabled={!g || g.fresh}
          hitSlop={HEAD_SLOP} onPress={onToggle} style={({ pressed }) => [styles.head, pressed && styles.pressed]}>
          <Text style={styles.title}>{`✓ ${info.name}`}</Text>
          {g?.fresh ? <Text style={styles.badge}>{t.fresh}</Text> : g ? <Text style={styles.chevron}>{open ? '▴' : '▾'}</Text> : null}
        </Pressable>
        {g?.image ? <ResultPicture image={g.image} /> : null}
        {open ? <Chips>{lines.map((r, i) => <Chip key={`${r.f}${i}`} text={r.text} strong={r.shown} onPress={() => explain(findingInfo(r.f))} />)}</Chips>
          : !g && ready ? <Text testID={`stamp-${id}`} style={styles.stamp}>{t.readyAt(ready.at)}</Text>
          : <Text numberOfLines={2} style={styles.summary}>{summary}</Text>}
      </Animated.View>
    );
  }
  // своя больница: нет помещения, аппарата или человека — серым, с причиной
  const why = v.unavailable[id];
  return (
    <Button testID={`exam-${id}`} kind="plain" disabled={!!why} title={info.name}
      hint={why ?? (v.bedside?.[id] !== undefined ? t.costBedside(v.bedside[id], info.cost) : t.cost(v.minutes?.[id] ?? info.minutes, info.cost))} hintMono={!why}
      onPress={() => onExam(id)} onInfo={() => explain(examTerm(id))} infoLabel={t.whatIsIt} />
  );
}

/**
 * Шапка сделанного — строка в 18 пикселей: касанию не хватало до 48 dp (NFR-ACC-1, разбор 0.6.3). Поле касания — внутри
 * своей строки: сверху на её отступ, снизу на строку итога; находки под шапкой нажимаются сами — они выше в порядке касаний.
 */
const HEAD_SLOP = { top: space.m, bottom: space.m + space.s - 2, left: space.m, right: space.m };

const useStyles = makeStyles(t => ({
  done: { gap: space.xs, padding: space.m, borderRadius: t.shape.radius, borderWidth: 1, borderColor: t.colors.line },
  fresh: { backgroundColor: t.colors.fresh, borderColor: t.colors.freshLine },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.s },
  title: { flex: 1, fontSize: 13, fontWeight: '600', color: t.colors.muted },
  badge: { fontSize: 12, fontWeight: '700', color: t.colors.onYellow, backgroundColor: t.colors.yellow, borderRadius: 10, paddingHorizontal: space.s, paddingVertical: 2, overflow: 'hidden' },
  chevron: { fontSize: 14, color: t.colors.muted },
  summary: { fontSize: 14, color: t.colors.ink },
  indent: { marginLeft: space.m },
  // отправленное — штампом на бланке: время, когда будет
  stamp: {
    alignSelf: 'flex-start', fontFamily: t.fonts.mono, fontSize: 13, fontWeight: '700', color: t.colors.accent, borderWidth: 1.5,
    borderColor: t.colors.accent, borderRadius: 4, paddingHorizontal: space.s, paddingVertical: 2, transform: [{ rotate: '-1.5deg' }],
  },
  pressed: { opacity: 0.7 },
}));
