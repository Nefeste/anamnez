// Кто где на карте амбулатории (spec 2026-09-first-shift): выводится из состояния смены, а не
// хранится — сохранение прежнее, и карта после загрузки та же. Пришедший идёт в регистратуру,
// к медсестре, садится в зале ожидания; вызванный — в кабинет врача; отпущенный на
// обследования — в процедурную, на ЭКГ или рентген на время процедуры, а результатов ждёт на
// скамье; принятый уходит к выходу. Как люди идут между местами, решает карта (src/render/map).
import type { ContentDb, Exam } from '@/content/types';
import { type Cell, type ClinicLayout, clinicLayout, type StaffRole } from '@/engine/hospital/clinic';
import type { ShiftPatient, ShiftState } from '@/engine/shift/types';

/** Вид фигурки: персонал — по роли, пациент — по срочности (цвет — не единственный признак: 03-game-design.md §13). */
export type Figure = 'doctor' | 'nurse' | 'staff' | 'patient' | 'patientYellow' | 'patientRed';

/** Место: клетка, стул в зале ожидания или скамья в коридоре — их раздаёт карта. */
export type Where = { cell: Cell } | { seat: true } | { bench: true };

export interface Placement {
  id: string;
  figure: Figure;
  where: Where;
  /** пациент уходит: дошёл до выхода — исчезает */
  leaving?: boolean;
  /** ждёт врача в зале, и кабинет свободен: касание вызывает */
  callable?: boolean;
}

/** План амбулатории — один на всю игру: по нему и места в смене, и карта. */
export const CLINIC = clinicLayout();

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

/** Где обследование делают с пациентом; анализы — забор в процедурной. Нет помещения — в кабинете. */
function examCell(layout: ClinicLayout, e: Exam): Cell | undefined {
  if (e.room === 'room.xray') return layout.spots.xray;
  if (e.room === 'room.ecg') return layout.spots.ecg;
  if (e.room === 'room.lab') return layout.spots.procedure;
  return undefined;
}

/** Отпущенный на обследования: во время процедуры — в её помещении, остальное время — на скамье. */
function awayWhere(db: ContentDb, layout: ClinicLayout, p: ShiftPatient, t: number): Where {
  for (const x of p.pending) {
    const e = db.exams[x.exam];
    const cell = e ? examCell(layout, e) : undefined;
    if (!cell) continue;
    // время обследования — в минутах; результат готов после процедуры, описания и ожидания
    const total = (e.time.procedure + (e.time.report ?? 0) + (e.time.turnaround ?? 0)) * 60;
    const start = x.readyAt - total;
    if (t >= start && t < start + e.time.procedure * 60) return { cell };
  }
  return { bench: true };
}

export function placements(db: ContentDb, layout: ClinicLayout, s: ShiftState): Placement[] {
  const out: Placement[] = layout.staff.map(x => ({ id: `staff.${x.role}`, figure: STAFF_FIGURE[x.role], where: { cell: x.cell } }));
  for (const p of Object.values(s.patients)) {
    const figure = patientFigure(p);
    if (p.status === 'inRoom') {
      out.push({ id: p.id, figure, where: { cell: layout.spots.office } });
    } else if (p.status === 'waiting') {
      // только что пришедший — регистратура и медсестра (её витальные — уже в результатах);
      // вернувшийся с обследований — сразу в зал: врач с ним уже работал
      const since = s.t - p.arriveT;
      const fresh = p.step === 0;
      if (fresh && since < REGISTRATION) out.push({ id: p.id, figure, where: { cell: layout.spots.registration } });
      else if (fresh && since < REGISTRATION + TRIAGE) out.push({ id: p.id, figure, where: { cell: layout.spots.triage } });
      else out.push({ id: p.id, figure, where: { seat: true }, callable: s.current === undefined });
    } else if (p.status === 'away') {
      out.push({ id: p.id, figure, where: awayWhere(db, layout, p, s.t) });
    } else if (p.status === 'done' && p.closed && s.t - p.closed.at < LEAVING) {
      out.push({ id: p.id, figure, where: { cell: layout.entrance }, leaving: true });
    }
    // coming — ещё не пришёл; left и unseen — ушли, их на карте нет
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

