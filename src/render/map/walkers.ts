// Люди на карте амбулатории: кто куда идёт (src/state/clinicMap.ts даёт места). Без React и
// Skia — поэтому проверяется в Bun; карта (ClinicMap.tsx) только отдаёт пути на UI-поток.
// Смена на ×4 меняет места быстрее, чем человек успевает дойти, поэтому места — это
// остановки маршрута: у стойки регистратуры, у стола медсестры, у аппарата человек хотя бы
// немного стоит, даже если по смене он уже дальше; место ожидания (стул, скамья), до которого
// не дошёл, заменяет следующее; в кабинет врача зовут — туда идут сразу и быстрее. Новый путь
// начинается там, где человек сейчас, без скачка. Дошедший до выхода исчезает и больше не
// появляется.
import type { Cell, ClinicLayout } from '@/engine/hospital/clinic';
import { findPath } from '@/engine/sim/path';
import { assignSeats, type Doing, nearest, type Placement } from '@/state/clinicMap';
import { headingOf, objectTurns, restHeading, type Turn } from './orient';

/** Шаг — клеток в секунду настоящего времени: на ×4 игровые минуты летят, а люди идут, а не прыгают. */
export const SPEED = 4;
/** В кабинет по вызову — быстрее: карта пациента откроется, когда он войдёт. */
export const BRISK = 8;
/** Сколько секунд человек хотя бы стоит там, где с ним что-то делают. */
export const DWELL: Partial<Record<Doing['kind'], number>> = { registration: 1, triage: 1.5, exam: 1.5 };
/** Чисел на человека в `meta`: смещение пути, число точек, время выхода, скорость, исчезнуть у цели. */
export const STRIDE = 5;

/** act — там с человеком что-то делают; wait — сидит, ждёт; go — идёт туда без остановок. */
type LegKind = 'act' | 'wait' | 'go';

/** Остановка маршрута: `arrive` и `leave` — номера точек пути, когда пришёл и когда пошёл дальше. */
interface Leg {
  key: string;
  cell: Cell;
  kind: LegKind;
  /** сколько секунд стоять */
  dwell: number;
  arrive: number;
  leave: number;
}

interface Walker {
  slot: number;
  /** тело и голова из атласа (figures.ts) */
  body: number;
  head: number;
  /** путь x0, y0, x1, y1, … в клетках: от первой точки к последней, по отрезку за 1/speed с */
  pts: number[];
  /** куда повёрнут на каждой точке пути, радианы: идёт — по ходу, стоит — к столу или как стул */
  turns: number[];
  /** когда вышел — по часам карты, в секундах */
  start: number;
  speed: number;
  legs: Leg[];
  /** куда в итоге: ключ последней остановки */
  target: string;
  leaving: boolean;
}

/**
 * Что уходит на UI-поток: пути подряд и повороты на их точках; на человека — STRIDE чисел
 * (см. выше), тело и голова из атласа.
 */
export interface Frame {
  route: number[];
  turns: number[];
  meta: number[];
  bodies: number[];
  heads: number[];
  /** когда дойдёт последний идущий — дальше часы карты стоят и кадры не рисуются */
  until: number;
  /** изменилось ли что-то для UI-потока с прошлой сверки */
  changed: boolean;
}

const cellKey = (c: Cell) => `${c[0]},${c[1]}`;

/** Где человек на пути в момент `now`; то же на каждом кадре считает ворклет карты. */
export function posAt(pts: readonly number[], start: number, speed: number, now: number): [number, number] {
  const last = pts.length / 2 - 1;
  if (last <= 0) return [pts[0], pts[1]];
  const s = Math.min(last, Math.max(0, (now - start) * speed));
  const k = Math.min(last - 1, Math.floor(s));
  const f = s - k;
  const a = k * 2;
  return [pts[a] + (pts[a + 2] - pts[a]) * f, pts[a + 1] + (pts[a + 3] - pts[a + 1]) * f];
}

/** Куда повёрнут на пути в момент `now`: поворот отрезка, по которому идёт, или остановки. */
export function turnAt(turns: readonly number[], start: number, speed: number, now: number): number {
  const last = turns.length - 1;
  if (last <= 0) return turns[0] ?? 0;
  const s = Math.min(last, Math.max(0, (now - start) * speed));
  return turns[Math.min(last, Math.floor(s))];
}

function legKind(d: Doing): LegKind {
  if (d.kind === 'waiting' || d.kind === 'results' || d.kind === 'examQueue') return 'wait';
  if (d.kind === 'registration' || d.kind === 'triage' || d.kind === 'exam') return 'act';
  return 'go';
}

export class Walkers {
  private walkers = new Map<string, Walker>();
  private seats = new Map<string, number>();
  private benches = new Map<string, number>();
  private gone = new Set<string>();
  private first = true;
  /** куда повёрнут каждый предмет плана — к нему поворачиваются стоящие и сидящие */
  private objectTurns: Turn[];

  constructor(private layout: ClinicLayout, private capacity: number) {
    this.objectTurns = objectTurns(layout.grid, layout.objects, layout.staff.map(s => s.cell));
  }

  /** Сверить с местами из смены; `now` — часы карты. Отдаёт то, что рисовать. */
  sync(people: readonly Placement[], now: number): Frame {
    const { layout } = this;
    this.seats = assignSeats(this.seats, people.filter(p => 'seat' in p.where).map(p => p.id), layout.seats.length);
    this.benches = assignSeats(this.benches, people.filter(p => 'bench' in p.where).map(p => p.id), layout.benches.length);

    // ушедшие со смены — сразу; дошедшие до выхода — тоже, и больше не появляются
    let changed = this.first;
    const present = new Set(people.map(p => p.id));
    for (const [id, w] of this.walkers) {
      if (!present.has(id)) {
        this.walkers.delete(id);
        changed = true;
      } else if (w.leaving && now >= this.arrival(w)) {
        this.walkers.delete(id);
        this.gone.add(id);
        changed = true;
      }
    }
    for (const id of this.gone) if (!present.has(id)) this.gone.delete(id);

    const used = new Set([...this.walkers.values()].map(w => w.slot));
    for (const p of people) {
      if (this.gone.has(p.id)) continue;
      const leg = this.leg(p);
      const w = this.walkers.get(p.id);
      if (!w) {
        let slot = 0;
        while (used.has(slot)) slot++;
        if (slot >= this.capacity) continue;
        used.add(slot);
        const fresh: Walker = { slot, body: p.look.body, head: p.look.head, pts: [], turns: [], start: now, speed: SPEED, legs: [], target: leg.key, leaving: !!p.leaving };
        // при открытии карты все уже на местах; потом новые входят с улицы
        if (this.first || p.id.startsWith('staff.')) this.plan(fresh, [leg.cell], [{ ...leg, dwell: 0 }], now, SPEED);
        else this.plan(fresh, [layout.entrance], [leg], now, SPEED);
        this.walkers.set(p.id, fresh);
        changed = true;
        continue;
      }
      w.leaving = !!p.leaving;
      if (w.body !== p.look.body || w.head !== p.look.head) {
        w.body = p.look.body;
        w.head = p.look.head;
        changed = true;
      }
      if (w.target !== leg.key) {
        this.retarget(w, leg, p.doing.kind === 'office', now);
        changed = true;
      }
    }
    this.first = false;

    const route: number[] = [];
    const turns: number[] = [];
    const meta = new Array<number>(this.capacity * STRIDE).fill(0);
    const bodies = new Array<number>(this.capacity).fill(0);
    const heads = new Array<number>(this.capacity).fill(0);
    let until = 0;
    for (const w of this.walkers.values()) {
      const m = w.slot * STRIDE;
      meta[m] = route.length / 2;
      meta[m + 1] = w.pts.length / 2;
      meta[m + 2] = w.start;
      meta[m + 3] = w.speed;
      meta[m + 4] = w.leaving ? 1 : 0;
      for (const v of w.pts) route.push(v);
      for (const v of w.turns) turns.push(v);
      bodies[w.slot] = w.body;
      heads[w.slot] = w.head;
      until = Math.max(until, this.arrival(w));
    }
    return { route, turns, meta, bodies, heads, until, changed };
  }

  /** Кого коснулись: точка — в клетках, не дальше клетки от фигурки; персонал тоже. */
  hit(x: number, y: number, now: number): string | undefined {
    const points = [...this.walkers]
      .filter(([, w]) => !(w.leaving && now >= this.arrival(w)))
      .map(([id, w]) => {
        const [px, py] = posAt(w.pts, w.start, w.speed, now);
        return { id, x: px + 0.5, y: py + 0.5 };
      });
    return nearest(points, x, y);
  }

  /** Где сейчас — для проверок. */
  where(id: string, now: number): [number, number] | undefined {
    const w = this.walkers.get(id);
    return w ? posAt(w.pts, w.start, w.speed, now) : undefined;
  }

  /** Куда повёрнут сейчас, радианы (рисунок — лицом на юг); то же на кадре считает ворклет карты. */
  facing(id: string, now: number): number | undefined {
    const w = this.walkers.get(id);
    return w ? turnAt(w.turns, w.start, w.speed, now) : undefined;
  }

  /** Когда (по часам карты) дойдёт до последней остановки; нет его на карте — undefined. */
  arrivalOf(id: string): number | undefined {
    const w = this.walkers.get(id);
    return w ? this.arrival(w) : undefined;
  }

  /** Место в буферах UI-потока — для выделения; нет на карте — -1. */
  slotOf(id: string | undefined): number {
    const w = id === undefined ? undefined : this.walkers.get(id);
    return w ? w.slot : -1;
  }

  private arrival(w: Walker) {
    return w.start + (w.pts.length / 2 - 1) / w.speed;
  }

  /**
   * Новое место: остановки, до которых ещё не дошёл или у которых ещё не достоял, остаются;
   * место ожидания в конце заменяется новым; в кабинет врача — сразу, без остановок.
   */
  private retarget(w: Walker, leg: Leg, direct: boolean, now: number) {
    const speed = direct ? BRISK : SPEED;
    const n = w.pts.length / 2;
    const s = Math.min(n - 1, Math.max(0, (now - w.start) * w.speed));
    const k = Math.floor(s);
    const f = s - k;
    const at = (i: number): Cell => [w.pts[i * 2], w.pts[i * 2 + 1]];
    let rest = direct ? [] : w.legs.filter(l => l.leave > s);
    if (rest.length > 0 && rest[rest.length - 1].kind === 'wait') rest = rest.slice(0, -1);
    if (rest.length > 0 && s >= rest[0].arrive) {
      // стоит у остановки — достаивает, что осталось
      rest[0] = { ...rest[0], dwell: (rest[0].leave - s) / w.speed };
      this.plan(w, [rest[0].cell], [...rest, leg], now, speed);
    } else if (f < 0.01) {
      this.plan(w, [at(k)], [...rest, leg], now, speed);
    } else {
      // между клетками: шаг к следующей — с того же места и той же скоростью, назад не пятится
      this.plan(w, [at(k), at(k + 1)], [...rest, leg], now - f / speed, speed);
    }
  }

  /** Путь: сначала точки `lead` (человек сейчас на них), дальше — через остановки; стоянка — повтор точки. */
  private plan(w: Walker, lead: Cell[], legs: Leg[], start: number, speed: number) {
    // куда смотрел до нового пути — так и стоит, пока не пошёл
    const before = w.pts.length > 0 ? turnAt(w.turns, w.start, w.speed, start) : 0;
    const pts: number[] = lead.flat();
    const planned: Leg[] = [];
    let from = lead[lead.length - 1];
    for (const leg of legs) {
      const path = findPath(this.layout.grid, from, leg.cell) ?? [from, leg.cell];
      // первая точка пути — та, где человек уже стоит
      for (const [x, y] of path.slice(1)) pts.push(x, y);
      const arrive = pts.length / 2 - 1;
      for (let i = Math.round(leg.dwell * speed); i > 0; i--) pts.push(leg.cell[0], leg.cell[1]);
      planned.push({ ...leg, arrive, leave: pts.length / 2 - 1 });
      from = leg.cell;
    }
    w.pts = pts;
    w.turns = this.turnsOf(pts, before);
    w.start = start;
    w.speed = speed;
    w.legs = planned;
    w.target = planned[planned.length - 1].key;
  }

  /**
   * Поворот на каждой точке пути: идёт — по отрезку к следующей точке; стоит (повтор точки или
   * конец пути) — к столу или аппарату рядом, на стуле — как стул; иначе — как шёл.
   */
  private turnsOf(pts: readonly number[], before: number): number[] {
    const n = pts.length / 2;
    const out = new Array<number>(n);
    let last = before;
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2];
      const y = pts[i * 2 + 1];
      const dx = i + 1 < n ? pts[i * 2 + 2] - x : 0;
      const dy = i + 1 < n ? pts[i * 2 + 3] - y : 0;
      if (dx !== 0 || dy !== 0) last = headingOf(dx, dy);
      else last = restHeading(this.layout.objects, this.objectTurns, [x, y]) ?? last;
      out[i] = last;
    }
    return out;
  }

  private leg(p: Placement): Leg {
    const cell = this.targetOf(p);
    return { key: cellKey(cell), cell, kind: legKind(p.doing), dwell: DWELL[p.doing.kind] ?? 0, arrive: 0, leave: 0 };
  }

  private targetOf(p: Placement): Cell {
    const { layout } = this;
    if ('cell' in p.where) return p.where.cell;
    // мест нет — стоит у регистратуры: восемнадцати стульев хватает на обычную очередь
    if ('seat' in p.where) return layout.seats[this.seats.get(p.id) ?? -1] ?? layout.spots.registration;
    return layout.benches[this.benches.get(p.id) ?? -1] ?? layout.spots.registration;
  }
}
