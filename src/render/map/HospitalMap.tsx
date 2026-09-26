// Карта больницы — прототип П2 (spec 2026-09-spikes): записанный пол, предметы и люди —
// пакетно через Atlas, камера жестами, счётчик кадров. Слабые телефоны — не цель
// (NFR-PRF-1): цель — ни одного подвисания на современных.
import { Atlas, Canvas, Group, Picture, Skia, useRSXformBuffer } from '@shopify/react-native-skia';
import { useEffect, useMemo } from 'react';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useDerivedValue, useFrameCallback, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import type { HospitalLayout } from '@/engine/hospital/grid';
import { CELL_PX, recordFloor } from './floor';
import { makePeople } from './people';
import { buildAtlas, SPRITE } from './sprites';

export interface FrameStats {
  fps: number;
  worstMs: number;
}

export function HospitalMap({ layout, width, height, people = 60, paused, onCell, onStats }: {
  layout: HospitalLayout;
  width: number;
  height: number;
  people?: number;
  paused: boolean;
  onCell: (x: number, y: number) => void;
  onStats: (s: FrameStats) => void;
}) {
  const atlas = useMemo(() => buildAtlas(), []);
  const floor = useMemo(() => recordFloor(layout), [layout]);
  const objectSprites = useMemo(() => layout.objects.map(o => atlas.objectRect(o.kind)), [layout, atlas]);
  const objectXforms = useMemo(() => layout.objects.map(o => Skia.RSXform(CELL_PX / SPRITE, 0, o.x * CELL_PX, o.y * CELL_PX)), [layout]);
  const routes = useMemo(() => makePeople(layout, people), [layout, people]);
  const personSprites = useMemo(() => routes.kinds.map(k => atlas.personRect(k)), [routes, atlas]);

  // Игровые часы для ворклета и маршруты на UI-потоке.
  const clock = useSharedValue(0);
  const points = useSharedValue(routes.points);
  const meta = useSharedValue(routes.meta);
  const frames = useSharedValue(0);
  const worst = useSharedValue(0);
  const windowStart = useSharedValue(0);

  const frame = useFrameCallback(info => {
    'worklet';
    clock.value = info.timestamp / 1000;
    const dt = info.timeSincePreviousFrame ?? 16;
    frames.value += 1;
    if (dt > worst.value) worst.value = dt;
    if (windowStart.value === 0) windowStart.value = info.timestamp;
    const span = info.timestamp - windowStart.value;
    if (span >= 1000) {
      scheduleOnRN(onStats, { fps: Math.round((frames.value * 1000) / span), worstMs: worst.value });
      frames.value = 0;
      worst.value = 0;
      windowStart.value = info.timestamp;
    }
  }, false);

  useEffect(() => {
    frame.setActive(!paused);
  }, [frame, paused]);

  const cell = CELL_PX;
  const scale = CELL_PX / SPRITE;
  const personXforms = useRSXformBuffer(routes.count, (val, i) => {
    'worklet';
    const m = meta.value;
    const off = m[i * 4];
    const n = m[i * 4 + 1];
    const speed = m[i * 4 + 2];
    const phase = m[i * 4 + 3];
    const last = n - 1;
    const pts = points.value;
    let x = pts[off * 2];
    let y = pts[off * 2 + 1];
    if (last > 0) {
      let s = (clock.value * speed + phase) % (2 * last);
      if (s > last) s = 2 * last - s;
      const k = Math.min(last - 1, Math.floor(s));
      const f = s - k;
      const a = (off + k) * 2;
      x = pts[a] + (pts[a + 2] - pts[a]) * f;
      y = pts[a + 1] + (pts[a + 3] - pts[a + 1]) * f;
    }
    val.set(scale, 0, x * cell, y * cell);
  });

  // Камера: сначала вся карта по ширине.
  const fit = width / (layout.grid.w * CELL_PX);
  const zoom = useSharedValue(fit);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const transform = useDerivedValue(() => [{ translateX: tx.value }, { translateY: ty.value }, { scale: zoom.value }]);

  // get()/set() вместо .value: так React Compiler понимает, что это не состояние React.
  const pan = Gesture.Pan().onChange(e => {
    'worklet';
    tx.set(tx.get() + e.changeX);
    ty.set(ty.get() + e.changeY);
  });
  const pinch = Gesture.Pinch().onChange(e => {
    'worklet';
    const z = zoom.get();
    const next = Math.min(4, Math.max(fit * 0.8, z * e.scaleChange));
    tx.set(e.focalX - ((e.focalX - tx.get()) * next) / z);
    ty.set(e.focalY - ((e.focalY - ty.get()) * next) / z);
    zoom.set(next);
  });
  const tap = Gesture.Tap().onEnd(e => {
    'worklet';
    const wx = (e.x - tx.get()) / zoom.get();
    const wy = (e.y - ty.get()) / zoom.get();
    scheduleOnRN(onCell, Math.floor(wx / cell), Math.floor(wy / cell));
  });
  const gesture = Gesture.Race(tap, Gesture.Simultaneous(pan, pinch));

  return (
    <GestureDetector gesture={gesture}>
      <Canvas style={{ width, height }}>
        <Group transform={transform}>
          <Picture picture={floor} />
          <Atlas image={atlas.image} sprites={objectSprites} transforms={objectXforms} />
          <Atlas image={atlas.image} sprites={personSprites} transforms={personXforms} />
        </Group>
      </Canvas>
    </GestureDetector>
  );
}
