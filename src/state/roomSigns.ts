// Что показывает помещение на карте смены (spec 2026-09-living-map, часть 23): идут ли анализы
// лаборатории, сколько ждут этот кабинет или аппарат, нет ли нужной должности. Выводится из
// смены, а не хранится: сохранения прежние. Лампа над дверью и свет ЭКГ и рентгена горят, пока
// человек на карте там, где с ним что-то делают, — это считает карта (walkers.ts): на ×4 часы
// смены обгоняют идущих.
import type { ClinicLayout } from '@/engine/hospital/clinic';
import type { ShiftState } from '@/engine/shift/types';

export interface RoomSign {
  /** помещение — номер в плане */
  id: string;
  /** лаборатория: идут её анализы — анализаторы светятся */
  lit: boolean;
  /** сколько ждут этот кабинет или аппарат */
  queue: number;
  /** не работает: нет нужной должности (своя больница) */
  noStaff: boolean;
}

/** У каких помещений лампа над дверью: туда входят к врачу или медсестре на приём и процедуру. */
export const LAMP_ROOMS: ReadonlySet<string> = new Set(['office', 'triage', 'procedure', 'ecg', 'xray']);
/** К аппаратам этих помещений ждут на скамье. */
const EXAM_ROOMS: ReadonlySet<string> = new Set(['ecg', 'xray']);

/**
 * Знаки помещений на сейчас:
 * - свет лаборатории — анализы из неё ещё не готовы, а кровь уже взяли;
 * - очередь — к вашему кабинету: ждущие вас (новые и ваши с результатами); к кабинету нанятого
 *   врача — его пациенты с результатами; к аппарату — кто ждёт его на скамье;
 * - нет персонала — помещения из `down` (своя больница: не работает без должности).
 */
export function roomSigns(layout: ClinicLayout, s: ShiftState, down: ReadonlySet<string> = new Set()): RoomSign[] {
  const signs = new Map(layout.rooms.map(r => [r.id, { id: r.id, lit: false, queue: 0, noStaff: down.has(r.id) }]));
  const typeOf = new Map(layout.rooms.map(r => [r.id, r.type]));
  const all = Object.values(s.patients);
  for (const p of all) {
    // лаборатория: анализаторы работают, пока анализ не готов, после забора крови
    for (const x of p.pending) {
      if (!x.room || typeOf.get(x.room) !== 'lab') continue;
      if ((x.end ?? x.start ?? x.readyAt) <= s.t && s.t < x.readyAt) signs.get(x.room)!.lit = true;
    }
    // на скамье в очереди к аппарату: ближайшее обследование, которое ещё не началось
    if (p.status === 'away') {
      const next = p.pending.filter(x => x.room && (x.start ?? 0) > s.t && EXAM_ROOMS.has(typeOf.get(x.room) ?? '')).sort((a, b) => (a.start ?? 0) - (b.start ?? 0))[0];
      if (next?.room) signs.get(next.room)!.queue++;
    }
  }

  // очередь к врачам: ваши — в общей очереди без врача; у нанятого — его пациенты с результатами
  const mine = layout.mine ?? layout.rooms.find(r => r.type === 'office')?.id;
  const office = new Map((s.staff ?? []).flatMap(m => (m.room ? [[m.id, m.room] as const] : [])));
  for (const p of all) {
    if (p.status !== 'waiting') continue;
    const room = p.by === undefined ? mine : office.get(p.by);
    const sign = room === undefined ? undefined : signs.get(room);
    if (sign) sign.queue++;
  }
  return layout.rooms.map(r => signs.get(r.id)!);
}
