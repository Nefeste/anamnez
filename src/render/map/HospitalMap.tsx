// Карта больницы — прототип П2 (spec 2026-09-spikes): записанный пол, предметы и люди —
// пакетно через Atlas, камера жестами, счётчик кадров. Слабые телефоны — не цель
// (NFR-PRF-1): цель — ни одного подвисания на современных.
import { Atlas, Canvas, Group, Picture, Skia, useRSXformBuffer } from '@shopify/react-native-skia';
import { useEffect, useMemo } from 'react';
import { PixelRatio } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useDerivedValue, useFrameCallback, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import type { HospitalLayout } from '@/engine/hospital/grid';
import { bodyIndex, staffFigure } from './figures';
import { CELL_PX, recordFloor } from './floor';
import { angleOf, objectTurns } from './orient';
import { makePeople } from './people';
import { atlasPx, buildAtlas } from './sprites';
import { cellXform } from './xform';

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
  // атлас — под плотность экрана при двукратном приближении камеры
  const px = atlasPx(CELL_PX * (width / (layout.grid.w * CELL_PX)) * 2, PixelRatio.get());
  const atlas = useMemo(() => buildAtlas(px), [px]);
  const floor = useMemo(() => recordFloor(layout), [layout]);
  const turned = useMemo(() => objectTurns(layout.grid, layout.objects), [layout]);
  const objectSprites = useMemo(() => layout.objects.map(o => atlas.objectRect(o.kind)), [layout, atlas]);
  const objectXforms = useMemo(() => layout.objects.map((o, i) => Skia.RSXform(...cellXform(angleOf(turned[i]), o.x, o.y, px))), [layout, turned, px]);
  const routes = useMemo(() => makePeople(layout, people), [layout, people]);
  // 0 — врачи, 1 — медсёстры, дальше — пациенты в своей одежде; лица — из номера
  const figures = useMemo(
    () => routes.kinds.map((k, i) => (k === 0 ? staffFigure('doctor', `p${i}`) : k === 1 ? staffFigure('nurse', `p${i}`) : { ...staffFigure('staff', `p${i}`), body: bodyIndex({ clothes: i, urgency: 0 }) })),
    [routes],
  );
  const bodySprites = useMemo(() => figures.map(f => atlas.bodyRect(f.body)), [figures, atlas]);
  const headSprites = useMemo(() => figures.map(f => atlas.headRect(f.head)), [figures, atlas]);

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
    let turn = 0;
    if (last > 0) {
      let s = (clock.value * speed + phase) % (2 * last);
      // туда и обратно: на обратном пути повёрнут назад
      const back = s > last;
      if (back) s = 2 * last - s;
      const k = Math.min(last - 1, Math.floor(s));
      const f = s - k;
      const a = (off + k) * 2;
      const dx = pts[a + 2] - pts[a];
      const dy = pts[a + 3] - pts[a + 1];
      x = pts[a] + dx * f;
      y = pts[a + 1] + dy * f;
      turn = back ? Math.atan2(dx, -dy) : Math.atan2(-dx, dy);
    }
    const [sc, ss, tx, ty] = cellXform(turn, x, y, px, 1.15);
    val.set(sc, ss, tx, ty);
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
          <Atlas image={atlas.image} sprites={bodySprites} transforms={personXforms} />
          <Atlas image={atlas.image} sprites={headSprites} transforms={personXforms} />
        </Group>
      </Canvas>
    </GestureDetector>
  );
}
