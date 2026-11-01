// «Осмотреть» фигурой человека (spec 2026-10-patient-card, 0.6.0; ответ владельца на вопрос 44): на теле — точки мест,
// касание открывает осмотры места панелью внизу вкладки, как вопросы в «Спросить»; ответ — тут же. На точке — сколько
// осмотров осталось, всё осмотрено — галочка, нашли что-то — красный ободок. Над фигурой — «Весь больной» и «У постели».
import { useRef, useState } from 'react';
import { type LayoutChangeEvent, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { T } from '@/i18n';
import type { TermInfo, VisitView } from '@/state/caseView';
import { Button } from '@/ui/components';
import { Icon } from '@/ui/Icon';
import { BODY_H, BODY_POINTS, BODY_W } from '@/ui/bodyShape';
import { SHELF_ICONS } from '@/ui/iconShapes';
import { makeStyles, space, touch, useTheme } from '@/ui/theme';
import { Text } from '../text';
import { BodyFigure } from './BodyFigure';
import { ExamRow } from './ExamRow';
import { BODY_PLACES, type ExamPlace, inPlaceOrder, placeOf, SHELVES } from './places';

const DOT = 28;

/**
 * Что с местом: сколько осмотров ещё не сделано, сколько всего, нашли ли что-то; «Практикант» — есть ли здесь осмотр по
 * жалобе (остальные места — бледнее).
 */
function stateOf(v: VisitView, ids: readonly string[], place: ExamPlace, focus?: ReadonlySet<string>) {
  const here = ids.filter(id => placeOf(id) === place);
  const done = here.filter(id => v.done.includes(id));
  const found = done.some(id => v.groups.some(g => g.exam === id && g.lines.some(l => l.shown)));
  const hot = !focus || here.some(id => focus.has(id) || v.done.includes(id));
  return { all: here.length, left: here.length - done.length, done: done.length, found, hot };
}

/** Фигура с точками мест и полки над ней. */
export function BodyMap({ v, ids, place, onPlace, focus }: {
  v: VisitView; ids: readonly string[]; place?: ExamPlace; onPlace: (place: ExamPlace) => void; focus?: ReadonlySet<string>;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const t = T.spikes.body;
  const [width, setWidth] = useState(0);
  // фигура — чуть меньше половины ширины: подписи мест — по бокам
  const figW = Math.min(width * 0.46, 190);
  const scale = figW / BODY_W;
  const left = (width - figW) / 2;
  return (
    <View style={styles.wrap}>
      {focus && <Text testID="visit-focus" style={styles.focus}>{t.focus}</Text>}
      {/* весь больной и приборы у постели — сверху, чтобы фигура с ногами помещалась на экран без прокрутки */}
      <View style={styles.shelves}>
        {SHELVES.map(sh => {
          const s = stateOf(v, ids, sh, focus);
          if (s.all === 0) return null;
          const on = place === sh;
          return (
            <Pressable key={sh} testID={`body-${sh}`} accessibilityRole="button" aria-expanded={on} accessibilityHint={t.shelf[sh]}
              onPress={() => onPlace(sh)} style={({ pressed }) => [styles.shelf, on && styles.shelfOn, !s.hot && !on && styles.cold, pressed && styles.pressed]}>
              <Icon shape={SHELF_ICONS[sh]} size={22} color={on ? theme.colors.accent : theme.colors.muted} />
              <View style={styles.shelfText}>
                {/* на 360 точках «Весь больной» в одну строку не входил (часть 103) — две строки, если надо */}
                <Text numberOfLines={2} style={styles.shelfTitle}>{t.places[sh]}</Text>
                <Text numberOfLines={1} style={styles.shelfHint}>{t.doneOf(s.done, s.all)}</Text>
              </View>
              {s.found ? <View style={styles.foundMark} /> : null}
            </Pressable>
          );
        })}
      </View>
      <View testID="body-map" accessibilityHint={t.hint} onLayout={e => setWidth(e.nativeEvent.layout.width)} style={styles.map}>
        {width > 0 ? (
          <View style={{ width, height: (figW * BODY_H) / BODY_W }}>
            <View style={[styles.figure, { left }]}>
              <BodyFigure width={figW} />
            </View>
            {BODY_PLACES.map(p => {
              const s = stateOf(v, ids, p, focus);
              if (s.all === 0) return null;
              const pt = BODY_POINTS[p];
              const x = left + pt.x * scale;
              const y = pt.y * scale;
              const on = place === p;
              const title = t.places[p];
              const box = pt.side === 'right' ? { left: x - DOT / 2 } : { right: width - x - DOT / 2 };
              return (
                <Pressable key={p} testID={`body-${p}`} accessibilityRole="button" aria-expanded={on} accessibilityLabel={t.point(title, s.left, s.found)}
                  onPress={() => onPlace(p)}
                  style={({ pressed }) => [styles.spot, box, { top: y - touch / 2, flexDirection: pt.side === 'right' ? 'row' : 'row-reverse' },
                    !s.hot && !on && styles.cold, pressed && styles.pressed]}>
                  <View style={[styles.ring, s.found && styles.ringFound]}>
                    <View style={[styles.dot, s.left === 0 && styles.dotDone, on && styles.dotOn]}>
                      <Text style={[styles.dotText, (s.left === 0 || on) && styles.dotTextOn]}>{s.left === 0 ? '✓' : String(s.left)}</Text>
                    </View>
                  </View>
                  <Text style={[styles.tag, on && styles.tagOn]}>{title}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/**
 * Осмотры места — панелью внизу вкладки, не выше половины экрана: вкладки остаются под пальцем. Сделанное — с ответом
 * на месте, новый ответ — прокруткой на виду. «Практикант» — сначала то, что относится к жалобе, остальное свёрнуто.
 */
export function PlacePanel({ v, place, ids, focus, isOpen, toggle, onExam, explain, onClose }: {
  v: VisitView; place: ExamPlace; ids: readonly string[]; focus?: ReadonlySet<string>;
  isOpen: (key: string) => boolean; toggle: (key: string) => void;
  onExam: (id: string) => void; explain: (info: TermInfo) => void; onClose: () => void;
}) {
  const styles = useStyles();
  const { height } = useWindowDimensions();
  const t = T.spikes.body;
  const p = T.spikes.patient;
  const scroll = useRef<ScrollView>(null);
  // новый ответ — к нему, когда строка разложилась
  const want = useRef<string | null>(null);
  const here = inPlaceOrder(ids.filter(id => placeOf(id) === place));
  const main = focus ? here.filter(id => focus.has(id) || v.done.includes(id)) : here;
  const rest = focus ? here.filter(id => !main.includes(id)) : [];
  const restKey = `rest:examine:${place}`;
  const shown = [...main, ...(isOpen(restKey) ? rest : [])];
  const exam = (id: string) => {
    want.current = id;
    onExam(id);
  };
  const placed = (id: string, e: LayoutChangeEvent) => {
    if (want.current !== id || !v.done.includes(id)) return;
    want.current = null;
    scroll.current?.scrollTo({ y: Math.max(0, e.nativeEvent.layout.y - space.s), animated: true });
  };
  return (
    <View testID="body-panel" style={[styles.panel, { maxHeight: Math.round(height * 0.45) }]}>
      <View style={styles.panelHead}>
        <Text style={styles.panelTitle}>{t.places[place]}</Text>
        <Pressable testID="body-close" accessibilityRole="button" onPress={onClose} hitSlop={8} style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
          <Text style={styles.closeText}>{t.close}</Text>
        </Pressable>
      </View>
      <ScrollView ref={scroll} style={styles.panelScroll} contentContainerStyle={styles.panelContent}>
        {shown.map(id => (
          <ExamRow key={id} v={v} id={id} open={isOpen(`done:${id}`)} onToggle={() => toggle(`done:${id}`)} onExam={exam} explain={explain}
            onLayout={e => placed(id, e)} />
        ))}
        {rest.length > 0 && (
          <Button testID="visit-rest-examine" kind="plain" title={isOpen(restKey) ? p.restHide : p.restShow(rest.length)} onPress={() => toggle(restKey)} />
        )}
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles(t => ({
  wrap: { gap: space.m },
  map: { width: '100%' },
  figure: { position: 'absolute', top: 0 },
  spot: { position: 'absolute', height: touch, alignItems: 'center', gap: space.xs },
  ring: { width: DOT + 6, height: DOT + 6, borderRadius: (DOT + 6) / 2, alignItems: 'center', justifyContent: 'center' },
  ringFound: { borderWidth: 2.5, borderColor: t.colors.danger },
  dot: {
    width: DOT, height: DOT, borderRadius: DOT / 2, alignItems: 'center', justifyContent: 'center',
    backgroundColor: t.colors.card, borderWidth: 2, borderColor: t.colors.accent,
  },
  dotDone: { backgroundColor: t.colors.accent },
  dotOn: { backgroundColor: t.colors.accent, borderColor: t.colors.ink },
  dotText: { fontSize: 13, fontWeight: '700', color: t.colors.accent },
  dotTextOn: { color: t.colors.onAccent },
  tag: {
    fontSize: 13, fontWeight: '700', color: t.colors.ink, backgroundColor: t.colors.card, overflow: 'hidden',
    borderWidth: 1, borderColor: t.colors.edge, borderRadius: 10, paddingHorizontal: space.s, paddingVertical: 2,
  },
  tagOn: { color: t.colors.accent, borderColor: t.colors.accent },
  shelves: { flexDirection: 'row', gap: space.s },
  shelf: {
    flex: 1, minHeight: touch, flexDirection: 'row', alignItems: 'center', gap: space.s, paddingHorizontal: space.s,
    paddingVertical: space.xs, borderRadius: t.shape.radius, borderWidth: 1.5, borderColor: t.colors.edge, backgroundColor: t.colors.card,
  },
  shelfOn: { borderColor: t.colors.accent, backgroundColor: t.colors.accentSoft },
  shelfText: { flex: 1 },
  shelfTitle: { fontSize: 14, lineHeight: 18, fontWeight: '700', color: t.colors.ink },
  shelfHint: { fontSize: 12, lineHeight: 15, color: t.colors.muted },
  foundMark: { width: 10, height: 10, borderRadius: 5, backgroundColor: t.colors.danger },
  cold: { opacity: 0.45 },
  focus: { fontSize: 13, lineHeight: 17, color: t.colors.muted },
  // не выше 45 % экрана — и сжимается, если места меньше: с крупным текстом шапка пациента выше, и панель без этого
  // сдвигала вкладки за нижний край (NFR-ACC-1, разбор 0.6.3)
  panel: { flexShrink: 1, backgroundColor: t.colors.card, borderTopWidth: 1, borderTopColor: t.colors.edge },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: space.s, paddingLeft: space.l, paddingRight: space.s, paddingTop: space.s },
  panelTitle: { flex: 1, fontFamily: t.fonts.title, fontSize: 16, fontWeight: '700', color: t.colors.ink },
  close: { minHeight: 36, justifyContent: 'center', paddingHorizontal: space.m },
  closeText: { fontSize: 14, fontWeight: '700', color: t.colors.accent },
  panelScroll: { flexGrow: 0 },
  panelContent: { paddingHorizontal: space.l, paddingVertical: space.s, gap: space.s },
  pressed: { opacity: 0.7 },
}));
