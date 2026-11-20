// Снимок крупно (spec 2026-11-xray): касание снимка в карте пациента открывает его на весь экран, на чёрном фоне
// негатоскопа. Двумя пальцами — увеличить и сдвинуть, двойное касание — ближе к этому месту или обратно; внизу — что
// нашли. Рисунок тот же, что в карте, — запись Skia (ADR 0013), только шире: увеличение — преобразованием холста, поэтому
// линии остаются чёткими. Modal — отдельное окно: свои корни жестов и системных отступов.
import { Canvas, Group, Picture, rect, type SkPicture } from '@shopify/react-native-skia';
import { useMemo, useState } from 'react';
import { type LayoutChangeEvent, Modal, Pressable, ScrollView, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useDerivedValue, useSharedValue, withTiming } from 'react-native-reanimated';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { T } from '@/i18n';
import type { Line } from '@/state/caseView';
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

type Props = { visible: boolean; onClose: () => void; title: string; picture: ViewerPicture; lines: readonly Line[] };

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

function ViewerBody({ onClose, title, picture, lines }: Props) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const t = T.spikes.patient.viewer;
  const [box, setBox] = useState<{ w: number; h: number } | undefined>();
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (!box || box.w !== width || box.h !== height) setBox({ w: width, h: height });
  };
  const found = lines.filter(l => l.shown);
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
        {box && <ZoomPicture w={box.w} h={box.h} picture={picture} />}
      </View>
      <ScrollView style={styles.notes} contentContainerStyle={styles.notesContent}>
        {found.length > 0 && <Text style={styles.found}>{`${t.found}: ${found.map(l => l.text).join('; ')}`}</Text>}
        {picture.sideMark && <Text style={styles.hint}>{t.side}</Text>}
        <Text style={styles.hint}>{t.hint}</Text>
      </ScrollView>
    </View>
  );
}

/** Снимок во всё поле: вписан целиком, жесты двигают и увеличивают его внутри холста. */
function ZoomPicture({ w, h, picture }: { w: number; h: number; picture: ViewerPicture }) {
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
  const gesture = Gesture.Race(doubleTap, Gesture.Simultaneous(pinch, pan));
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
          </Group>
        </Canvas>
      </View>
    </GestureDetector>
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
  notes: { flexGrow: 0, maxHeight: '30%' },
  notesContent: { gap: space.xs, paddingHorizontal: space.l, paddingVertical: space.m },
  found: { fontSize: 15, lineHeight: 21, color: t.colors.onFilm },
  hint: { fontSize: 13, lineHeight: 18, color: t.colors.onFilmMuted },
  badge: {
    position: 'absolute', right: space.s, bottom: space.s, width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.film, opacity: 0.85,
  },
}));
