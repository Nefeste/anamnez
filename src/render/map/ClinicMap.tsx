// Карта амбулатории в смене (spec 2026-09-first-shift): план, персонал на местах, пациенты там,
// где их держит смена (src/state/clinicMap.ts). Кто куда идёт, решает Walkers (walkers.ts);
// где он на каждом кадре, считает ворклет на UI-потоке, как в прототипе П2
// (06-architecture.md §6). Касание по ждущему в зале — вызвать его.
import { Atlas, Canvas, Group, Picture, Skia, useRectBuffer, useRSXformBuffer } from '@shopify/react-native-skia';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useFrameCallback, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import type { ClinicLayout } from '@/engine/hospital/clinic';
import { T } from '@/i18n';
import type { Placement } from '@/state/clinicMap';
import { colors } from '@/ui/theme';
import { CELL_PX, recordFloor } from './floor';
import { buildAtlas, OBJECT_KINDS, SPRITE } from './sprites';
import { SPEED, Walkers } from './walkers';

/** Сколько человек карта держит сразу: персонал и все, кто сейчас в амбулатории. */
const CAPACITY = 48;
/** Свободное место буфера — за краем карты. */
const HIDDEN = -1000;
/** Фигурки в текстуре — после предметов (sprites.ts). */
const PEOPLE_AT = OBJECT_KINDS.length;

export function ClinicMap({ layout, people, width, active, label, onCall }: {
  layout: ClinicLayout;
  people: Placement[];
  width: number;
  /** экран на виду: иначе кадры не считаются */
  active: boolean;
  label: string;
  onCall: (id: string) => void;
}) {
  const atlas = useMemo(() => buildAtlas(), []);
  const floor = useMemo(() => recordFloor(layout), [layout]);
  const objectSprites = useMemo(() => layout.objects.map(o => atlas.objectRect(o.kind)), [layout, atlas]);
  const objectXforms = useMemo(() => layout.objects.map(o => Skia.RSXform(CELL_PX / SPRITE, 0, o.x * CELL_PX, o.y * CELL_PX)), [layout]);
  const [walkers] = useState(() => new Walkers(layout, CAPACITY));
  const scale = width / (layout.grid.w * CELL_PX);
  const height = layout.grid.h * CELL_PX * scale;
  const cell = CELL_PX * scale;

  // часы карты — секунды, пока экран на виду и кто-то идёт; пути, места и фигурки — на UI-поток
  const clock = useSharedValue(0);
  const until = useSharedValue(0);
  const route = useSharedValue<number[]>([]);
  const meta = useSharedValue<number[]>(new Array(CAPACITY * 3).fill(0));
  const figures = useSharedValue<number[]>(new Array(CAPACITY).fill(0));

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
    if (!f.changed) return;
    route.set(f.route);
    meta.set(f.meta);
    figures.set(f.sprites);
    until.set(f.until);
  }, [people, walkers, clock, until, route, meta, figures]);

  const personSprites = useRectBuffer(CAPACITY, (rect, i) => {
    'worklet';
    rect.setXYWH((PEOPLE_AT + figures.value[i]) * SPRITE, 0, SPRITE, SPRITE);
  });
  const personXforms = useRSXformBuffer(CAPACITY, (val, i) => {
    'worklet';
    const m = meta.value;
    const n = m[i * 3 + 1];
    if (n === 0) {
      val.set(CELL_PX / SPRITE, 0, HIDDEN, HIDDEN);
      return;
    }
    const off = m[i * 3];
    const pts = route.value;
    const last = n - 1;
    let x = pts[off * 2];
    let y = pts[off * 2 + 1];
    if (last > 0) {
      const s = Math.min(last, Math.max(0, (clock.value - m[i * 3 + 2]) * SPEED));
      const k = Math.min(last - 1, Math.floor(s));
      const f = s - k;
      const a = (off + k) * 2;
      x = pts[a] + (pts[a + 2] - pts[a]) * f;
      y = pts[a + 1] + (pts[a + 3] - pts[a + 1]) * f;
    }
    val.set(CELL_PX / SPRITE, 0, x * CELL_PX, y * CELL_PX);
  });

  // касание: ближайший из ждущих в зале — не дальше клетки
  const onTap = (x: number, y: number) => {
    const id = walkers.hit(x / (CELL_PX * scale), y / (CELL_PX * scale), clock.get());
    if (id) onCall(id);
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
