// Люди на карте амбулатории: кто куда идёт (src/state/clinicMap.ts даёт места). Без React и
// Skia — поэтому проверяется в Bun; карта (ClinicMap.tsx) только отдаёт пути на UI-поток.
// Новое место — новый путь A* от того места, где человек сейчас, без скачка. Дошедший до
// выхода исчезает и больше не появляется.
import type { Cell, ClinicLayout } from '@/engine/hospital/clinic';
import { findPath } from '@/engine/sim/path';
import { assignSeats, type Figure, nearest, type Placement } from '@/state/clinicMap';

/** Шаг — клеток в секунду настоящего времени: на ×4 игровые минуты летят, а люди идут, а не прыгают. */
export const SPEED = 4;

interface Walker {
  slot: number;
  sprite: number;
  /** путь x0, y0, x1, y1, … в клетках: от первой точки к последней, по отрезку за 1/SPEED с */
  pts: number[];
  /** когда вышел — по часам карты, в секундах */
  start: number;
  target: string;
  leaving: boolean;
  callable: boolean;
}

/** Что уходит на UI-поток: пути подряд; на место — смещение, число точек, время выхода; фигурки. */
export interface Frame {
  route: number[];
  meta: number[];
  sprites: number[];
  /** когда дойдёт последний идущий — дальше часы карты стоят и кадры не рисуются */
  until: number;
  /** изменилось ли что-то для UI-потока с прошлой сверки */
  changed: boolean;
}

const cellKey = (c: Cell) => `${c[0]},${c[1]}`;

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Фигурка (sprites.ts): персонал по роли; пациент — один из трёх цветов, обод — по срочности. */
export function spriteOf(figure: Figure, id: string): number {
  const v = hash(id) % 3;
  if (figure === 'doctor') return 0;
  if (figure === 'nurse') return 1;
  if (figure === 'staff') return 5;
  if (figure === 'patientYellow') return 6 + v;
  if (figure === 'patientRed') return 9 + v;
  return 2 + v;
}

/** Где человек на пути в момент `now`; то же на каждом кадре считает ворклет карты. */
export function posAt(pts: readonly number[], start: number, now: number): [number, number] {
  const last = pts.length / 2 - 1;
  if (last <= 0) return [pts[0], pts[1]];
  const s = Math.min(last, Math.max(0, (now - start) * SPEED));
  const k = Math.min(last - 1, Math.floor(s));
  const f = s - k;
  const a = k * 2;
  return [pts[a] + (pts[a + 2] - pts[a]) * f, pts[a + 1] + (pts[a + 3] - pts[a + 1]) * f];
}

export class Walkers {
  private walkers = new Map<string, Walker>();
  private seats = new Map<string, number>();
  private benches = new Map<string, number>();
  private gone = new Set<string>();
  private first = true;

  constructor(private layout: ClinicLayout, private capacity: number) {}

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
      } else if (w.leaving && this.arrived(w, now)) {
        this.walkers.delete(id);
        this.gone.add(id);
        changed = true;
      }
    }
    for (const id of this.gone) if (!present.has(id)) this.gone.delete(id);

    const used = new Set([...this.walkers.values()].map(w => w.slot));
    for (const p of people) {
      if (this.gone.has(p.id)) continue;
      const target = this.targetOf(p);
      const w = this.walkers.get(p.id);
      if (!w) {
        let slot = 0;
        while (used.has(slot)) slot++;
        if (slot >= this.capacity) continue;
        used.add(slot);
        // при открытии карты все уже на местах; потом новые входят с улицы
        const from = this.first || p.id.startsWith('staff.') ? target : layout.entrance;
        this.walkers.set(p.id, { slot, sprite: spriteOf(p.figure, p.id), pts: this.path(from, target), start: now, target: cellKey(target), leaving: !!p.leaving, callable: !!p.callable });
        changed = true;
        continue;
      }
      w.callable = !!p.callable;
      w.leaving = !!p.leaving;
      const sprite = spriteOf(p.figure, p.id);
      if (w.sprite !== sprite) {
        w.sprite = sprite;
        changed = true;
      }
      if (w.target !== cellKey(target)) {
        const [x, y] = posAt(w.pts, w.start, now);
        const from: Cell = [Math.round(x), Math.round(y)];
        const rest = this.path(from, target);
        const exact = Math.abs(x - from[0]) < 0.01 && Math.abs(y - from[1]) < 0.01;
        w.pts = exact ? rest : [x, y, ...rest];
        w.start = now;
        w.target = cellKey(target);
        changed = true;
      }
    }
    this.first = false;

    const route: number[] = [];
    const meta = new Array<number>(this.capacity * 3).fill(0);
    const sprites = new Array<number>(this.capacity).fill(0);
    let until = 0;
    for (const w of this.walkers.values()) {
      meta[w.slot * 3] = route.length / 2;
      meta[w.slot * 3 + 1] = w.pts.length / 2;
      meta[w.slot * 3 + 2] = w.start;
      for (const v of w.pts) route.push(v);
      sprites[w.slot] = w.sprite;
      until = Math.max(until, w.start + (w.pts.length / 2 - 1) / SPEED);
    }
    return { route, meta, sprites, until, changed };
  }

  /** Кого из ждущих в зале коснулись: точка — в клетках, не дальше клетки от фигурки. */
  hit(x: number, y: number, now: number): string | undefined {
    const points = [...this.walkers].filter(([, w]) => w.callable).map(([id, w]) => {
      const [px, py] = posAt(w.pts, w.start, now);
      return { id, x: px + 0.5, y: py + 0.5 };
    });
    return nearest(points, x, y);
  }

  /** Где сейчас — для проверок. */
  where(id: string, now: number): [number, number] | undefined {
    const w = this.walkers.get(id);
    return w ? posAt(w.pts, w.start, now) : undefined;
  }

  private arrived(w: Walker, now: number) {
    return (now - w.start) * SPEED >= w.pts.length / 2 - 1;
  }

  private targetOf(p: Placement): Cell {
    const { layout } = this;
    if ('cell' in p.where) return p.where.cell;
    // мест нет — стоит у регистратуры: восемнадцати стульев хватает на обычную очередь
    if ('seat' in p.where) return layout.seats[this.seats.get(p.id) ?? -1] ?? layout.spots.registration;
    return layout.benches[this.benches.get(p.id) ?? -1] ?? layout.spots.registration;
  }

  private path(from: Cell, to: Cell): number[] {
    return (findPath(this.layout.grid, from, to) ?? [from, to]).flat();
  }
}
