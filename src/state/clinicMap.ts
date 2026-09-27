// Кто где на карте амбулатории (spec 2026-09-first-shift): выводится из состояния смены, а не
// хранится — сохранение прежнее, и карта после загрузки та же. Пришедший идёт в регистратуру,
// к медсестре, садится в зале ожидания; вызванный — в кабинет врача; отпущенный на
// обследования — в процедурную, на ЭКГ или рентген на время процедуры, а своей очереди к
// аппарату и результатов ждёт на скамье; принятый и не дождавшийся уходят к выходу. Как люди
// идут между местами, решает карта (src/render/map); что человек делает — подпись под картой.
import { db } from '@/content';
import type { ContentDb, Exam } from '@/content/types';
import { type Cell, type ClinicLayout, clinicLayout, type StaffRole } from '@/engine/hospital/clinic';
import type { ShiftPatient, ShiftState } from '@/engine/shift/types';

/** Вид фигурки: персонал — по роли, пациент — по срочности (цвет — не единственный признак: 03-game-design.md §13). */
export type Figure = 'doctor' | 'nurse' | 'staff' | 'patient' | 'patientYellow' | 'patientRed';

/** Место: клетка, стул в зале ожидания или скамья в коридоре — их раздаёт карта. */
export type Where = { cell: Cell } | { seat: true } | { bench: true };

/** Помещение, где обследование делают с пациентом: анализы — забор в процедурной. */
export type ExamRoom = 'xray' | 'ecg' | 'lab';

/** Что человек делает: карта по этому ведёт его, подпись под картой — рассказывает. */
export type Doing =
  | { kind: 'staff'; role: StaffRole }
  | { kind: 'registration' }
  | { kind: 'triage' }
  | { kind: 'waiting' }
  | { kind: 'office' }
  | { kind: 'exam'; room: ExamRoom }
  | { kind: 'examQueue'; room: ExamRoom }
  | { kind: 'results'; readyAt: number }
  | { kind: 'leaving' }
  | { kind: 'left' };

export interface Placement {
  id: string;
  figure: Figure;
  where: Where;
  doing: Doing;
  /** пациент уходит: дошёл до выхода — исчезает */
  leaving?: boolean;
  /** в очереди к врачу, и кабинет свободен: можно пригласить */
  callable?: boolean;
}

/** План амбулатории — один на всю игру: по нему и места в смене, и карта. */
export const CLINIC = clinicLayout(db);

/** Сколько игровых секунд новый пациент у регистратуры и у медсестры, прежде чем сесть. */
export const REGISTRATION = 2 * 60;
export const TRIAGE = 3 * 60;
/** Сколько принятый ещё виден по дороге к выходу. */
export const LEAVING = 10 * 60;

const STAFF_FIGURE: Record<StaffRole, Figure> = {
  registrar: 'staff',
  nurse: 'nurse',
  doctor: 'doctor',
  procedureNurse: 'nurse',
  labTech: 'staff',
  ecgNurse: 'nurse',
  radiographer: 'staff',
  radiologist: 'staff',
};

function patientFigure(p: ShiftPatient): Figure {
  return p.triage === 'red' ? 'patientRed' : p.triage === 'yellow' ? 'patientYellow' : 'patient';
}

const EXAM_ROOM: Record<string, ExamRoom> = { 'room.xray': 'xray', 'room.ecg': 'ecg', 'room.lab': 'lab' };

/** Где обследование делают с пациентом; анализы — забор в процедурной. Нет помещения — в кабинете. */
function examCell(layout: ClinicLayout, room: ExamRoom): Cell {
  return room === 'xray' ? layout.spots.xray : room === 'ecg' ? layout.spots.ecg : layout.spots.procedure;
}

/**
 * Отпущенный на обследования: во время процедуры — в её помещении; до неё — на скамье, в
 * очереди к аппарату; после — на скамье, ждёт результатов.
 */
function awayPlace(db: ContentDb, layout: ClinicLayout, p: ShiftPatient, t: number): { where: Where; doing: Doing } {
  let next: { room: ExamRoom; start: number } | undefined;
  for (const x of p.pending) {
    const e: Exam | undefined = db.exams[x.exam];
    const room = e?.room ? EXAM_ROOM[e.room] : undefined;
    if (!e || !room) continue;
    // время обследования — в минутах; результат готов после процедуры, описания и ожидания
    const total = (e.time.procedure + (e.time.report ?? 0) + (e.time.turnaround ?? 0)) * 60;
    const start = x.readyAt - total;
    if (t >= start && t < start + e.time.procedure * 60) return { where: { cell: examCell(layout, room) }, doing: { kind: 'exam', room } };
    if (start > t && (!next || start < next.start)) next = { room, start };
  }
  if (next) return { where: { bench: true }, doing: { kind: 'examQueue', room: next.room } };
  return { where: { bench: true }, doing: { kind: 'results', readyAt: Math.max(...p.pending.map(x => x.readyAt), t) } };
}

export function placements(db: ContentDb, layout: ClinicLayout, s: ShiftState): Placement[] {
  const out: Placement[] = layout.staff.map(x => ({
    id: `staff.${x.role}`, figure: STAFF_FIGURE[x.role], where: { cell: x.cell }, doing: { kind: 'staff', role: x.role },
  }));
  const exit = { cell: layout.entrance };
  for (const p of Object.values(s.patients)) {
    const figure = patientFigure(p);
    if (p.status === 'inRoom') {
      out.push({ id: p.id, figure, where: { cell: layout.spots.office }, doing: { kind: 'office' } });
    } else if (p.status === 'waiting') {
      // только что пришедший — регистратура и медсестра (её витальные — уже в результатах);
      // вернувшийся с обследований — сразу в зал: врач с ним уже работал
      // пригласить можно любого из очереди, как из списка, — пока кабинет свободен
      const since = s.t - p.arriveT;
      const fresh = p.step === 0;
      const callable = s.current === undefined;
      if (fresh && since < REGISTRATION) out.push({ id: p.id, figure, where: { cell: layout.spots.registration }, doing: { kind: 'registration' }, callable });
      else if (fresh && since < REGISTRATION + TRIAGE) out.push({ id: p.id, figure, where: { cell: layout.spots.triage }, doing: { kind: 'triage' }, callable });
      else out.push({ id: p.id, figure, where: { seat: true }, doing: { kind: 'waiting' }, callable });
    } else if (p.status === 'away') {
      out.push({ id: p.id, figure, ...awayPlace(db, layout, p, s.t) });
    } else if (p.status === 'done' && p.closed && s.t - p.closed.at < LEAVING) {
      out.push({ id: p.id, figure, where: exit, doing: { kind: 'leaving' }, leaving: true });
    } else if (p.status === 'left' && s.t - (p.queuedT + p.patience) < LEAVING) {
      // не дождался: ушёл, когда кончилось терпение (engine.ts, событие patience)
      out.push({ id: p.id, figure, where: exit, doing: { kind: 'left' }, leaving: true });
    }
    // coming — ещё не пришёл; unseen — день закрыт, их на карте нет
  }
  return out;
}

/**
 * Места в зале и на скамьях: кто сел, тот сидит, пока не встанет, — иначе при каждом новом
 * пришедшем очередь пересаживалась бы. Новым — первые свободные места; мест нет — -1.
 */
export function assignSeats(prev: ReadonlyMap<string, number>, ids: readonly string[], count: number): Map<string, number> {
  const next = new Map<string, number>();
  const taken = new Set<number>();
  for (const id of ids) {
    const was = prev.get(id);
    if (was !== undefined && was >= 0 && !taken.has(was)) {
      next.set(id, was);
      taken.add(was);
    }
  }
  for (const id of ids) {
    if (next.has(id)) continue;
    let free = -1;
    for (let i = 0; i < count; i++) {
      if (!taken.has(i)) {
        free = i;
        break;
      }
    }
    next.set(id, free);
    if (free >= 0) taken.add(free);
  }
  return next;
}

/** Ближайший к точке (в клетках) из тех, кого можно вызвать, — не дальше `radius` клеток. */
export function nearest(points: readonly { id: string; x: number; y: number }[], x: number, y: number, radius = 1): string | undefined {
  let best: string | undefined;
  let bestD = radius * radius;
  for (const p of points) {
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d <= bestD) {
      bestD = d;
      best = p.id;
    }
  }
  return best;
}

