// Амбулатория первой смены (spec 2026-09-first-shift, «Что увидит игрок»): план фиксированный,
// 30 × 17 клеток, клетка — метр (ADR 0014). Сверху — регистратура, медсестра, кабинет врача,
// процедурная, лаборатория; посередине — коридор со входом слева; снизу — зал ожидания, ЭКГ,
// рентген, санузел. Места людей — названные клетки: где стоит персонал, куда встаёт пациент.
import { CELL, type CellKind, type Grid, type HospitalLayout, type ObjectKind, type Placed, type Room, type RoomType } from './grid';

export type Cell = [number, number];

export type StaffRole = 'registrar' | 'nurse' | 'doctor' | 'procedureNurse' | 'labTech' | 'ecgNurse' | 'radiographer' | 'radiologist';

export interface ClinicLayout extends HospitalLayout {
  /** вход и выход — дверь на улицу */
  entrance: Cell;
  staff: { role: StaffRole; cell: Cell }[];
  /** куда встаёт или садится пациент */
  spots: { registration: Cell; triage: Cell; office: Cell; procedure: Cell; ecg: Cell; xray: Cell };
  /** стулья зала ожидания — очередь к врачу; передний ряд первым */
  seats: Cell[];
  /** скамьи в коридоре — ждут результатов обследований */
  benches: Cell[];
}

const W = 30;
const H = 17;

interface RoomPlan {
  type: RoomType;
  x: number;
  y: number;
  w: number;
  h: number;
  doors: Cell[];
  objects: [ObjectKind, number, number][];
}

// Помещения со стенами по контуру; соседние делят стену. Первый ряд внутри — под подпись
// помещения на карте: предметов в нём нет.
const ROOMS: RoomPlan[] = [
  { type: 'reception', x: 0, y: 0, w: 6, h: 7, doors: [[3, 6]], objects: [['desk', 2, 3], ['chair', 2, 2], ['cabinet', 1, 5], ['plant', 4, 5]] },
  { type: 'triage', x: 5, y: 0, w: 6, h: 7, doors: [[8, 6]], objects: [['desk', 7, 3], ['chair', 7, 2], ['couch', 9, 2], ['sink', 9, 5]] },
  { type: 'office', x: 10, y: 0, w: 8, h: 7, doors: [[13, 6]], objects: [['desk', 13, 3], ['chair', 13, 2], ['chair', 13, 4], ['couch', 16, 2], ['cabinet', 11, 3], ['sink', 16, 5], ['plant', 11, 5]] },
  { type: 'procedure', x: 17, y: 0, w: 6, h: 7, doors: [[19, 6]], objects: [['table', 19, 3], ['chair', 19, 4], ['cabinet', 21, 3], ['sink', 21, 5]] },
  { type: 'lab', x: 22, y: 0, w: 8, h: 7, doors: [[25, 6]], objects: [['machine', 24, 2], ['machine', 27, 2], ['table', 25, 4], ['table', 26, 4], ['cabinet', 28, 5], ['sink', 23, 5]] },
  {
    type: 'waiting', x: 0, y: 10, w: 13, h: 7, doors: [[4, 10], [5, 10], [6, 10], [7, 10]],
    objects: [
      ...[2, 3, 4, 5, 6, 7, 8, 9, 10].flatMap(x => [['chair', x, 12], ['chair', x, 14]] as [ObjectKind, number, number][]),
      ['plant', 1, 13], ['plant', 11, 15],
    ],
  },
  { type: 'ecg', x: 12, y: 10, w: 6, h: 7, doors: [[14, 10]], objects: [['couch', 15, 13], ['machine', 16, 12], ['cabinet', 13, 15]] },
  { type: 'xray', x: 17, y: 10, w: 8, h: 7, doors: [[20, 10]], objects: [['xray', 20, 13], ['cabinet', 23, 15], ['table', 18, 15], ['chair', 18, 14]] },
  { type: 'toilet', x: 24, y: 10, w: 6, h: 7, doors: [[26, 10]], objects: [['sink', 27, 12], ['sink', 25, 12]] },
];

const BENCHES: Cell[] = [[9, 9], [10, 9], [11, 9], [12, 9], [16, 9], [17, 9], [22, 9], [23, 9]];

export function clinicLayout(): ClinicLayout {
  const cells = new Uint8Array(W * H).fill(CELL.wall);
  const grid: Grid = { w: W, h: H, cells };
  const set = (x: number, y: number, c: CellKind) => {
    cells[y * W + x] = c;
  };
  // коридор во всю длину между рядами помещений; вход — дверь в левой стене
  for (let x = 1; x < W - 1; x++) for (let y = 7; y <= 9; y++) set(x, y, CELL.corridor);
  const entrance: Cell = [0, 8];
  set(entrance[0], entrance[1], CELL.door);

  const rooms: Room[] = [];
  const objects: Placed[] = [];
  for (const r of ROOMS) {
    for (let y = r.y + 1; y < r.y + r.h - 1; y++) for (let x = r.x + 1; x < r.x + r.w - 1; x++) set(x, y, CELL.floor);
    for (const [x, y] of r.doors) set(x, y, CELL.door);
    rooms.push({ id: `room.${r.type}`, type: r.type, x: r.x, y: r.y, w: r.w, h: r.h, door: r.doors[0] });
    for (const [kind, x, y] of r.objects) objects.push({ kind, x, y });
  }
  for (const [x, y] of BENCHES) objects.push({ kind: 'bench', x, y });

  return {
    grid,
    rooms,
    objects,
    entrance,
    staff: [
      { role: 'registrar', cell: [2, 2] },
      { role: 'nurse', cell: [7, 2] },
      { role: 'doctor', cell: [13, 2] },
      { role: 'procedureNurse', cell: [19, 2] },
      { role: 'labTech', cell: [25, 3] },
      { role: 'ecgNurse', cell: [14, 12] },
      { role: 'radiographer', cell: [22, 12] },
      // рентгенолог описывает снимки за столом того же кабинета
      { role: 'radiologist', cell: [18, 14] },
    ],
    spots: { registration: [2, 4], triage: [7, 4], office: [13, 4], procedure: [19, 4], ecg: [15, 13], xray: [20, 13] },
    seats: [2, 3, 4, 5, 6, 7, 8, 9, 10].map(x => [x, 12] as Cell).concat([2, 3, 4, 5, 6, 7, 8, 9, 10].map(x => [x, 14] as Cell)),
    benches: BENCHES,
  };
}
