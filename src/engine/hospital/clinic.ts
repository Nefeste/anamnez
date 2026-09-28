// Амбулатория практики (spec 2026-09-first-shift; с 0.0.19 — spec 2026-09-own-hospital). План
// строит движок стройки из записи каталога `preset.clinic` — теми же командами, что у игрока в
// песочнице; здесь он становится местами, которые знает карта смены: где стоит персонал, куда
// встаёт пациент, стулья зоны ожидания и скамьи коридора. Сетка — та же, что была планом кодом
// в 0.0.13–0.0.18.
import type { ContentDb, Id } from '../../content/types';
import { type Plan, planOf, presetHospital } from './build';
import type { HospitalLayout, Room, RoomType } from './grid';

export type Cell = [number, number];

export type StaffRole = 'registrar' | 'nurse' | 'doctor' | 'procedureNurse' | 'labTech' | 'ecgNurse' | 'radiographer' | 'radiologist';

export interface ClinicLayout extends HospitalLayout {
  /** вход и выход — дверь на улицу */
  entrance: Cell;
  /** персонал на местах; `id` — когда фигурок одной роли несколько (две медсестры ЭКГ) */
  staff: { role: StaffRole; cell: Cell; id?: string }[];
  /** куда встаёт или садится пациент */
  spots: { registration: Cell; triage: Cell; office: Cell; procedure: Cell; ecg: Cell; xray: Cell };
  /** стулья зоны ожидания — очередь к врачу; ближний к двери ряд первым */
  seats: Cell[];
  /** скамьи в коридоре — ждут результатов обследований */
  benches: Cell[];
}

/** Должность в помещении → фигурка карты смены: подпись и «зачем он» — в i18n (`shift.map`). */
const FIGURE: Record<string, StaffRole> = {
  'room.reception|role.registrar': 'registrar',
  'room.triage|role.nurse': 'nurse',
  'room.office|role.doctor': 'doctor',
  'room.procedure|role.nurse': 'procedureNurse',
  'room.lab|role.lab_tech': 'labTech',
  'room.ecg|role.nurse': 'ecgNurse',
  'room.xray|role.radiographer': 'radiographer',
  'room.xray|role.radiologist': 'radiologist',
};

const SPOT: Record<keyof ClinicLayout['spots'], Id> = {
  registration: 'room.reception', triage: 'room.triage', office: 'room.office', procedure: 'room.procedure', ecg: 'room.ecg', xray: 'room.xray',
};

/** План и штат (помещение, должность) → места карты смены. Врач — в первом кабинете врача. */
export function layoutOf(plan: Plan, staff: { room: string; role: Id }[]): ClinicLayout {
  const rooms: Room[] = plan.rooms.map(r => ({
    id: r.id, type: r.type.slice('room.'.length) as RoomType, x: r.x, y: r.y, w: r.w, h: r.h, door: r.door[0] ?? [r.x, r.y],
  }));
  const office = plan.rooms.find(r => r.type === 'room.office');
  const people = [...(office ? [{ room: office.id, role: 'role.doctor' }] : []), ...staff];
  const placed = people.flatMap(({ room, role }) => {
    const r = plan.rooms.find(x => x.id === room);
    const figure = r && FIGURE[`${r.type}|${role}`];
    const cell = r?.staff[role];
    return figure && cell ? [{ role: figure, cell, room }] : [];
  });
  // одна фигурка роли — прежний номер (staff.nurse); несколько — ещё и помещение
  const count = (f: StaffRole) => placed.filter(x => x.role === f).length;
  const staffOut = placed.map(x => (count(x.role) > 1 ? { role: x.role, cell: x.cell, id: `${x.role}.${x.room}` } : { role: x.role, cell: x.cell }));
  const spot = (type: Id): Cell => plan.rooms.find(r => r.type === type)?.patient ?? plan.entrance;
  const spots = Object.fromEntries(Object.entries(SPOT).map(([k, type]) => [k, spot(type)])) as ClinicLayout['spots'];
  return {
    grid: plan.grid,
    rooms,
    objects: plan.objects,
    entrance: plan.entrance,
    staff: staffOut,
    spots,
    seats: plan.rooms.flatMap(r => r.seats),
    benches: plan.objects.filter(o => o.kind === 'bench').map(o => [o.x, o.y] as Cell),
  };
}

/**
 * План без пустой улицы вокруг: на карте смены своя больница — во всю ширину экрана, как
 * практика. Клетки сдвигаются к углу построенного.
 */
export function cropPlan(plan: Plan): Plan {
  const { w, h, cells } = plan.grid;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (cells[y * w + x] === 0) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  if (x1 < 0 || (x0 === 0 && y0 === 0 && x1 === w - 1 && y1 === h - 1)) return plan;
  const nw = x1 - x0 + 1;
  const nh = y1 - y0 + 1;
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) out[y * nw + x] = cells[(y + y0) * w + (x + x0)];
  const at = (c: Cell): Cell => [c[0] - x0, c[1] - y0];
  return {
    grid: { w: nw, h: nh, cells: out },
    rooms: plan.rooms.map(r => ({
      ...r, x: r.x - x0, y: r.y - y0, door: r.door.map(at), staff: Object.fromEntries(Object.entries(r.staff).map(([k, c]) => [k, at(c)])),
      ...(r.patient ? { patient: at(r.patient) } : {}), seats: r.seats.map(at), slots: r.slots.map(at),
    })),
    objects: plan.objects.map(o => ({ ...o, x: o.x - x0, y: o.y - y0 })),
    entrance: at(plan.entrance),
    connected: plan.connected,
  };
}

/** Готовая амбулатория практики: из записи `preset.clinic` со штатом из неё же. */
export function clinicLayout(db: ContentDb): ClinicLayout {
  const p = db.presets['preset.clinic'];
  const plan = planOf(db, presetHospital(db, p).hospital);
  return layoutOf(plan, p.staff.map(s => ({ room: `r${s.room + 1}`, role: s.role })));
}
