// Карта амбулатории в смене (spec 2026-09-first-shift): план, персонал на местах, пациенты там,
// где их держит смена (src/state/clinicMap.ts). Кто куда идёт, решает Walkers (walkers.ts);
// где он на каждом кадре и куда повёрнут, считает ворклет на UI-потоке, как в прототипе П2
// (06-architecture.md §6). Люди — два слоя атласа с одной матрицей: тела и головы
// (spec 2026-09-living-map). Касание выделяет человека — кто это, пишет экран смены;
// приглашённый идёт в кабинет, и карта сообщает, когда он вошёл.
import { Atlas, Canvas, Circle, Group, Picture, Rect, Skia, useRectBuffer, useRSXformBuffer } from '@shopify/react-native-skia';
import { useEffect, useMemo } from 'react';
import { PixelRatio, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useDerivedValue, useFrameCallback, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import type { ClinicLayout } from '@/engine/hospital/clinic';
import { T } from '@/i18n';
import type { Placement } from '@/state/clinicMap';
import { colors } from '@/ui/theme';
import { CELL_PX, recordFloor } from './floor';
import { doorOnTop, roomLabel } from './labels';
import { angleOf, objectTurns } from './orient';
import { atlasPx, BODY_AT, buildAtlas, COLS, HEAD_AT } from './sprites';
import { STRIDE, Walkers } from './walkers';
import { cellXform } from './xform';

/** Сколько человек карта держит сразу: персонал и все, кто сейчас в амбулатории. */
const CAPACITY = 48;
/** Свободное место буфера — за краем карты. */
const HIDDEN = -1000;
/** Карта пациента открывается чуть позже, чем он дошёл: видно, что вошёл. */
const ENTER_MS = 150;
/** Люди чуть крупнее клетки — их видно лучше мебели. */
const FIGURE = 1.15;

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

/** Куда повёрнут на кадре человек из места `i`: поворот отрезка, по которому идёт, или остановки. */
function turnAt(m: number[], turns: number[], i: number, clock: number): number {
  'worklet';
  const off = m[i * STRIDE];
  const last = m[i * STRIDE + 1] - 1;
  if (last <= 0) return turns[off] ?? 0;
  const s = Math.min(last, Math.max(0, (clock - m[i * STRIDE + 2]) * m[i * STRIDE + 3]));
  return turns[off + Math.min(last, Math.floor(s))] ?? 0;
}

export function ClinicMap({ layout, people, width, active, label, selected, awaiting, onSelect, onArrive, room, onRoom }: {
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
  /** выбранное касанием помещение — обведено (своя больница) */
  room?: string;
  /** коснулись помещения мимо людей; нет — касание помещений не нужно (практика) */
  onRoom?: (id: string | undefined) => void;
}) {
  const scale = width / (layout.grid.w * CELL_PX);
  const height = layout.grid.h * CELL_PX * scale;
  const cell = CELL_PX * scale;
  // атлас — под плотность экрана: клетка на экране — столько-то точек, рисунок — в полтора раза крупнее
  const px = atlasPx(cell, PixelRatio.get());
  const atlas = useMemo(() => buildAtlas(px), [px]);
  const floor = useMemo(() => recordFloor(layout), [layout]);
  const turned = useMemo(() => objectTurns(layout.grid, layout.objects, layout.staff.map(s => s.cell)), [layout]);
  const objectSprites = useMemo(() => layout.objects.map(o => atlas.objectRect(o.kind)), [layout, atlas]);
  const objectXforms = useMemo(() => layout.objects.map((o, i) => Skia.RSXform(...cellXform(angleOf(turned[i]), o.x, o.y, px))), [layout, turned, px]);
  // свой план песочницы меняется между сменами — с ним и ходоки: новые расставят всех по местам
  const walkers = useMemo(() => new Walkers(layout, CAPACITY), [layout]);

  // часы карты — секунды, пока экран на виду и кто-то идёт; пути, повороты, места и фигурки — на UI-поток
  const clock = useSharedValue(0);
  const until = useSharedValue(0);
  const route = useSharedValue<number[]>([]);
  const turns = useSharedValue<number[]>([]);
  const meta = useSharedValue<number[]>(new Array(CAPACITY * STRIDE).fill(0));
  const bodies = useSharedValue<number[]>(new Array(CAPACITY).fill(0));
  const heads = useSharedValue<number[]>(new Array(CAPACITY).fill(0));
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
      turns.set(f.turns);
      meta.set(f.meta);
      bodies.set(f.bodies);
      heads.set(f.heads);
      until.set(f.until);
    }
    chosen.set(walkers.slotOf(selected));
  }, [people, selected, walkers, clock, until, route, turns, meta, bodies, heads, chosen]);

  // приглашённый дошёл до кабинета — пора открывать его карту; его нет на карте — сразу
  useEffect(() => {
    if (awaiting === undefined) return;
    const at = walkers.arrivalOf(awaiting);
    const ms = at === undefined ? 0 : Math.max(0, (at - clock.get()) * 1000) + ENTER_MS;
    const timer = setTimeout(() => onArrive(awaiting), ms);
    return () => clearTimeout(timer);
  }, [awaiting, people, walkers, clock, onArrive]);

  const bodySprites = useRectBuffer(CAPACITY, (rect, i) => {
    'worklet';
    const n = BODY_AT + bodies.value[i];
    rect.setXYWH((n % COLS) * px, Math.floor(n / COLS) * px, px, px);
  });
  const headSprites = useRectBuffer(CAPACITY, (rect, i) => {
    'worklet';
    const n = HEAD_AT + heads.value[i];
    rect.setXYWH((n % COLS) * px, Math.floor(n / COLS) * px, px, px);
  });
  const personXforms = useRSXformBuffer(CAPACITY, (val, i) => {
    'worklet';
    const p = pointAt(meta.value, route.value, i, clock.value);
    if (!p) {
      val.set(CELL_PX / px, 0, HIDDEN, HIDDEN);
      return;
    }
    const [sc, ss, tx, ty] = cellXform(turnAt(meta.value, turns.value, i, clock.value), p[0], p[1], px, FIGURE);
    val.set(sc, ss, tx, ty);
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

  // касание: ближайший к точке — не дальше клетки; мимо всех — помещение под пальцем (своя
  // больница) или снять выделение
  const onTap = (x: number, y: number) => {
    const who = walkers.hit(x / cell, y / cell, clock.get());
    onSelect(who);
    if (!onRoom) return;
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    onRoom(who === undefined ? layout.rooms.find(r => cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h)?.id : undefined);
  };
  const chosenRoom = room === undefined ? undefined : layout.rooms.find(r => r.id === room);
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
            {chosenRoom && (
              <Rect x={(chosenRoom.x + 0.5) * CELL_PX} y={(chosenRoom.y + 0.5) * CELL_PX} width={(chosenRoom.w - 1) * CELL_PX} height={(chosenRoom.h - 1) * CELL_PX}
                style="stroke" strokeWidth={CELL_PX * 0.2} color={colors.accent} />
            )}
            <Atlas image={atlas.image} sprites={objectSprites} transforms={objectXforms} />
            <Circle cx={ringX} cy={ringY} r={CELL_PX * 0.72} color={colors.accentSoft} />
            <Circle cx={ringX} cy={ringY} r={CELL_PX * 0.72} style="stroke" strokeWidth={CELL_PX * 0.12} color={colors.accent} />
            <Atlas image={atlas.image} sprites={bodySprites} transforms={personXforms} />
            <Atlas image={atlas.image} sprites={headSprites} transforms={personXforms} />
          </Group>
        </Canvas>
      </GestureDetector>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        {layout.rooms.map(r => {
          const name = r.type === 'office' && layout.mine && r.id !== layout.mine ? T.shift.map.rooms.colleagueOffice : T.shift.map.rooms[r.type];
          const at = roomLabel(name ?? '', r, cell, doorOnTop(r, [r.door]));
          return (
            <Text key={r.id} numberOfLines={at.lines} allowFontScaling={false} style={[styles.room, { left: at.left, top: at.top, maxWidth: at.width, fontSize: at.fontSize, lineHeight: at.fontSize * 1.2 }]}>
              {name}
            </Text>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  room: { position: 'absolute', fontWeight: '600', color: colors.muted },
});
