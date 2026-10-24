// Кровь и проба (spec 2026-10-clinic-flow, замечания владельца 24.10.2026): в процедурной берут по одному — следующему
// начнут, когда медсестра отнесла пробирки в лабораторию и вернулась; анализ — с минуты, как проба дошла. На карте —
// кто в процедурной, кто ждёт на скамье, медсестра у двери лаборатории, пока отдаёт пробирки; лаборатория горит, когда
// проба дошла; привезённый скорой ждёт на своей койке. ОАК и мазок разом — почему сначала мазок: иначе его возьмут,
// только когда пациент вернётся.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { clinicLayout, layoutOf } from '../../src/engine/hospital/clinic';
import { walkSeconds } from '../../src/engine/hospital/walk';
import { apply, atDoctor, hospitalCtx, newCampaign, newShift } from '../../src/engine/shift/engine';
import { HANDOFF, type PendingResult, type ShiftPatient, type ShiftState } from '../../src/engine/shift/types';
import { placements } from '../../src/state/clinicMap';
import { roomSigns } from '../../src/state/roomSigns';

const layout = clinicLayout(db);
const CBC = 'exam.cbc';
const STREP = 'exam.strep_rapid';
const MIN = 60;

/** Двое в очереди врача; каждому по очереди назначен ОАК, оба отпущены ждать. */
function twoDraws(seed = 21): { s: ShiftState; a: ShiftPatient; b: ShiftPatient } {
  const s = newShift(db, { seed, season: 'winter' });
  for (let i = 0; i < 600 && s.queue.length < 2; i++) apply(db, s, { kind: 'advance', seconds: 60 });
  const [a, b] = s.queue.slice(0, 2).map(id => s.patients[id]);
  for (const p of [a, b]) {
    apply(db, s, { kind: 'call', id: p.id });
    apply(db, s, { kind: 'exam', exam: CBC });
    apply(db, s, { kind: 'sendAway' });
  }
  return { s, a, b };
}

const cbcOf = (p: ShiftPatient): PendingResult => p.pending.find(x => x.exam === CBC)!;
const until = (s: ShiftState, t: number) => apply(db, s, { kind: 'advance', seconds: Math.max(0, t - s.t) });

function rooms(s: ShiftState) {
  const plan = hospitalCtx(db, s).plan;
  const id = (type: string) => plan.rooms.find(r => r.type === type)!.id;
  const proc = id('room.procedure');
  const lab = id('room.lab');
  return { proc, lab, carry: walkSeconds(plan, proc, lab) };
}

describe('процедурная — по одному, пробирки несут в лабораторию', () => {
  test('двоим ОАК: второму начнут, когда медсестра отнесла пробирки первого и вернулась; анализ — с минуты, как проба дошла', () => {
    const { s, a, b } = twoDraws();
    const [x, y] = [cbcOf(a), cbcOf(b)];
    const { proc, lab, carry } = rooms(s);
    expect([x.draw, x.room, y.draw, y.room]).toEqual([proc, lab, proc, lab]);
    expect(carry).toBeGreaterThan(0);
    for (const z of [x, y]) {
      expect(z.end! - z.start!).toBe(db.exams[CBC].time.procedure * MIN);
      expect(z.lab).toBe(z.end! + carry);
      expect(z.readyAt).toBeGreaterThan(z.lab!);
    }
    // анализаторы те же — анализ идёт столько же
    expect(y.readyAt - y.lab!).toBe(x.readyAt - x.lab!);
    // второй дошёл раньше, чем медсестра вернулась, — ждёт её
    expect(y.start).toBe(x.end! + carry + HANDOFF + carry);
    expect(s.rooms[proc]).toBe(y.end! + carry + HANDOFF + carry);
  });

  test('на карте: первый — в процедурной, второй — на скамье; медсестра с пробирками — у двери лаборатории, лаборатория горит, когда проба дошла', () => {
    const { s, a, b } = twoDraws();
    const [x, y] = [cbcOf(a), cbcOf(b)];
    const { lab } = rooms(s);
    const door = layout.rooms.find(r => r.id === lab)!.door;
    const nurse = () => placements(db, layout, s).find(m => m.id === 'staff.procedureNurse')!;
    until(s, x.start! + 30);
    let map = placements(db, layout, s);
    expect(map.find(m => m.id === a.id)).toMatchObject({ where: { cell: layout.desks![x.draw!] }, doing: { kind: 'exam', room: 'lab' } });
    expect(map.find(m => m.id === b.id)).toMatchObject({ where: { bench: true }, doing: { kind: 'examQueue', room: 'lab' } });
    expect(nurse().doing.kind).toBe('staff');
    // взяли — несёт пробирки; проба ещё не дошла — анализаторы не работают
    until(s, x.end! + 1);
    expect(nurse()).toMatchObject({ where: { cell: door }, doing: { kind: 'carry', role: 'procedureNurse' } });
    expect(roomSigns(layout, s).find(r => r.id === lab)!.lit).toBe(false);
    map = placements(db, layout, s);
    expect(map.find(m => m.id === a.id)!.doing.kind).toBe('results');
    // дошла — анализ идёт; отдала — вернулась на место
    until(s, x.lab! + 1);
    expect(roomSigns(layout, s).find(r => r.id === lab)!.lit).toBe(true);
    until(s, x.lab! + HANDOFF);
    expect(nurse().doing.kind).toBe('staff');
    until(s, y.start! + 30);
    expect(placements(db, layout, s).find(m => m.id === b.id)).toMatchObject({ where: { cell: layout.desks![y.draw!] }, doing: { kind: 'exam', room: 'lab' } });
  });
});

describe('ОАК и мазок разом', () => {
  test('мазок делают при враче, ОАК — в процедурной', () => {
    const s = newShift(db, { seed: 21, season: 'winter' });
    for (let i = 0; i < 600 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
    const p = s.patients[s.queue[0]];
    apply(db, s, { kind: 'call', id: p.id });
    expect(atDoctor(db, s, p, STREP)).toBe(true);
    expect(atDoctor(db, s, p, CBC)).toBe(false);
  });

  test('сначала ОАК — мазок возьмут, только когда пациент вернётся из процедурной; сначала мазок — сразу', () => {
    const order = (exams: readonly string[]) => {
      const s = newShift(db, { seed: 21, season: 'winter' });
      for (let i = 0; i < 600 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
      const p = s.patients[s.queue[0]];
      apply(db, s, { kind: 'call', id: p.id });
      const t0 = s.t;
      for (const exam of exams) apply(db, s, { kind: 'exam', exam });
      const strep = p.pending.find(x => x.exam === STREP)!;
      return { t0, ready: strep.readyAt, back: p.out?.back };
    };
    const first = order([STREP, CBC]);
    const late = order([CBC, STREP]);
    const strep = db.exams[STREP].time;
    expect(first.ready).toBe(first.t0 + (strep.procedure + (strep.turnaround ?? 0)) * MIN);
    // пациент ушёл сдавать кровь — мазок только после возвращения
    expect(late.ready).toBeGreaterThanOrEqual(late.back! + (strep.procedure + (strep.turnaround ?? 0)) * MIN);
    expect(late.ready).toBeGreaterThan(first.ready);
  });
});

describe('привезённый скорой', () => {
  test('на снимок его везут в рентген-кабинет, а результатов он ждёт на своей койке, не на скамье', () => {
    for (let seed = 1; seed < 40; seed++) {
      const s = newCampaign(db, { seed, season: 'winter', career: 1, chapter: 'chapter.hospital' });
      apply(db, s, { kind: 'nextDay' });
      const ctx = hospitalCtx(db, s);
      const map = layoutOf(ctx.plan, ctx.staff.flatMap(m => (m.room ? [{ room: m.room, role: m.role }] : [])));
      const ev = s.events.find(x => x.event.kind === 'arrive' && s.patients[x.event.id].kind === 'ambulance');
      if (!ev) continue;
      const p = s.patients[(ev.event as { id: string }).id];
      until(s, p.arriveT);
      if (p.status !== 'waiting' || !p.bay) continue;
      apply(db, s, { kind: 'sort', id: p.id, triage: p.scale!.triage });
      apply(db, s, { kind: 'call', id: p.id });
      if (s.current !== p.id) continue;
      apply(db, s, { kind: 'exam', exam: 'exam.xray_chest' });
      apply(db, s, { kind: 'sendAway' });
      const x = p.pending.find(q => q.exam === 'exam.xray_chest');
      if (!x) continue;
      const where = () => placements(db, map, s).find(m => m.id === p.id)!.where;
      until(s, x.start! + 30);
      expect(where()).toEqual({ cell: map.spots.xray });
      until(s, x.end! + 30);
      expect(where()).toEqual({ cell: map.beds[p.bay.room][p.bay.bed] });
      return;
    }
    throw new Error('за 40 зёрен не нашлось');
  });
});
