// План своей больницы на экране стройки (spec 2026-09-own-hospital, часть 7): те же пол, стены и
// предметы, что у карты смены (floor.ts, sprites.ts), плюс камера — пан одним пальцем, масштаб
// двумя, двойное касание приближает (03-game-design.md §7), — сетка клеток, «призрак» помещения
// и кисть коридора. Камера — общие значения Reanimated: жесты двигают её на UI-потоке, а JS
// узнаёт только клетки — куда тянут помещение, где провели кистью, чего коснулись.
import { Atlas, Canvas, Group, Path, Picture, Rect, Skia, usePathValue } from '@shopify/react-native-skia';
import { useEffect, useMemo } from 'react';
// подписи — часть рисунка плана и растут вместе с ним, поэтому без настройки размера текста (как в ClinicMap)
import { StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useDerivedValue, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import type { Cell } from '@/content/types';
import type { Plan } from '@/engine/hospital/build';
import { colors } from '@/ui/theme';
import { CELL_PX, recordFloor, recordGridLines } from './floor';
import { buildAtlas, SPRITE } from './sprites';

export type Tool = 'look' | 'room' | 'corridor' | 'erase';

/** Помещение, которое ставят: угол и размер на участке, дверная сторона, где не помещается. */
export interface Ghost {
  x: number;
  y: number;
  w: number;
  h: number;
  /** дверная сторона — клетки стены, где встанет дверь */
  door: Cell[];
  blocked: Cell[];
  ok: boolean;
}

export interface RoomLabel {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  /** не работает — рядом с подписью красная метка */
  down: boolean;
}

/** Во сколько раз можно приблизить план против «весь участок на экране». */
const MAX_ZOOM = 5;
const RED = '#C8453C';

/**
 * Кисть: к клеткам x0, y0, x1, y1… добавить путь до (x, y) — по сторонам, без диагоналей и
 * пропусков: коридор должен быть связным, даже если палец летел быстро.
 */
function strokeTo(flat: number[], x: number, y: number): number[] {
  'worklet';
  const out = flat.slice();
  if (out.length === 0) {
    out.push(x, y);
    return out;
  }
  let cx = out[out.length - 2];
  let cy = out[out.length - 1];
  while (cx !== x || cy !== y) {
    if (Math.abs(x - cx) >= Math.abs(y - cy)) cx += Math.sign(x - cx);
    else cy += Math.sign(y - cy);
    out.push(cx, cy);
  }
  return out;
}

/** Сдвиг камеры: план меньше экрана — посередине; больше — за край не дальше четверти экрана. */
function clampPan(v: number, size: number, view: number, z: number): number {
  'worklet';
  const len = size * z;
  if (len <= view) return (view - len) / 2;
  return Math.min(view / 4, Math.max(view - len - view / 4, v));
}

export function BuildMap({ plan, width, height, tool, ghost, selected, labels, label, onGhostMove, onStroke, onTapCell, still, testID = 'build-map' }: {
  plan: Plan;
  testID?: string;
  /** только посмотреть: без жестов (план на экране между сменами) */
  still?: boolean;
  width: number;
  height: number;
  tool: Tool;
  ghost?: Ghost;
  /** выделенное касанием помещение — обведено */
  selected?: string;
  labels: RoomLabel[];
  /** что это — для чтения с экрана */
  label: string;
  onGhostMove: (x: number, y: number) => void;
  /** кисть отпустили: клетки, по которым провели */
  onStroke: (cells: Cell[]) => void;
  onTapCell: (x: number, y: number) => void;
}) {
  const atlas = useMemo(() => buildAtlas(), []);
  const floor = useMemo(() => recordFloor(plan), [plan]);
  const lines = useMemo(() => recordGridLines(plan.grid.w, plan.grid.h), [plan.grid.w, plan.grid.h]);
  const objectSprites = useMemo(() => plan.objects.map(o => atlas.objectRect(o.kind)), [plan, atlas]);
  const objectXforms = useMemo(() => plan.objects.map(o => Skia.RSXform(CELL_PX / SPRITE, 0, o.x * CELL_PX, o.y * CELL_PX)), [plan]);

  const plotW = plan.grid.w * CELL_PX;
  const plotH = plan.grid.h * CELL_PX;
  const fit = Math.min(width / plotW, height / plotH);
  const zoom = useSharedValue(fit);
  const tx = useSharedValue((width - plotW * fit) / 2);
  const ty = useSharedValue((height - plotH * fit) / 2);
  // размер окна изменился — весь участок снова на экране
  useEffect(() => {
    zoom.set(fit);
    tx.set((width - plotW * fit) / 2);
    ty.set((height - plotH * fit) / 2);
  }, [fit, width, height, plotW, plotH, zoom, tx, ty]);

  // жест: 0 — камера, 1 — тянут помещение, 2 — кисть; начало жеста — сдвиг, масштаб, точка
  const drag = useSharedValue(0);
  const grab = useSharedValue<number[]>([0, 0]);
  const last = useSharedValue<number[]>([-1, -1]);
  const start = useSharedValue<number[]>([0, 0, 1, 0, 0]);
  // кисть — на UI-потоке: клетки x0, y0, x1, y1…; отпустили — JS получает их разом
  const stroke = useSharedValue<number[]>([]);
  const painted = usePathValue(b => {
    'worklet';
    const s = stroke.get();
    for (let i = 0; i < s.length; i += 2) b.addRect(Skia.XYWHRect(s[i] * CELL_PX, s[i + 1] * CELL_PX, CELL_PX, CELL_PX));
  });

  const strokeEnd = (flat: number[]) => {
    const cells: Cell[] = [];
    for (let i = 0; i < flat.length; i += 2) cells.push([flat[i], flat[i + 1]]);
    if (cells.length > 0) onStroke(cells);
  };
  const ghostTo = (x: number, y: number) => onGhostMove(x, y);
  const tapAt = (x: number, y: number) => onTapCell(x, y);

  const brush = tool === 'corridor' || tool === 'erase';
  const g = ghost;
  const cellX = (sx: number) => {
    'worklet';
    return Math.floor((sx - tx.get()) / zoom.get() / CELL_PX);
  };
  const cellY = (sy: number) => {
    'worklet';
    return Math.floor((sy - ty.get()) / zoom.get() / CELL_PX);
  };

  const pan = Gesture.Pan()
    .enabled(!still)
    .maxPointers(1)
    .minDistance(brush ? 2 : 6)
    .onStart(e => {
      'worklet';
      // где палец опустился: жест начинается, когда он уже немного сдвинулся
      const cx = cellX(e.x - e.translationX);
      const cy = cellY(e.y - e.translationY);
      if (tool === 'room' && g && cx >= g.x && cy >= g.y && cx < g.x + g.w && cy < g.y + g.h) {
        drag.set(1);
        grab.set([cx - g.x, cy - g.y]);
        last.set([g.x, g.y]);
      } else if (brush) {
        drag.set(2);
        last.set([cx, cy]);
        stroke.set([cx, cy]);
      } else {
        drag.set(0);
        start.set([tx.get(), ty.get(), zoom.get(), 0, 0]);
      }
    })
    .onUpdate(e => {
      'worklet';
      if (drag.get() === 0) {
        const s0 = start.get();
        tx.set(clampPan(s0[0] + e.translationX, plotW, width, zoom.get()));
        ty.set(clampPan(s0[1] + e.translationY, plotH, height, zoom.get()));
        return;
      }
      const cx = cellX(e.x);
      const cy = cellY(e.y);
      const [lx, ly] = last.get();
      if (drag.get() === 1) {
        const [gx, gy] = grab.get();
        if (cx - gx !== lx || cy - gy !== ly) {
          last.set([cx - gx, cy - gy]);
          scheduleOnRN(ghostTo, cx - gx, cy - gy);
        }
      } else if (cx !== lx || cy !== ly) {
        last.set([cx, cy]);
        stroke.set(strokeTo(stroke.get(), cx, cy));
      }
    })
    .onFinalize(() => {
      'worklet';
      if (drag.get() === 2) {
        scheduleOnRN(strokeEnd, stroke.get());
        stroke.set([]);
      }
      drag.set(0);
    });

  // два пальца: масштаб вокруг точки между ними, и их сдвиг двигает план
  const pinch = Gesture.Pinch()
    .enabled(!still)
    .onStart(e => {
      'worklet';
      start.set([tx.get(), ty.get(), zoom.get(), e.focalX, e.focalY]);
    })
    .onUpdate(e => {
      'worklet';
      const s0 = start.get();
      const z = Math.min(fit * MAX_ZOOM, Math.max(fit * 0.9, s0[2] * e.scale));
      const k = z / s0[2];
      zoom.set(z);
      tx.set(clampPan(e.focalX - (s0[3] - s0[0]) * k, plotW, width, z));
      ty.set(clampPan(e.focalY - (s0[4] - s0[1]) * k, plotH, height, z));
    });

  const tap = Gesture.Tap()
    .enabled(!still)
    .maxDistance(8)
    .onEnd((e, ok) => {
      'worklet';
      if (ok) scheduleOnRN(tapAt, cellX(e.x), cellY(e.y));
    });
  const doubleTap = Gesture.Tap()
    .enabled(!still)
    .numberOfTaps(2)
    .onEnd((e, ok) => {
      'worklet';
      if (!ok) return;
      const z = Math.min(fit * MAX_ZOOM, zoom.get() * 2);
      const k = z / zoom.get();
      tx.set(withTiming(clampPan(e.x - (e.x - tx.get()) * k, plotW, width, z)));
      ty.set(withTiming(clampPan(e.y - (e.y - ty.get()) * k, plotH, height, z)));
      zoom.set(withTiming(z));
    });
  const gesture = Gesture.Simultaneous(pan, pinch, Gesture.Exclusive(doubleTap, tap));

  const transform = useDerivedValue(() => [{ translateX: tx.get() }, { translateY: ty.get() }, { scale: zoom.get() }]);
  const overlay = useAnimatedStyle(() => ({ transform: [{ translateX: tx.get() }, { translateY: ty.get() }, { scale: zoom.get() }] }));

  const hatch = useMemo(() => {
    const p = Skia.Path.Make();
    for (const [x, y] of ghost?.blocked ?? []) {
      p.moveTo(x * CELL_PX, y * CELL_PX);
      p.lineTo((x + 1) * CELL_PX, (y + 1) * CELL_PX);
      p.moveTo((x + 1) * CELL_PX, y * CELL_PX);
      p.lineTo(x * CELL_PX, (y + 1) * CELL_PX);
    }
    return p;
  }, [ghost]);
  const ok = !!ghost && ghost.ok;
  const chosen = plan.rooms.find(r => r.id === selected);

  return (
    <View testID={testID} accessible accessibilityLabel={label} style={[styles.box, { width, height }]}>
      <GestureDetector gesture={gesture}>
        <Canvas style={{ width, height }}>
          <Group transform={transform}>
            <Picture picture={floor} />
            <Picture picture={lines} />
            <Atlas image={atlas.image} sprites={objectSprites} transforms={objectXforms} />
            {chosen && (
              <Rect x={chosen.x * CELL_PX} y={chosen.y * CELL_PX} width={chosen.w * CELL_PX} height={chosen.h * CELL_PX} style="stroke" strokeWidth={2.5} color={colors.accent} />
            )}
            <Path path={painted} color={tool === 'erase' ? 'rgba(200, 69, 60, 0.45)' : 'rgba(26, 138, 134, 0.45)'} />
            {ghost && (
              <Group>
                <Rect x={ghost.x * CELL_PX} y={ghost.y * CELL_PX} width={ghost.w * CELL_PX} height={ghost.h * CELL_PX} color={ok ? 'rgba(26, 138, 134, 0.28)' : 'rgba(200, 69, 60, 0.2)'} />
                <Rect x={ghost.x * CELL_PX} y={ghost.y * CELL_PX} width={ghost.w * CELL_PX} height={ghost.h * CELL_PX} style="stroke" strokeWidth={2} color={ok ? colors.accent : RED} />
                {ghost.door.map(([x, y]) => (
                  <Rect key={`${x},${y}`} x={x * CELL_PX + 2} y={y * CELL_PX + 2} width={CELL_PX - 4} height={CELL_PX - 4} color={ok ? colors.accent : RED} />
                ))}
                <Path path={hatch} style="stroke" strokeWidth={1.5} color={RED} />
              </Group>
            )}
          </Group>
        </Canvas>
      </GestureDetector>
      <Animated.View pointerEvents="none" style={[styles.overlay, { width: plotW, height: plotH }, overlay]}>
        {labels.map(l => (
          <View key={l.id} style={[styles.label, { left: (l.x + 1) * CELL_PX, top: (l.y + 1) * CELL_PX, maxWidth: (l.w - 1.2) * CELL_PX }]}>
            {l.down && <View style={styles.down} />}
            <Text numberOfLines={1} style={[styles.name, l.down && { color: RED }]}>{l.name}</Text>
          </View>
        ))}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { overflow: 'hidden', backgroundColor: '#DDE4E3' },
  overlay: { position: 'absolute', left: 0, top: 0, transformOrigin: 'left top' },
  label: { position: 'absolute', flexDirection: 'row', alignItems: 'center' },
  down: { width: 5, height: 5, borderRadius: 3, backgroundColor: RED, marginRight: 2 },
  name: { fontSize: 8.5, fontWeight: '600', color: colors.muted },
});
