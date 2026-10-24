// Живой фон (spec 2026-10-living-background, вопрос 53, вариант 1): ждущие в зале иногда ходят в санузел и моют руки,
// регистратор и медсестра в тихую минуту уходят в ординаторскую — к кофеварке и за стол, нанятые врачи между приёмами
// читают. Это только карта: смена об этом не знает — сроки, очередь, терпение и деньги прежние. Как и всё на карте,
// выводится из состояния смены и часов, а не хранится.
import { fnv1a } from '@/engine/core/hash';
import type { Cell, ClinicLayout, StaffRole } from '@/engine/hospital/clinic';
import { walkable } from '@/engine/hospital/grid';
import { findPath } from '@/engine/sim/path';
import { DAY, SHIFT_START, type ShiftPatient, type ShiftState } from '@/engine/shift/types';
import type { Doing, Where } from './clinicMap';

/**
 * Темп карты: сколько игровых секунд в секунде на экране — скорость смены × 60. Прогулки меряются секундами экрана:
 * на ×4 человек так же дойдёт до кабинки и постоит в ней, как на ×1.
 */
export interface Life {
  pace: number;
}

/** Клеток в секунду экрана — как идут люди на карте (`SPEED` в walkers.ts). */
export const WALK = 4;
/** Сколько из 100 ждущих в зале сходят в санузел — за каждое ожидание приёма. */
export const TOILET_SHARE = 25;
/** Через сколько минут ожидания встаёт: от и до. */
export const TOILET_AFTER: readonly [number, number] = [10, 40];
/** Сколько секунд экрана в кабинке: от и до. */
export const STALL: readonly [number, number] = [3, 5];
/** Секунд экрана у раковины. */
export const WASH = 1.5;
/** Сколько секунд экрана ждёт у двери, когда обе кабинки заняты, — потом возвращается на место. */
export const DOOR_WAIT = 5;
/** Тихая минута: ни у стола, ни в очереди, ни в пути от входа ближайшие столько минут. */
export const QUIET = 20;
/** Через сколько минут после последнего уходит на перерыв. */
const REST_AFTER = 2;
/** Сколько секунд экрана сидит в ординаторской: от и до; дорога туда и обратно — сверх этого. */
export const REST: readonly [number, number] = [5, 10];
/** Меньше этого посидеть не успеет — тогда и не уходит. */
const REST_MIN = 3;
/** Секунд экрана у кофеварки. */
const COFFEE = 2;

const MIN = 60;

/** Где у санузла что: кабинки (номер — по порядку на карте), где стоят у раковин, где ждут у двери. */
interface Toilet {
  stalls: { cell: Cell; index: number }[];
  sinks: Cell[];
  door: Cell;
  /** секунд экрана от ближнего и от дальнего стула зала до кабинки */
  near: number;
  far: number;
  /** секунд экрана от двери до кабинки */
  inside: number;
}

/** Ординаторская для перерыва: стулья, где стоят у кофеварки. */
interface Lounge {
  chairs: Cell[];
  coffee: Cell[];
}

const toilets = new WeakMap<ClinicLayout, Toilet | null>();
const lounges = new WeakMap<ClinicLayout, Lounge | null>();
const walks = new WeakMap<ClinicLayout, Map<string, number>>();

/** Кабинки санузлов на карте по порядку: их номер — и номер «занято» над ними (walkers.ts, ClinicMap.tsx). */
export function stallsOf(layout: ClinicLayout): Cell[] {
  return layout.objects.filter(o => o.kind === 'stall').map(o => [o.x, o.y] as Cell);
}

const inside = (r: { x: number; y: number; w: number; h: number }, x: number, y: number) => x > r.x && y > r.y && x < r.x + r.w - 1 && y < r.y + r.h - 1;

/** Свободные клетки у предмета внутри помещения: спереди, слева, справа, сзади — где встать к нему лицом. */
function standBy(layout: ClinicLayout, room: { x: number; y: number; w: number; h: number }, [x, y]: Cell): Cell[] {
  const taken = new Set(layout.objects.map(o => `${o.x},${o.y}`));
  const around: Cell[] = [[x, y + 1], [x - 1, y], [x + 1, y], [x, y - 1]];
  return around.filter(([cx, cy]) => inside(room, cx, cy) && walkable(layout.grid, cx, cy) && !taken.has(`${cx},${cy}`));
}

/** Секунд экрана пешком от клетки до клетки; дойти нельзя — undefined. Запоминается: план не меняется. */
function walkSeconds(layout: ClinicLayout, from: Cell, to: Cell): number | undefined {
  let byPair = walks.get(layout);
  if (!byPair) {
    byPair = new Map();
    walks.set(layout, byPair);
  }
  const key = `${from[0]},${from[1]}>${to[0]},${to[1]}`;
  let s = byPair.get(key);
  if (s === undefined) {
    const path = findPath(layout.grid, from, to);
    s = path ? (path.length - 1) / WALK : -1;
    byPair.set(key, s);
  }
  return s < 0 ? undefined : s;
}

/** Санузел, ближний к залу: две кабинки и раковины; нет его, кабинок или дороги до него — null. */
function toiletOf(layout: ClinicLayout): Toilet | null {
  const known = toilets.get(layout);
  if (known !== undefined) return known;
  const all = stallsOf(layout);
  let best: Toilet | null = null;
  for (const r of layout.rooms.filter(x => x.type === 'toilet')) {
    const stalls = all.flatMap((cell, index) => (cell[0] >= r.x && cell[0] < r.x + r.w && cell[1] >= r.y && cell[1] < r.y + r.h ? [{ cell, index }] : []));
    const sinks = layout.objects.filter(o => o.kind === 'sink' && inside(r, o.x, o.y)).flatMap(o => standBy(layout, r, [o.x, o.y]).slice(0, 1));
    if (stalls.length === 0 || layout.seats.length === 0) continue;
    const far = stalls.map(s => Math.max(...layout.seats.map(c => walkSeconds(layout, c, s.cell) ?? Infinity)));
    const near = stalls.map(s => Math.min(...layout.seats.map(c => walkSeconds(layout, c, s.cell) ?? Infinity)));
    const door = r.door;
    const inner = Math.max(...stalls.map(s => walkSeconds(layout, door, s.cell) ?? Infinity));
    if (!Number.isFinite(Math.max(...far)) || !Number.isFinite(inner)) continue;
    const t: Toilet = { stalls, sinks, door: outsideOf(layout, r), near: Math.min(...near), far: Math.max(...far), inside: inner };
    if (!best || t.near < best.near) best = t;
  }
  toilets.set(layout, best);
  return best;
}

/** Клетка за дверью помещения — в коридоре; там ждут. Снаружи не пройти — сама дверь. */
function outsideOf(layout: ClinicLayout, r: { x: number; y: number; w: number; h: number; door: Cell }): Cell {
  const [dx, dy] = r.door;
  const out: Cell = dy === r.y ? [dx, dy - 1] : dy === r.y + r.h - 1 ? [dx, dy + 1] : dx === r.x ? [dx - 1, dy] : [dx + 1, dy];
  return walkable(layout.grid, out[0], out[1]) ? out : r.door;
}

/** Ординаторская: её стулья и где встать у кофеварки; нет её (амбулатория практики) — перерывов нет. */
function loungeOf(layout: ClinicLayout): Lounge | null {
  const known = lounges.get(layout);
  if (known !== undefined) return known;
  const r = layout.rooms.find(x => x.type === 'staff');
  const own = (kind: string) => (r ? layout.objects.filter(o => o.kind === kind && inside(r, o.x, o.y)) : []);
  const chairs = own('chair').map(o => [o.x, o.y] as Cell);
  const coffee = r ? own('coffee').flatMap(o => standBy(layout, r, [o.x, o.y])) : [];
  const out = r && chairs.length > 0 ? { chairs, coffee } : null;
  lounges.set(layout, out);
  return out;
}

const hashOf = (text: string) => fnv1a(text) >>> 0;
const between = (h: number, [lo, hi]: readonly [number, number]) => lo + (h % (hi - lo + 1));

interface Visit {
  id: string;
  start: number;
  /** секунд экрана в кабинке */
  stay: number;
}

/**
 * Санузел (spec 2026-10-living-background): каждый четвёртый ждущий в зале — по своему жребию — через 10–40 минут
 * ожидания встаёт и идёт в санузел. Кабинок две: свободна — идёт в неё, занята — ждёт у двери, а не дождался — назад
 * на место. Из кабинки — к раковине. Кабинку держат за ним, пока он идёт к ней от самого дальнего стула, — и никто не
 * зайдёт в занятую. `waiting` — кто сейчас ждёт приёма в зале.
 */
export function toiletPlaces(layout: ClinicLayout, s: ShiftState, life: Life, waiting: readonly ShiftPatient[]): Map<string, { where: Where; doing: Doing }> {
  const out = new Map<string, { where: Where; doing: Doing }>();
  const t = toiletOf(layout);
  if (!t) return out;
  const visits: Visit[] = [];
  for (const p of waiting) {
    const h = hashOf(`${p.id}:${p.wait}:toilet`);
    if (h % 100 >= TOILET_SHARE) continue;
    const start = p.queuedT + between(h >>> 7, TOILET_AFTER) * MIN;
    if (start <= s.t) visits.push({ id: p.id, start, stay: between(h >>> 13, STALL) });
  }
  visits.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
  const { pace } = life;
  const free = t.stalls.map(() => -Infinity);
  for (const v of visits) {
    let k = 0;
    for (let i = 1; i < free.length; i++) if (free[i] < free[k]) k = i;
    const there = v.start + t.near * pace;
    let from = v.start;
    let end: number;
    if (free[k] <= there) {
      // свободна, когда он дойдёт даже от ближнего стула: держим, пока не дойдёт от дальнего и не выйдет
      end = v.start + (t.far + v.stay) * pace;
    } else if (free[k] - there <= DOOR_WAIT * pace) {
      // ждёт у двери, пока её не освободят
      if (s.t < free[k]) {
        out.set(v.id, { where: { cell: t.door }, doing: { kind: 'toiletQueue' } });
        continue;
      }
      from = free[k];
      end = from + (t.inside + v.stay) * pace;
    } else {
      // не дождался — постоял у двери и назад
      if (s.t < v.start + (t.far + DOOR_WAIT) * pace) out.set(v.id, { where: { cell: t.door }, doing: { kind: 'toiletQueue' } });
      continue;
    }
    free[k] = end;
    const stall = t.stalls[k];
    const sink = t.sinks[k % Math.max(1, t.sinks.length)];
    if (s.t >= from && s.t < end) out.set(v.id, { where: { cell: stall.cell }, doing: { kind: 'toilet', stall: stall.index } });
    else if (sink && s.t >= end && s.t < end + WASH * pace) out.set(v.id, { where: { cell: sink }, doing: { kind: 'wash' } });
  }
  return out;
}

/** Кто на перерыве: регистратор и медсестра доврачебного кабинета; остальные работают, как работали. */
const RESTING: ReadonlySet<StaffRole> = new Set(['registrar', 'nurse']);

/**
 * Перерыв (spec 2026-10-living-background): регистратор и медсестра доврачебного кабинета в тихую минуту — у стола и в
 * очереди к ним никого, а от входа ближайшие 20 минут никто не придёт — через 2 минуты после последнего уходят в
 * ординаторскую: к кофеварке и за стол, посидеть 5–10 секунд экрана. Возвращаются раньше, чем к ним кто-нибудь дойдёт:
 * дорога обратно — в секундах экрана, и на ×4 перерыв выпадает реже. `staff` — фигурки персонала на местах: номер,
 * должность, клетка у стола.
 */
export function restPlaces(layout: ClinicLayout, s: ShiftState, life: Life, staff: readonly { id: string; role: StaffRole; cell: Cell }[]): Map<string, { where: Where; doing: Doing }> {
  const out = new Map<string, { where: Where; doing: Doing }>();
  const lounge = loungeOf(layout);
  if (!lounge) return out;
  const { pace } = life;
  const patients = Object.values(s.patients);
  // кто придёт сам: регистратура и медсестра — их; привезённый скорой — мимо них
  let next = Infinity;
  for (const p of patients) if (p.status === 'coming' && p.kind !== 'ambulance' && p.arriveT > s.t) next = Math.min(next, p.arriveT);
  const dayStart = (s.day - 1) * DAY + SHIFT_START;
  let seat = 0;
  for (const x of staff) {
    if (!RESTING.has(x.role)) continue;
    const room = layout.rooms.find(r => x.cell[0] >= r.x && x.cell[0] < r.x + r.w && x.cell[1] >= r.y && x.cell[1] < r.y + r.h)?.id;
    const chair = lounge.chairs[seat];
    const coffee = lounge.coffee[seat];
    seat++;
    if (!room || !chair) continue;
    // у этого стола: последний — когда кончил, и есть ли кто сейчас
    let last = dayStart;
    let busy = false;
    for (const p of patients) {
      const at = x.role === 'registrar' ? p.intake?.reg : p.intake?.nurse;
      if (!at || at.room !== room) continue;
      last = Math.max(last, at.end);
      if (at.end > s.t) busy = true;
    }
    if (busy || next - last < QUIET * MIN) continue;
    const back = walkSeconds(layout, chair, x.cell);
    const go = walkSeconds(layout, x.cell, coffee ?? chair);
    if (back === undefined || go === undefined) continue;
    const start = last + REST_AFTER * MIN;
    const end = Math.min(start + (go + between(hashOf(`${x.id}:${last}:rest`), REST)) * pace, next - (back + 1) * pace);
    if (end - start < (go + REST_MIN) * pace || s.t < start || s.t >= end) continue;
    if (coffee && s.t < start + (go + COFFEE) * pace) out.set(x.id, { where: { cell: coffee }, doing: { kind: 'coffee', role: x.role } });
    else out.set(x.id, { where: { cell: chair }, doing: { kind: 'rest', role: x.role } });
  }
  return out;
}
