// Снимок крупно (spec 2026-11-xray): касание снимка в карте пациента открывает его на весь экран, на чёрном фоне
// негатоскопа. Двумя пальцами — увеличить и сдвинуть, двойное касание — ближе к этому месту или обратно; внизу — что
// нашли. Рисунок тот же, что в карте, — запись Skia (ADR 0013), только шире: увеличение — преобразованием холста, поэтому
// линии остаются чёткими. Modal — отдельное окно: свои корни жестов и системных отступов.
//
// Разметка находок (spec 2026-11-xray-marks, вопрос 76): на «Практиканте» и «Студенте», в разборе и у чужого приёма —
// контуры с подписями сразу; на «Ординаторе» и «Враче» — задача «Найдите на снимке»: игрок касается места находки,
// попал — строка отмечается «нашли сами» и копит умение «Чтение снимков»; промах — без штрафа, контур показан.
import { Canvas, Group, Path, Picture, rect, Skia, type SkPath, type SkPicture } from '@shopify/react-native-skia';
import { useMemo, useState } from 'react';
import { type LayoutChangeEvent, Modal, Pressable, ScrollView, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { type SharedValue, useAnimatedStyle, useDerivedValue, useSharedValue, withTiming } from 'react-native-reanimated';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { T } from '@/i18n';
import { hits } from '@/render/xray/marks';
import type { ImageMark, Line, Look } from '@/state/caseView';
import { Icon } from '@/ui/Icon';
import { ZOOM_ICON } from '@/ui/iconShapes';
import { useReduceMotion } from '@/ui/motion';
import { makeStyles, space, useTheme } from '@/ui/theme';
import { Text } from '../text';

/** Что показать: рисунок по ширине и высота к ширине. */
export interface ViewerPicture {
  record: (width: number) => SkPicture;
  aspect: number;
  /** на снимке — метка стороны «П» */
  sideMark?: boolean;
}

/** Разметка снимка: контуры, как их показывать и попытки задачи; `onLook` нет — задачи нет, контуры видны сразу. */
export interface ViewerMarks {
  marks: readonly ImageMark[];
  mode: 'show' | 'find';
  looked: readonly Look[];
  onLook?: (f: string, hit: boolean) => void;
}

type Props = { visible: boolean; onClose: () => void; title: string; picture: ViewerPicture; lines: readonly Line[]; marks?: ViewerMarks };

/** Самое крупное увеличение и то, до которого приближает двойное касание. */
const MAX_ZOOM = 5;
const TAP_ZOOM = 2.5;

export function ImageViewer(props: Props) {
  return (
    <Modal visible={props.visible} animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={props.onClose}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>{props.visible && <ViewerBody {...props} />}</SafeAreaProvider>
      </GestureHandlerRootView>
    </Modal>
  );
}

/** Какие контуры видны: при подсказке — все, в задаче — те, что игрок уже пробовал показать. */
export function visibleMarks(m: ViewerMarks | undefined): readonly ImageMark[] {
  if (!m) return [];
  const find = m.mode === 'find' && m.onLook !== undefined;
  return find ? m.marks.filter(x => m.looked.some(l => l.f === x.f)) : m.marks;
}

function ViewerBody({ onClose, title, picture, lines, marks }: Props) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const t = T.spikes.patient.viewer;
  const [box, setBox] = useState<{ w: number; h: number } | undefined>();
  // задача: какую находку просим показать и что сказать после касания
  const [asking, setAsking] = useState<ImageMark | undefined>();
  const [said, setSaid] = useState<string | undefined>();
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (!box || box.w !== width || box.h !== height) setBox({ w: width, h: height });
  };
  const found = lines.filter(l => l.shown);
  const task = marks && marks.mode === 'find' && marks.onLook ? marks : undefined;
  const left = task ? task.marks.filter(m => !task.looked.some(l => l.f === m.f)) : [];
  const answer = (m: ImageMark, hit: boolean) => {
    task?.onLook?.(m.f, hit);
    setSaid(hit ? t.hit(m.label) : t.miss(m.label));
    setAsking(undefined);
  };
  const onTap = asking ? (x: number, y: number) => answer(asking, hits(asking.area, [x, y], picture.aspect)) : undefined;
  return (
    <View testID="viewer" style={[styles.page, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.head}>
        <Text style={styles.title} numberOfLines={2}>{title}</Text>
        <Pressable testID="viewer-close" accessibilityRole="button" hitSlop={8} onPress={onClose}
          style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
          <Text style={styles.closeText}>{t.close}</Text>
        </Pressable>
      </View>
      <View style={styles.field} onLayout={onLayout}>
        {box && <ZoomPicture w={box.w} h={box.h} picture={picture} marks={visibleMarks(marks)} onTap={onTap} />}
      </View>
      <ScrollView style={styles.notes} contentContainerStyle={styles.notesContent}>
        {task && (
          <View testID="viewer-task" style={styles.task}>
            {asking ? (
              <>
                <Text testID="viewer-ask" style={styles.ask}>{t.where(asking.label)}</Text>
                <Pressable testID="viewer-reveal" accessibilityRole="button" onPress={() => answer(asking, false)} style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
                  <Text style={styles.actionText}>{t.reveal}</Text>
                </Pressable>
              </>
            ) : (
              <>
                {said && <Text testID="viewer-said" style={styles.ask}>{said}</Text>}
                {left.length > 0 ? (
                  <Pressable testID="viewer-find" accessibilityRole="button" onPress={() => { setSaid(undefined); setAsking(left[0]); }}
                    style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
                    <Text style={styles.actionText}>{t.find}</Text>
                  </Pressable>
                ) : <Text style={styles.hint}>{t.done}</Text>}
                {left.length > 0 && !said && <Text style={styles.hint}>{t.findHint}</Text>}
              </>
            )}
          </View>
        )}
        {found.length > 0 && <Text style={styles.found}>{`${t.found}: ${found.map(l => (l.self ? `${l.text} (${t.self})` : l.text)).join('; ')}`}</Text>}
        {picture.sideMark && <Text style={styles.hint}>{t.side}</Text>}
        <Text style={styles.hint}>{t.hint}</Text>
      </ScrollView>
    </View>
  );
}

/** Контуры места — одним путём в точках рисунка шириной `pw` и высотой `ph`. */
function outlinePath(m: ImageMark, pw: number, ph: number): SkPath {
  const p = Skia.Path.Make();
  for (const o of m.area.outlines) {
    if (o.length === 0) continue;
    p.moveTo(o[0][0] * pw, o[0][1] * ph);
    for (const q of o.slice(1)) p.lineTo(q[0] * pw, q[1] * ph);
    p.close();
  }
  return p;
}

/** Контуры поверх снимка: тёмная кайма под светлой линией — видно и на светлом, и на тёмном. */
function MarkPaths({ marks, pw, ph }: { marks: readonly ImageMark[]; pw: number; ph: number }) {
  const theme = useTheme();
  const paths = useMemo(() => marks.map(m => ({ f: m.f, path: outlinePath(m, pw, ph) })), [marks, pw, ph]);
  return (
    <>
      {paths.map(({ f, path }) => (
        <Group key={f}>
          <Path path={path} style="stroke" strokeWidth={5} color={theme.colors.film} opacity={0.6} />
          <Path path={path} style="stroke" strokeWidth={2.5} color={theme.colors.onFilm} />
        </Group>
      ))}
    </>
  );
}

/** Снимок во всё поле: вписан целиком, жесты двигают и увеличивают его внутри холста. */
function ZoomPicture({ w, h, picture, marks, onTap }: {
  w: number; h: number; picture: ViewerPicture; marks: readonly ImageMark[];
  /** задача: касание в долях кадра — куда показал игрок */
  onTap?: (x: number, y: number) => void;
}) {
  const motion = useReduceMotion();
  // вписать целиком: по ширине, а если не помещается по высоте — по высоте
  const pw = Math.min(w, h / picture.aspect);
  const ph = pw * picture.aspect;
  const { record } = picture;
  const pic = useMemo(() => record(pw), [record, pw]);
  const zoom = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const transform = useDerivedValue(() => [
    { translateX: w / 2 + tx.value }, { translateY: h / 2 + ty.value }, { scale: zoom.value },
    { translateX: -pw / 2 }, { translateY: -ph / 2 },
  ]);

  // сдвиг не уводит снимок за край: край увеличенного снимка не отходит от края поля
  const clamp = (v: number, z: number, side: number, size: number) => {
    'worklet';
    const room = Math.max(0, (size * z - side) / 2);
    return Math.min(room, Math.max(-room, v));
  };
  // get()/set() вместо .value: так React Compiler понимает, что это не состояние React
  const pinch = Gesture.Pinch().onChange(e => {
    'worklet';
    const z = zoom.get();
    const next = Math.min(MAX_ZOOM, Math.max(1, z * e.scaleChange));
    const fx = e.focalX - w / 2, fy = e.focalY - h / 2;
    tx.set(clamp(fx - ((fx - tx.get()) * next) / z, next, w, pw));
    ty.set(clamp(fy - ((fy - ty.get()) * next) / z, next, h, ph));
    zoom.set(next);
  });
  const pan = Gesture.Pan().onChange(e => {
    'worklet';
    tx.set(clamp(tx.get() + e.changeX, zoom.get(), w, pw));
    ty.set(clamp(ty.get() + e.changeY, zoom.get(), h, ph));
  });
  const doubleTap = Gesture.Tap().numberOfTaps(2).onEnd(e => {
    'worklet';
    const options = { duration: 220, reduceMotion: motion };
    if (zoom.get() > 1.2) {
      zoom.set(withTiming(1, options));
      tx.set(withTiming(0, options));
      ty.set(withTiming(0, options));
      return;
    }
    const fx = e.x - w / 2, fy = e.y - h / 2;
    zoom.set(withTiming(TAP_ZOOM, options));
    tx.set(withTiming(clamp(fx - (fx - tx.get()) * TAP_ZOOM, TAP_ZOOM, w, pw), options));
    ty.set(withTiming(clamp(fy - (fy - ty.get()) * TAP_ZOOM, TAP_ZOOM, h, ph), options));
  });
  // задача: одно касание — точка на снимке в долях кадра, с учётом увеличения и сдвига
  const point = (x: number, y: number) => onTap?.(x, y);
  const tap = Gesture.Tap().numberOfTaps(1).enabled(onTap !== undefined).onEnd(e => {
    'worklet';
    const px = (e.x - w / 2 - tx.get()) / zoom.get() + pw / 2;
    const py = (e.y - h / 2 - ty.get()) / zoom.get() + ph / 2;
    scheduleOnRN(point, px / pw, py / ph);
  });
  const gesture = Gesture.Race(Gesture.Exclusive(doubleTap, tap), Gesture.Simultaneous(pinch, pan));
  return (
    <GestureDetector gesture={gesture}>
      {/* холст в вебе testID не передаёт — его несёт обёртка */}
      <View testID="viewer-picture" style={{ width: w, height: h }}>
        <Canvas style={{ width: w, height: h }}>
          <Group transform={transform}>
            {/* рисунок местами выходит за свой кадр (тело ниже края, размытие) — в поле шире снимка это видно */}
            <Group clip={rect(0, 0, pw, ph)}>
              <Picture picture={pic} />
            </Group>
            <MarkPaths marks={marks} pw={pw} ph={ph} />
          </Group>
        </Canvas>
        {marks.map(m => (
          <MarkLabel key={m.f} mark={m} w={w} h={h} pw={pw} ph={ph} zoom={zoom} tx={tx} ty={ty} />
        ))}
      </View>
    </GestureDetector>
  );
}

/** Подпись контура — над ним, следует за увеличением и сдвигом; сама не растёт. */
function MarkLabel({ mark, w, h, pw, ph, zoom, tx, ty }: {
  mark: ImageMark; w: number; h: number; pw: number; ph: number; zoom: SharedValue<number>; tx: SharedValue<number>; ty: SharedValue<number>;
}) {
  const styles = useStyles();
  const [ax, ay] = mark.area.anchor;
  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: w / 2 + tx.value + zoom.value * (ax * pw - pw / 2) },
      { translateY: h / 2 + ty.value + zoom.value * (ay * ph - ph / 2) },
    ],
  }));
  return (
    <Animated.View pointerEvents="none" style={[styles.labelAt, style]}>
      <Text testID={`viewer-mark-${mark.f}`} style={styles.label}>{mark.label}</Text>
    </Animated.View>
  );
}

/** Разметка на снимке в карте и в разборе: контуры и подписи без увеличения, поверх рисунка шириной `w`. */
export function MarksOverlay({ marks, w, aspect }: { marks: readonly ImageMark[]; w: number; aspect: number }) {
  const styles = useStyles();
  const h = w * aspect;
  if (marks.length === 0) return null;
  return (
    <View pointerEvents="none" style={[styles.overlay, { width: w, height: h }]}>
      <Canvas style={{ width: w, height: h }}>
        <MarkPaths marks={marks} pw={w} ph={h} />
      </Canvas>
      {marks.map(m => (
        <View key={m.f} style={[styles.labelAt, { transform: [{ translateX: m.area.anchor[0] * w }, { translateY: m.area.anchor[1] * h }] }]}>
          <Text style={styles.label}>{m.label}</Text>
        </View>
      ))}
    </View>
  );
}

/** Значок «открыть крупно» в углу снимка: лупа на тёмной плашке. */
export function ZoomBadge() {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View style={styles.badge} aria-hidden importantForAccessibility="no-hide-descendants" pointerEvents="none">
      <Icon shape={ZOOM_ICON} size={20} color={theme.colors.onFilm} />
    </View>
  );
}

const useStyles = makeStyles(t => ({
  page: { flex: 1, backgroundColor: t.colors.film },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingHorizontal: space.l, paddingVertical: space.s },
  title: { flex: 1, fontSize: 16, lineHeight: 21, fontWeight: '600', color: t.colors.onFilm },
  close: { minHeight: 48, justifyContent: 'center', paddingHorizontal: space.m, borderRadius: t.shape.radius, borderWidth: 1, borderColor: t.colors.onFilmMuted },
  closeText: { fontSize: 15, fontWeight: '600', color: t.colors.onFilm },
  pressed: { opacity: 0.7 },
  field: { flex: 1, overflow: 'hidden' },
  notes: { flexGrow: 0, maxHeight: '36%' },
  notesContent: { gap: space.xs, paddingHorizontal: space.l, paddingVertical: space.m },
  task: { gap: space.s, alignItems: 'flex-start' },
  ask: { fontSize: 15, lineHeight: 21, fontWeight: '600', color: t.colors.onFilm },
  action: { minHeight: 48, justifyContent: 'center', paddingHorizontal: space.l, borderRadius: t.shape.radius, borderWidth: 1, borderColor: t.colors.onFilm },
  actionText: { fontSize: 15, fontWeight: '600', color: t.colors.onFilm },
  found: { fontSize: 15, lineHeight: 21, color: t.colors.onFilm },
  hint: { fontSize: 13, lineHeight: 18, color: t.colors.onFilmMuted },
  // подпись стоит над точкой контура, по середине: сдвиг на свою половину — в обёртке
  labelAt: { position: 'absolute', left: 0, top: 0 },
  label: {
    transform: [{ translateX: '-50%' }, { translateY: -30 }], fontSize: 13, fontWeight: '600', color: t.colors.onFilm,
    backgroundColor: t.colors.film, borderWidth: 1, borderColor: t.colors.onFilm, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden',
  },
  overlay: { position: 'absolute', left: 0, top: 0 },
  badge: {
    position: 'absolute', right: space.s, bottom: space.s, width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.film, opacity: 0.85,
  },
}));
