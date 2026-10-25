// Кто где на карте амбулатории (spec 2026-09-first-shift): выводится из состояния смены, а не
// хранится — сохранение прежнее, и карта после загрузки та же. Пришедший идёт в регистратуру,
// к медсестре, садится в зале ожидания; вызванный — в кабинет врача; отпущенный на
// обследования — в процедурную, на ЭКГ или рентген на время процедуры, а своей очереди к
// аппарату и результатов ждёт на скамье; принятый и не дождавшийся уходят к выходу. Как люди
// идут между местами, решает карта (src/render/map); что человек делает — подпись под картой.
import { db } from '@/content';
import type { ContentDb, Exam, Id } from '@/content/types';
import { fnv1a } from '@/engine/core/hash';
import { type Cell, type ClinicLayout, clinicLayout, FIGURE, type StaffRole } from '@/engine/hospital/clinic';
import { walkable } from '@/engine/hospital/grid';
import { inBox, inIcu, inRicu } from '@/engine/shift/engine';
import { HANDOFF, REGISTRATION, type ShiftPatient, type ShiftState, TRIAGE } from '@/engine/shift/types';
import { lookOf } from '@/render/look';
import { type Figure as Look, patientFigure, staffFigure, type Uniform } from '@/render/map/figures';
import { type Life, restPlaces, toiletPlaces } from './life';

/** Вид фигурки: персонал — по роли, пациент — по срочности (цвет — не единственный признак: 09-game-design.md §13). */
export type Figure = 'doctor' | 'nurse' | 'staff' | 'patient' | 'patientYellow' | 'patientRed';

/**
 * Место: клетка, стул в зале ожидания или скамья в коридоре — их раздаёт карта; `near` — скамья ближе к этой клетке: к
 * двери, куда он ждёт (spec 2026-10-clinic-flow).
 */
export type Where = { cell: Cell } | { seat: true } | { bench: true; near?: Cell };

/** Помещение, где обследование делают с пациентом: анализы — забор в процедурной. */
export type ExamRoom = 'xray' | 'ecg' | 'lab' | 'ultrasound' | 'ct' | 'mri' | 'endoscopy';

/** Что человек делает: карта по этому ведёт его, подпись под картой — рассказывает. */
export type Doing =
  | { kind: 'staff'; role: StaffRole }
  /** медсестра процедурной несёт пробирки в лабораторию (spec 2026-10-clinic-flow) */
  | { kind: 'carry'; role: StaffRole }
  | { kind: 'registration' }
  | { kind: 'triage' }
  /** очередь в регистратуру и к медсестре доврачебного кабинета (spec 2026-10-clinic-flow) */
  | { kind: 'registrationQueue' }
  | { kind: 'triageQueue' }
  | { kind: 'waiting' }
  /** в кабинете врача; `by` — у нанятого врача (номер человека из штата) */
  | { kind: 'office'; by?: string }
  | { kind: 'exam'; room: ExamRoom }
  | { kind: 'examQueue'; room: ExamRoom }
  | { kind: 'results'; readyAt: number }
  | { kind: 'leaving' }
  | { kind: 'left' }
  /** лежит в палате своей больницы; `days` — сутки в стационаре (spec 2026-09-chapter-2, часть 26); `op` — ждёт этой операции (часть 28) */
  | { kind: 'ward'; days: number; op?: Id; icu?: true; ricu?: true; box?: true }
  /** на операционном столе: идёт операция `tx` до `end` — время смены (часть 28) */
  | { kind: 'surgery'; tx: Id; end: number }
  /** привезла скорая (часть 27): ждёт сортировки, ждёт врача, на каталке у входа — мест нет, у вас на осмотре */
  | { kind: 'ambulance'; state: 'unsorted' | 'waiting' | 'door' | 'withYou' }
  /** «код синий» (spec 2026-10-code-blue): медсестра смотровой и анестезиолог-реаниматолог — у койки остановки сердца */
  | { kind: 'code'; role: StaffRole }
  /**
   * живой фон (spec 2026-10-living-background): ждущий приёма — в кабинке санузла (`stall` — номер кабинки на карте), моет
   * руки, ждёт у двери, когда кабинки заняты
   */
  | { kind: 'toilet'; stall: number }
  | { kind: 'wash' }
  | { kind: 'toiletQueue' }
  /** перерыв в ординаторской — у кофеварки и за столом; нанятый врач между приёмами читает */
  | { kind: 'coffee'; role: StaffRole }
  | { kind: 'rest'; role: StaffRole }
  | { kind: 'reading'; role: StaffRole };

export interface Placement {
  id: string;
  figure: Figure;
  /** как выглядит на карте: пациент — как на портрете, персонал — форма по должности */
  look: Look;
  /** как выглядит в дверях, если иначе: без цвета срочности (spec 2026-10-clinic-flow) — его определят внутри */
  door?: Look;
  where: Where;
  doing: Doing;
  /** пациент уходит: дошёл до выхода — исчезает */
  leaving?: boolean;
  /** в очереди к врачу, и кабинет свободен: можно пригласить */
  callable?: boolean;
}

/** План амбулатории — один на всю игру: по нему и места в смене, и карта. */
export const CLINIC = clinicLayout(db);

/** Сколько игровых секунд новый пациент у регистратуры и у медсестры, прежде чем сесть, — как в движке. */
export { REGISTRATION, TRIAGE } from '@/engine/shift/types';
/** Сколько принятый ещё виден по дороге к выходу. */
export const LEAVING = 10 * 60;
/**
 * Сколько игровых секунд бригада «код синий» у койки (spec 2026-10-code-blue): разряд, ритм и наблюдение после него —
 * и чтобы анестезиолог-реаниматолог из дальней палаты успел добежать, пока медсестра ещё там.
 */
export const CODE = 10 * 60;

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
  surgeon: 'doctor',
  anesthetist: 'doctor',
  orNurse: 'nurse',
  sonographer: 'doctor',
  icuDoctor: 'doctor',
  icuNurse: 'nurse',
  ctTech: 'staff',
  ctDoctor: 'staff',
  mriTech: 'staff',
  mriDoctor: 'staff',
  endoscopist: 'doctor',
  endoscopyNurse: 'nurse',
  ricuDoctor: 'doctor',
  ricuNurse: 'nurse',
  erNurse: 'nurse',
};

/** Срочность на фигурке — та, что определили: до медсестры (spec 2026-10-clinic-flow) и без неё — как у всех. */
const urgencyOf = (p: ShiftPatient): 0 | 1 | 2 => (p.triaged === false ? 0 : p.triage === 'red' ? 2 : p.triage === 'yellow' ? 1 : 0);

function figureOf(p: ShiftPatient): Figure {
  const u = urgencyOf(p);
  return u === 2 ? 'patientRed' : u === 1 ? 'patientYellow' : 'patient';
}

const UNIFORM_OF: Record<Figure, Uniform | undefined> = { doctor: 'doctor', nurse: 'nurse', staff: 'staff', patient: undefined, patientYellow: undefined, patientRed: undefined };

/** Форма фигурки на карте: врач — белый халат, медсестра — голубой костюм, остальные — сиреневая блуза. */
export const uniformOfFigure = (r: StaffRole): Uniform => UNIFORM_OF[STAFF_FIGURE[r]] ?? 'staff';

/**
 * Форма на портрете сотрудника (FR-AV-4, 0.5.7) — как у его фигурки на карте: должность в разных помещениях одета
 * одинаково (portraits.test). Должности нет на карте — врач.
 */
export function uniformOfRole(role: Id): Uniform {
  const post = Object.keys(FIGURE).find(k => k.endsWith(`|${role}`));
  return post ? uniformOfFigure(FIGURE[post]) : 'doctor';
}

/** Пациент на карте — с тем же лицом, что на портрете в карте пациента (caseView). */
function lookOfPatient(p: ShiftPatient): Look {
  const { seed, sex, age } = p.patient;
  return patientFigure(lookOf(fnv1a(`${seed}:portrait`), sex, age), urgencyOf(p));
}

/**
 * В дверях пришедший сам — без цвета срочности (spec 2026-10-clinic-flow): его определит медсестра; скорая сообщает свой
 * заранее. Тот же вид, что `lookOfPatient`, — нет.
 */
function doorOfPatient(p: ShiftPatient): Look | undefined {
  if (p.kind === 'ambulance' || urgencyOf(p) === 0) return undefined;
  const { seed, sex, age } = p.patient;
  return patientFigure(lookOf(fnv1a(`${seed}:portrait`), sex, age), 0);
}

const EXAM_ROOM: Record<string, ExamRoom> = { 'room.xray': 'xray', 'room.ecg': 'ecg', 'room.lab': 'lab', 'room.ultrasound': 'ultrasound', 'room.ct': 'ct', 'room.mri': 'mri', 'room.endoscopy': 'endoscopy' };

/** Где обследование делают с пациентом; анализы — забор в процедурной. Нет помещения — в кабинете. */
function examCell(layout: ClinicLayout, room: ExamRoom): Cell {
  if (room === 'lab') return layout.spots.procedure;
  return layout.spots[room];
}

/**
 * Отпущенный на обследования: во время процедуры — в её помещении; до неё — на скамье, в
 * очереди к аппарату; после — на скамье, ждёт результатов. Привезённый скорой ждёт на своей койке.
 */
function awayPlace(db: ContentDb, layout: ClinicLayout, p: ShiftPatient, t: number): { where: Where; doing: Doing } {
  // привезённый скорой лежит в смотровой: ждёт там же, а на снимок и в процедурную его везут
  const bed = p.bay ? layout.beds[p.bay.room]?.[p.bay.bed] : undefined;
  let next: { room: ExamRoom; start: number; door: Cell } | undefined;
  for (const x of p.pending) {
    const e: Exam | undefined = db.exams[x.exam];
    const room = e?.room ? EXAM_ROOM[e.room] : undefined;
    if (!e || !room) continue;
    // когда сама процедура — движок записал (с 0.0.21); прежде — по записанным минутам от готовности
    const total = (e.time.procedure + (e.time.report ?? 0) + (e.time.turnaround ?? 0)) * 60;
    const start = x.start ?? x.readyAt - total;
    const end = x.end ?? start + e.time.procedure * 60;
    // кровь — в той процедурной, где её берут (spec 2026-10-clinic-flow); взяли на месте — на койке
    const cell = (x.draw !== undefined && x.draw === p.bay?.room && bed) || (x.draw !== undefined && layout.desks?.[x.draw]) || examCell(layout, room);
    if (t >= start && t < end) return { where: { cell }, doing: { kind: 'exam', room } };
    if (start > t && (!next || start < next.start)) next = { room, start, door: doorAt(layout, cell) };
  }
  // очередь к аппарату и в процедурную — на скамье ближе к их двери (spec 2026-10-clinic-flow); лежащий — на койке
  if (next) return { where: bed ? { cell: bed } : { bench: true, near: next.door }, doing: { kind: 'examQueue', room: next.room } };
  return { where: bed ? { cell: bed } : { bench: true }, doing: { kind: 'results', readyAt: Math.max(...p.pending.map(x => x.readyAt), t) } };
}

/**
 * Ждёт врача — в зале. Без очереди (spec 2026-10-clinic-flow): пока медсестра его не померила — у её двери и у её стола,
 * позвать можно и тогда. Сохранение до 0.6.9: только что пришедший — регистратура и медсестра по минутам от прихода
 * (0.5.12); вернувшийся с обследований — сразу в зал.
 */
function waitingPlace(layout: ClinicLayout, s: ShiftState, p: ShiftPatient, triage: boolean): { where: Where; doing: Doing } {
  const n = p.intake?.rush && p.calledT === undefined && !p.done.includes('exam.vitals') ? p.intake.nurse : undefined;
  if (n && s.t < n.start) return { where: { bench: true, near: doorOf(layout, n.room) ?? layout.spots.triage }, doing: { kind: 'triageQueue' } };
  if (n) return { where: { cell: layout.desks?.[n.room] ?? layout.spots.triage }, doing: { kind: 'triage' } };
  const since = s.t - p.arriveT;
  if (!p.intake && p.step === 0 && since < REGISTRATION) return { where: { cell: layout.spots.registration }, doing: { kind: 'registration' } };
  if (!p.intake && p.step === 0 && triage && since < REGISTRATION + TRIAGE) return { where: { cell: layout.spots.triage }, doing: { kind: 'triage' } };
  return { where: { seat: true }, doing: { kind: 'waiting' } };
}

/** Кто за кем в очереди в регистратуру (spec 2026-10-clinic-flow): по тому, когда его начнут оформлять, — у каждой своя. */
function regLine(s: ShiftState): Map<string, number> {
  const out = new Map<string, number>();
  const ahead = new Map<string, number>();
  const waiting = Object.values(s.patients).filter(p => p.status === 'intake' && p.intake && s.t < p.intake.reg.start)
    .sort((a, b) => a.intake!.reg.start - b.intake!.reg.start || (a.id < b.id ? -1 : 1));
  for (const p of waiting) {
    const n = ahead.get(p.intake!.reg.room) ?? 0;
    out.set(p.id, n);
    ahead.set(p.intake!.reg.room, n + 1);
  }
  return out;
}

/**
 * Оформляется (spec 2026-10-clinic-flow): ждёт регистратора — в очереди от его стола к двери и дальше по коридору; у
 * регистратора — у стола; ждёт медсестру — на скамье ближе к её двери; у медсестры — у её стола.
 */
function intakePlace(layout: ClinicLayout, s: ShiftState, p: ShiftPatient, inLine: ReadonlyMap<string, number>): { where: Where; doing: Doing } {
  const { reg, nurse } = p.intake!;
  if (s.t < reg.start) return { where: { cell: lineCell(layout, reg.room, inLine.get(p.id) ?? 0) }, doing: { kind: 'registrationQueue' } };
  if (s.t < reg.end || !nurse) return { where: { cell: layout.desks?.[reg.room] ?? layout.spots.registration }, doing: { kind: 'registration' } };
  if (s.t < nurse.start) return { where: { bench: true, near: doorOf(layout, nurse.room) ?? layout.spots.triage }, doing: { kind: 'triageQueue' } };
  return { where: { cell: layout.desks?.[nurse.room] ?? layout.spots.triage }, doing: { kind: 'triage' } };
}

/**
 * Кто несёт пробирки (spec 2026-10-clinic-flow): процедурная, откуда их понесли, → дверь лаборатории, куда их несут;
 * медсестра там, пока проба не дошла и она её не отдала.
 */
function carriers(layout: ClinicLayout, s: ShiftState): Map<string, Cell> {
  const out = new Map<string, Cell>();
  for (const p of Object.values(s.patients)) {
    for (const x of p.pending) {
      if (x.draw === undefined || x.lab === undefined || x.end === undefined || !x.room || x.draw === p.bay?.room) continue;
      // понесла, когда к ней нет очереди (spec 2026-10-code-blue), — не сразу после забора
      if ((x.sent ?? x.end) <= s.t && s.t < x.lab + HANDOFF) out.set(x.draw, doorOf(layout, x.room) ?? layout.spots.procedure);
    }
  }
  return out;
}

/** Помещение, где клетка; в коридоре — undefined. */
const roomAt = (layout: ClinicLayout, [x, y]: Cell): string | undefined =>
  layout.rooms.find(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)?.id;

/** Дверь помещения по номеру; нет такого — undefined. */
const doorOf = (layout: ClinicLayout, room: string): Cell | undefined => layout.rooms.find(r => r.id === room)?.door;

/** Дверь помещения, где эта клетка; клетка в коридоре — она сама. */
const doorAt = (layout: ClinicLayout, [x, y]: Cell): Cell =>
  layout.rooms.find(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)?.door ?? [x, y];

const lines = new WeakMap<ClinicLayout, Map<string, Cell[]>>();

/** k-е место очереди к столу помещения (spec 2026-10-clinic-flow); мест меньше — последнее. */
export function lineCell(layout: ClinicLayout, room: string, k: number): Cell {
  let byRoom = lines.get(layout);
  if (!byRoom) {
    byRoom = new Map();
    lines.set(layout, byRoom);
  }
  let cells = byRoom.get(room);
  if (!cells) {
    cells = lineOf(layout, room);
    byRoom.set(room, cells);
  }
  return cells[Math.min(k, cells.length - 1)] ?? layout.desks?.[room] ?? layout.spots.registration;
}

/**
 * Очередь к столу: в помещении — от стола к двери по свободным клеткам (без мебели и персонала), за дверью — по коридору
 * в ту сторону, где свободнее, до шести мест.
 */
function lineOf(layout: ClinicLayout, room: string): Cell[] {
  const r = layout.rooms.find(x => x.id === room);
  const desk = layout.desks?.[room];
  if (!r || !desk) return [];
  const { grid } = layout;
  const w = grid.w;
  const at = (x: number, y: number) => y * w + x;
  const busy = new Set([...layout.objects.map(o => at(o.x, o.y)), ...layout.staff.map(x => at(x.cell[0], x.cell[1]))]);
  const inside = (x: number, y: number) => x > r.x && y > r.y && x < r.x + r.w - 1 && y < r.y + r.h - 1;
  const start = at(desk[0], desk[1]);
  const goal = at(r.door[0], r.door[1]);
  const prev = new Map<number, number>([[start, -1]]);
  const queue = [start];
  for (let head = 0; head < queue.length && !prev.has(goal); head++) {
    const i = queue[head];
    const x = i % w;
    const y = (i - x) / w;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      const n = at(nx, ny);
      if (prev.has(n) || (n !== goal && (!inside(nx, ny) || busy.has(n) || !walkable(grid, nx, ny)))) continue;
      prev.set(n, i);
      queue.push(n);
    }
  }
  const cells: Cell[] = [];
  for (let i = prev.get(goal); i !== undefined && i !== -1 && i !== start; i = prev.get(i)) cells.unshift([i % w, (i - (i % w)) / w]);
  // за дверью: шаг наружу, потом вдоль стены — в сторону, где больше свободных клеток коридора
  const [dx, dy] = r.door;
  const outward: Cell = dy === r.y ? [0, -1] : dy === r.y + r.h - 1 ? [0, 1] : dx === r.x ? [-1, 0] : [1, 0];
  const first: Cell = [dx + outward[0], dy + outward[1]];
  if (!walkable(grid, first[0], first[1])) return cells;
  const along = (dir: Cell): Cell[] => {
    const run: Cell[] = [first];
    for (let k = 1; k < 6; k++) {
      const c: Cell = [first[0] + dir[0] * k, first[1] + dir[1] * k];
      if (c[0] < 0 || c[1] < 0 || c[0] >= w || c[1] >= grid.h || !walkable(grid, c[0], c[1])) break;
      run.push(c);
    }
    return run;
  };
  const sides: [Cell, Cell] = outward[0] === 0 ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
  const a = along(sides[0]);
  const b = along(sides[1]);
  return [...cells, ...(b.length > a.length ? b : a)];
}

/**
 * Кто где на карте. `life` — живой фон (spec 2026-10-living-background): санузел, перерывы, чтение; без него — как до
 * 0.6.12: проверки карты и смены его не ждут.
 */
export function placements(db: ContentDb, layout: ClinicLayout, s: ShiftState, life?: Life): Placement[] {
  const carrying = carriers(layout, s);
  const out: Placement[] = layout.staff.map(x => {
    const id = `staff.${x.id ?? x.role}`;
    const figure = STAFF_FIGURE[x.role];
    const look = staffFigure(UNIFORM_OF[figure] ?? 'staff', id);
    // несёт пробирки — у двери лаборатории (spec 2026-10-clinic-flow)
    const to = x.role === 'procedureNurse' ? carrying.get(roomAt(layout, x.cell) ?? '') : undefined;
    return to ? { id, figure, look, where: { cell: to }, doing: { kind: 'carry', role: x.role } } : { id, figure, look, where: { cell: x.cell }, doing: { kind: 'staff', role: x.role } };
  });
  codeTeam(layout, s, out);
  if (life) lifeOfStaff(layout, s, life, out);
  // своя больница без доврачебного кабинета: от регистратуры — сразу в зал
  const triage = layout.rooms.some(r => r.type === 'triage');
  const exit = { cell: layout.entrance };
  const inLine = regLine(s);
  // живой фон: кто из ждущих в зале сейчас в санузле или у его двери
  const toilet = life
    ? toiletPlaces(layout, s, life, Object.values(s.patients).filter(p => p.status === 'waiting' && p.kind !== 'ambulance' && waitingPlace(layout, s, p, triage).doing.kind === 'waiting'))
    : undefined;
  for (const p of Object.values(s.patients)) {
    const figure = figureOf(p);
    const look = lookOfPatient(p);
    const from = out.length;
    if (p.kind === 'ambulance' && (p.status === 'waiting' || p.status === 'inRoom')) {
      // скорая (spec 2026-09-chapter-2, часть 27): на месте в смотровой приёмного, мест нет — на
      // каталке у входа; смотрят его там же, в кабинет он не идёт
      const bay = p.bay ? layout.beds[p.bay.room]?.[p.bay.bed] : undefined;
      const state = p.status === 'inRoom' ? 'withYou' : !p.sorted ? 'unsorted' : bay ? 'waiting' : 'door';
      const callable = p.status === 'waiting' && p.sorted === true && s.current === undefined;
      out.push({ id: p.id, figure, look, where: bay ? { cell: bay } : exit, doing: { kind: 'ambulance', state }, callable });
    } else if (p.status === 'intake' && p.intake) {
      out.push({ id: p.id, figure, look, ...intakePlace(layout, s, p, inLine) });
    } else if (p.status === 'inRoom' && p.out && s.t < p.out.until) {
      // ушёл от врача на обследование (0.5.12): в его помещении или в очереди к нему
      out.push({ id: p.id, figure, look, ...awayPlace(db, layout, p, s.t) });
    } else if (p.status === 'inRoom' && p.by) {
      // у нанятого врача — в его кабинете (spec 2026-09-hired-doctors)
      const room = s.staff?.find(m => m.id === p.by)?.room;
      out.push({ id: p.id, figure, look, where: { cell: (room && layout.offices[room]) || layout.spots.office }, doing: { kind: 'office', by: p.by } });
    } else if (p.status === 'inRoom') {
      out.push({ id: p.id, figure, look, where: { cell: layout.spots.office }, doing: { kind: 'office' } });
    } else if (p.status === 'waiting') {
      // пригласить можно любого из очереди, как из списка, — пока кабинет свободен; пациент нанятого врача ждёт его, а не
      // вас (spec 2026-09-hired-doctors)
      const callable = s.current === undefined && p.by === undefined;
      out.push({ id: p.id, figure, look, ...(toilet?.get(p.id) ?? waitingPlace(layout, s, p, triage)), callable });
    } else if (p.status === 'away') {
      out.push({ id: p.id, figure, look, ...awayPlace(db, layout, p, s.t) });
    } else if (p.status === 'done' && p.closed && s.t - p.closed.at < LEAVING) {
      out.push({ id: p.id, figure, look, where: exit, doing: { kind: 'leaving' }, leaving: true });
    } else if (p.status === 'admitted' && p.stay) {
      // идёт операция — на операционном столе (часть 28); иначе лежит на своей койке; палату
      // снесли — на карте его нет, пока не выпишут
      const op = p.stay.op;
      const table = op && !op.done && op.start !== undefined && op.start <= s.t && op.room ? layout.tables?.[op.room] : undefined;
      const bed = layout.beds[p.stay.room]?.[p.stay.bed];
      if (table && op) out.push({ id: p.id, figure, look, where: { cell: table }, doing: { kind: 'surgery', tx: op.tx, end: op.end ?? s.t } });
      else if (bed) {
        // в палате интенсивной терапии — своя строка (spec 2026-10-chapter-3, часть 38а)
        out.push({
          id: p.id, figure, look, where: { cell: bed },
          doing: {
            kind: 'ward', days: Math.max(0, s.day - p.stay.since), ...(op && !op.done ? { op: op.tx } : {}), ...(inIcu(db, s, p) ? { icu: true as const } : {}),
            // в реанимации — своя строка (spec 2026-10-chapter-4, часть 47), в боксе — тоже (часть 49а)
            ...(inRicu(db, s, p) ? { ricu: true as const } : {}),
            ...(inBox(db, s, p) ? { box: true as const } : {}),
          },
        });
      }
    } else if (p.status === 'left' && s.t - (p.queuedT + p.patience) < LEAVING) {
      // не дождался: ушёл, когда кончилось терпение (engine.ts, событие patience)
      out.push({ id: p.id, figure, look, where: exit, doing: { kind: 'left' }, leaving: true });
    }
    // coming — ещё не пришёл; unseen — день закрыт, их на карте нет
    const door = out.length > from ? doorOfPatient(p) : undefined;
    if (door) out[from].door = door;
  }
  return out;
}

/**
 * Живой фон персонала (spec 2026-10-living-background): регистратор и медсестра на перерыве — в ординаторской; нанятый
 * врач, у которого в кабинете никого нет, читает за столом.
 */
function lifeOfStaff(layout: ClinicLayout, s: ShiftState, life: Life, staff: Placement[]) {
  const atDesk = staff.flatMap(x => (x.doing.kind === 'staff' && 'cell' in x.where ? [{ id: x.id, role: x.doing.role, cell: x.where.cell }] : []));
  const rest = restPlaces(layout, s, life, atDesk);
  // кабинеты нанятых врачей, где сейчас пациент
  const busy = new Set<string>();
  for (const p of Object.values(s.patients)) {
    if (p.status !== 'inRoom' || p.by === undefined) continue;
    const room = s.staff?.find(m => m.id === p.by)?.room;
    if (room) busy.add(room);
  }
  for (const x of staff) {
    const r = rest.get(x.id);
    if (r) {
      x.where = r.where;
      x.doing = r.doing;
    } else if (x.doing.kind === 'staff' && x.doing.role === 'therapist' && !busy.has(x.id.slice('staff.therapist.'.length))) {
      x.doing = { kind: 'reading', role: 'therapist' };
    }
  }
}

/**
 * «Код синий» (spec 2026-10-code-blue): остановка сердца у лежащего в смотровой приёмного — медсестра этой смотровой и
 * анестезиолог-реаниматолог палаты интенсивной терапии или реанимации `CODE` секунд у его койки; потом — на свои места.
 * С частью 95 — и остановка кровообращения без первой меры (`code`, spec 2026-10-first-measures).
 */
function codeTeam(layout: ClinicLayout, s: ShiftState, staff: Placement[]) {
  const on = (at: number | undefined) => at !== undefined && s.t >= at && s.t - at < CODE;
  for (const p of Object.values(s.patients)) {
    if (!p.bay || !(on(p.arrest) || on(p.code))) continue;
    const bed = layout.beds[p.bay.room]?.[p.bay.bed];
    if (!bed) continue;
    const room = p.bay.room;
    const nurse = staff.find(x => x.doing.kind === 'staff' && x.doing.role === 'erNurse' && 'cell' in x.where && roomAt(layout, x.where.cell) === room);
    const doctor = staff.find(x => x.doing.kind === 'staff' && (x.doing.role === 'icuDoctor' || x.doing.role === 'ricuDoctor'));
    const spots = beside(layout, bed);
    [nurse, doctor].forEach((x, i) => {
      if (!x || x.doing.kind !== 'staff' || !spots[i]) return;
      x.where = { cell: spots[i] };
      x.doing = { kind: 'code', role: x.doing.role };
    });
  }
}

/** Клетки у койки, куда встать: свободные от мебели и проходимые — сбоку, в ногах, у изголовья. */
function beside(layout: ClinicLayout, [x, y]: Cell): Cell[] {
  const taken = new Set(layout.objects.map(o => `${o.x},${o.y}`));
  const around: Cell[] = [[x, y + 1], [x - 1, y], [x + 1, y], [x - 1, y + 1], [x + 1, y + 1], [x, y - 1]];
  return around.filter(([cx, cy]) => walkable(layout.grid, cx, cy) && !taken.has(`${cx},${cy}`));
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

/**
 * Скамьи (spec 2026-10-clinic-flow): кто сел — сидит, как на стульях; новым — свободная ближе к `near` (к двери, куда он
 * ждёт), без неё — первая свободная; мест нет — -1.
 */
export function assignBenches(prev: ReadonlyMap<string, number>, items: readonly { id: string; near?: Cell }[], cells: readonly Cell[]): Map<string, number> {
  const next = new Map<string, number>();
  const taken = new Set<number>();
  for (const { id } of items) {
    const was = prev.get(id);
    if (was !== undefined && was >= 0 && !taken.has(was)) {
      next.set(id, was);
      taken.add(was);
    }
  }
  for (const { id, near } of items) {
    if (next.has(id)) continue;
    let free = -1;
    let best = Infinity;
    for (let i = 0; i < cells.length; i++) {
      if (taken.has(i)) continue;
      const d = near ? Math.abs(cells[i][0] - near[0]) + Math.abs(cells[i][1] - near[1]) : i;
      if (d < best) {
        best = d;
        free = i;
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

