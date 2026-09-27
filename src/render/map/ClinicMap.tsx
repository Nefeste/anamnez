// Карта амбулатории в смене (spec 2026-09-first-shift): план, персонал на местах, пациенты там,
// где их держит смена (src/state/clinicMap.ts). Кто куда идёт, решает Walkers (walkers.ts);
// где он на каждом кадре, считает ворклет на UI-потоке, как в прототипе П2
// (06-architecture.md §6). Касание выделяет человека — кто это, пишет экран смены; приглашённый
// идёт в кабинет, и карта сообщает, когда он вошёл.
import { Atlas, Canvas, Circle, Group, Picture, Skia, useRectBuffer, useRSXformBuffer } from '@shopify/react-native-skia';
import { useEffect, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useDerivedValue, useFrameCallback, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import type { ClinicLayout } from '@/engine/hospital/clinic';
import { T } from '@/i18n';
import type { Placement } from '@/state/clinicMap';
import { colors } from '@/ui/theme';
import { CELL_PX, recordFloor } from './floor';
import { buildAtlas, OBJECT_KINDS, SPRITE } from './sprites';
import { STRIDE, Walkers } from './walkers';

/** Сколько человек карта держит сразу: персонал и все, кто сейчас в амбулатории. */
const CAPACITY = 48;
/** Свободное место буфера — за краем карты. */
const HIDDEN = -1000;
/** Фигурки в текстуре — после предметов (sprites.ts). */
const PEOPLE_AT = OBJECT_KINDS.length;
/** Карта пациента открывается чуть позже, чем он дошёл: видно, что вошёл. */
const ENTER_MS = 150;

/** Где на кадре человек из места `i` буферов (в клетках); нет его или исчез у выхода — null. */
function pointAt(m: number[], pts: number[], i: number, clock: number): [number, number] | null {
  'worklet';
  const n = m[i * STRIDE + 1];
  if (n === 0) return null;
  const off = m[i * STRIDE];
  const last = n - 1;
  if (last === 0) return [pts[off * 2], pts[off * 2 + 1]];
  const s = Math.min(last, Math.max(0, (clock - m[i * STRIDE + 2]) * m[i * STRIDE + 3]));
  if (s >= last && m[i * STRIDE + 4] === 1) return null;
  const k = Math.min(last - 1, Math.floor(s));
  const f = s - k;
  const a = (off + k) * 2;
  return [pts[a] + (pts[a + 2] - pts[a]) * f, pts[a + 1] + (pts[a + 3] - pts[a + 1]) * f];
}

export function ClinicMap({ layout, people, width, active, label, selected, awaiting, onSelect, onArrive }: {
  layout: ClinicLayout;
  people: Placement[];
  width: number;
  /** экран на виду: иначе кадры не считаются */
  active: boolean;
  label: string;
  /** выделенный касанием — обведён */
  selected?: string;
  /** приглашённый: когда дойдёт до кабинета — onArrive */
  awaiting?: string;
  onSelect: (id: string | undefined) => void;
  onArrive: (id: string) => void;
}) {
  const atlas = useMemo(() => buildAtlas(), []);
  const floor = useMemo(() => recordFloor(layout), [layout]);
  const objectSprites = useMemo(() => layout.objects.map(o => atlas.objectRect(o.kind)), [layout, atlas]);
  const objectXforms = useMemo(() => layout.objects.map(o => Skia.RSXform(CELL_PX / SPRITE, 0, o.x * CELL_PX, o.y * CELL_PX)), [layout]);
  // свой план песочницы меняется между сменами — с ним и ходоки: новые расставят всех по местам
  const walkers = useMemo(() => new Walkers(layout, CAPACITY), [layout]);
  const scale = width / (layout.grid.w * CELL_PX);
  const height = layout.grid.h * CELL_PX * scale;
  const cell = CELL_PX * scale;

  // часы карты — секунды, пока экран на виду и кто-то идёт; пути, места и фигурки — на UI-поток
  const clock = useSharedValue(0);
  const until = useSharedValue(0);
  const route = useSharedValue<number[]>([]);
  const meta = useSharedValue<number[]>(new Array(CAPACITY * STRIDE).fill(0));
  const figures = useSharedValue<number[]>(new Array(CAPACITY).fill(0));
  const chosen = useSharedValue(-1);

  // все дошли — часы стоят, общие значения не меняются, и Skia кадров не рисует (§6)
  const frame = useFrameCallback(info => {
    'worklet';
    if (clock.value >= until.value) return;
    clock.value = Math.min(until.value, clock.value + Math.min(info.timeSincePreviousFrame ?? 0, 100) / 1000);
  }, false);
  useEffect(() => {
    frame.setActive(active);
  }, [frame, active]);

  useEffect(() => {
    const f = walkers.sync(people, clock.get());
    if (f.changed) {
      route.set(f.route);
      meta.set(f.meta);
      figures.set(f.sprites);
      until.set(f.until);
    }
    chosen.set(walkers.slotOf(selected));
  }, [people, selected, walkers, clock, until, route, meta, figures, chosen]);

  // приглашённый дошёл до кабинета — пора открывать его карту; его нет на карте — сразу
  useEffect(() => {
    if (awaiting === undefined) return;
    const at = walkers.arrivalOf(awaiting);
    const ms = at === undefined ? 0 : Math.max(0, (at - clock.get()) * 1000) + ENTER_MS;
    const timer = setTimeout(() => onArrive(awaiting), ms);
    return () => clearTimeout(timer);
  }, [awaiting, people, walkers, clock, onArrive]);

  const personSprites = useRectBuffer(CAPACITY, (rect, i) => {
    'worklet';
    rect.setXYWH((PEOPLE_AT + figures.value[i]) * SPRITE, 0, SPRITE, SPRITE);
  });
  const personXforms = useRSXformBuffer(CAPACITY, (val, i) => {
    'worklet';
    const p = pointAt(meta.value, route.value, i, clock.value);
    if (p) val.set(CELL_PX / SPRITE, 0, p[0] * CELL_PX, p[1] * CELL_PX);
    else val.set(CELL_PX / SPRITE, 0, HIDDEN, HIDDEN);
  });
  // выделенный — в кольце, и кольцо идёт вместе с ним
  const ringX = useDerivedValue(() => {
    const p = chosen.value < 0 ? null : pointAt(meta.value, route.value, chosen.value, clock.value);
    return p ? (p[0] + 0.5) * CELL_PX : HIDDEN;
  });
  const ringY = useDerivedValue(() => {
    const p = chosen.value < 0 ? null : pointAt(meta.value, route.value, chosen.value, clock.value);
    return p ? (p[1] + 0.5) * CELL_PX : HIDDEN;
  });

  // касание: ближайший к точке — не дальше клетки; мимо всех — снять выделение
  const onTap = (x: number, y: number) => {
    onSelect(walkers.hit(x / cell, y / cell, clock.get()));
  };
  const tap = Gesture.Tap().onEnd(e => {
    'worklet';
    scheduleOnRN(onTap, e.x, e.y);
  });

  return (
    <View testID="clinic-map" accessible accessibilityLabel={label} style={{ width, height }}>
      <GestureDetector gesture={tap}>
        <Canvas style={{ width, height }}>
          <Group transform={[{ scale }]}>
            <Picture picture={floor} />
            <Atlas image={atlas.image} sprites={objectSprites} transforms={objectXforms} />
            <Circle cx={ringX} cy={ringY} r={CELL_PX * 0.78} color={colors.accentSoft} />
            <Circle cx={ringX} cy={ringY} r={CELL_PX * 0.78} style="stroke" strokeWidth={CELL_PX * 0.12} color={colors.accent} />
            <Atlas image={atlas.image} sprites={personSprites} transforms={personXforms} />
          </Group>
        </Canvas>
      </GestureDetector>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        {layout.rooms.map(r => (
          <Text
            key={r.id}
            numberOfLines={1}
            style={[styles.room, { left: (r.x + 1) * cell + 1, top: (r.y + 1) * cell, maxWidth: (r.w - 1.2) * cell, fontSize: label8(cell) }]}>
            {T.shift.map.rooms[r.type]}
          </Text>
        ))}
      </View>
    </View>
  );
}

/** Подпись помещения — по размеру клетки: «Регистратура» помещается и на узком телефоне. */
const label8 = (cell: number) => Math.max(6.5, cell * 0.6);

const styles = StyleSheet.create({
  room: { position: 'absolute', fontWeight: '600', color: colors.muted },
});
