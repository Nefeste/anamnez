// Кто где на карте амбулатории (spec 2026-09-first-shift): выводится из состояния смены, а не
// хранится — сохранение прежнее, и карта после загрузки та же. Пришедший идёт в регистратуру,
// к медсестре, садится в зале ожидания; вызванный — в кабинет врача; отпущенный на
// обследования — в процедурную, на ЭКГ или рентген на время процедуры, а своей очереди к
// аппарату и результатов ждёт на скамье; принятый и не дождавшийся уходят к выходу. Как люди
// идут между местами, решает карта (src/render/map); что человек делает — подпись под картой.
import { db } from '@/content';
import type { ContentDb, Exam } from '@/content/types';
import { fnv1a } from '@/engine/core/hash';
import { type Cell, type ClinicLayout, clinicLayout, type StaffRole } from '@/engine/hospital/clinic';
import type { ShiftPatient, ShiftState } from '@/engine/shift/types';
import { lookOf } from '@/render/look';
import { type Figure as Look, patientFigure, staffFigure, type Uniform } from '@/render/map/figures';

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
  /** в кабинете врача; `by` — у нанятого врача (номер человека из штата) */
  | { kind: 'office'; by?: string }
  | { kind: 'exam'; room: ExamRoom }
  | { kind: 'examQueue'; room: ExamRoom }
  | { kind: 'results'; readyAt: number }
  | { kind: 'leaving' }
  | { kind: 'left' }
  /** лежит в палате своей больницы; `days` — сутки в стационаре (spec 2026-09-chapter-2, часть 26) */
  | { kind: 'ward'; days: number }
  /** привезла скорая (часть 27): ждёт сортировки, ждёт врача, на каталке у входа — мест нет, у вас на осмотре */
  | { kind: 'ambulance'; state: 'unsorted' | 'waiting' | 'door' | 'withYou' };

export interface Placement {
  id: string;
  figure: Figure;
  /** как выглядит на карте: пациент — как на портрете, персонал — форма по должности */
  look: Look;
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
  therapist: 'doctor',
  procedureNurse: 'nurse',
  labTech: 'staff',
  ecgNurse: 'nurse',
  radiographer: 'staff',
  radiologist: 'staff',
};

function figureOf(p: ShiftPatient): Figure {
  return p.triage === 'red' ? 'patientRed' : p.triage === 'yellow' ? 'patientYellow' : 'patient';
}

const UNIFORM_OF: Record<Figure, Uniform | undefined> = { doctor: 'doctor', nurse: 'nurse', staff: 'staff', patient: undefined, patientYellow: undefined, patientRed: undefined };

/** Пациент на карте — с тем же лицом, что на портрете в карте пациента (caseView). */
function lookOfPatient(p: ShiftPatient): Look {
  const { seed, sex, age } = p.patient;
  return patientFigure(lookOf(fnv1a(`${seed}:portrait`), sex, age), p.triage === 'red' ? 2 : p.triage === 'yellow' ? 1 : 0);
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
    // когда сама процедура — движок записал (с 0.0.21); прежде — по записанным минутам от готовности
    const total = (e.time.procedure + (e.time.report ?? 0) + (e.time.turnaround ?? 0)) * 60;
    const start = x.start ?? x.readyAt - total;
    const end = x.end ?? start + e.time.procedure * 60;
    if (t >= start && t < end) return { where: { cell: examCell(layout, room) }, doing: { kind: 'exam', room } };
    if (start > t && (!next || start < next.start)) next = { room, start };
  }
  if (next) return { where: { bench: true }, doing: { kind: 'examQueue', room: next.room } };
  return { where: { bench: true }, doing: { kind: 'results', readyAt: Math.max(...p.pending.map(x => x.readyAt), t) } };
}

export function placements(db: ContentDb, layout: ClinicLayout, s: ShiftState): Placement[] {
  const out: Placement[] = layout.staff.map(x => {
    const id = `staff.${x.id ?? x.role}`;
    const figure = STAFF_FIGURE[x.role];
    return { id, figure, look: staffFigure(UNIFORM_OF[figure] ?? 'staff', id), where: { cell: x.cell }, doing: { kind: 'staff', role: x.role } };
  });
  // своя больница без доврачебного кабинета: от регистратуры — сразу в зал
  const triage = layout.rooms.some(r => r.type === 'triage');
  const exit = { cell: layout.entrance };
  for (const p of Object.values(s.patients)) {
    const figure = figureOf(p);
    const look = lookOfPatient(p);
    if (p.kind === 'ambulance' && (p.status === 'waiting' || p.status === 'inRoom')) {
      // скорая (spec 2026-09-chapter-2, часть 27): на месте в смотровой приёмного, мест нет — на
      // каталке у входа; смотрят его там же, в кабинет он не идёт
      const bay = p.bay ? layout.beds[p.bay.room]?.[p.bay.bed] : undefined;
      const state = p.status === 'inRoom' ? 'withYou' : !p.sorted ? 'unsorted' : bay ? 'waiting' : 'door';
      const callable = p.status === 'waiting' && p.sorted === true && s.current === undefined;
      out.push({ id: p.id, figure, look, where: bay ? { cell: bay } : exit, doing: { kind: 'ambulance', state }, callable });
    } else if (p.status === 'inRoom' && p.by) {
      // у нанятого врача — в его кабинете (spec 2026-09-hired-doctors)
      const room = s.staff?.find(m => m.id === p.by)?.room;
      out.push({ id: p.id, figure, look, where: { cell: (room && layout.offices[room]) || layout.spots.office }, doing: { kind: 'office', by: p.by } });
    } else if (p.status === 'inRoom') {
      out.push({ id: p.id, figure, look, where: { cell: layout.spots.office }, doing: { kind: 'office' } });
    } else if (p.status === 'waiting') {
      // только что пришедший — регистратура и медсестра (её витальные — уже в результатах);
      // вернувшийся с обследований — сразу в зал: врач с ним уже работал
      // пригласить можно любого из очереди, как из списка, — пока кабинет свободен
      const since = s.t - p.arriveT;
      const fresh = p.step === 0;
      // пациент нанятого врача ждёт его, а не вас (spec 2026-09-hired-doctors)
      const callable = s.current === undefined && p.by === undefined;
      if (fresh && since < REGISTRATION) out.push({ id: p.id, figure, look, where: { cell: layout.spots.registration }, doing: { kind: 'registration' }, callable });
      else if (fresh && triage && since < REGISTRATION + TRIAGE) out.push({ id: p.id, figure, look, where: { cell: layout.spots.triage }, doing: { kind: 'triage' }, callable });
      else out.push({ id: p.id, figure, look, where: { seat: true }, doing: { kind: 'waiting' }, callable });
    } else if (p.status === 'away') {
      out.push({ id: p.id, figure, look, ...awayPlace(db, layout, p, s.t) });
    } else if (p.status === 'done' && p.closed && s.t - p.closed.at < LEAVING) {
      out.push({ id: p.id, figure, look, where: exit, doing: { kind: 'leaving' }, leaving: true });
    } else if (p.status === 'admitted' && p.stay) {
      // лежит на своей койке; палату снесли — на карте его нет, пока не выпишут
      const bed = layout.beds[p.stay.room]?.[p.stay.bed];
      if (bed) out.push({ id: p.id, figure, look, where: { cell: bed }, doing: { kind: 'ward', days: Math.max(0, s.day - p.stay.since) } });
    } else if (p.status === 'left' && s.t - (p.queuedT + p.patience) < LEAVING) {
      // не дождался: ушёл, когда кончилось терпение (engine.ts, событие patience)
      out.push({ id: p.id, figure, look, where: exit, doing: { kind: 'left' }, leaving: true });
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

