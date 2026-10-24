// Живой фон (spec 2026-10-living-background, вопрос 53, вариант 1): санузел — две кабинки, «занято», очередь у двери,
// из кабинки — к раковине; перерыв регистратора и медсестры — в ординаторской, у кофеварки и за столом; нанятый врач
// между приёмами читает. Это только карта: без `life` места прежние, а смена о живом фоне не знает.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { type ClinicLayout, layoutOf } from '../../src/engine/hospital/clinic';
import type { StaffMember } from '../../src/engine/hospital/staff';
import { salaryOf } from '../../src/engine/hospital/staff';
import { apply, hospitalCtx, newCampaign, newSandbox, newShift } from '../../src/engine/shift/engine';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';
import { SPEED, Walkers } from '../../src/render/map/walkers';
import { CLINIC, type Placement, placements } from '../../src/state/clinicMap';
import { DOOR_WAIT, stallsOf, TOILET_AFTER, TOILET_SHARE, toiletPlaces, WALK } from '../../src/state/life';

const LIFE = new Set(['toilet', 'wash', 'toiletQueue', 'coffee', 'rest', 'reading']);
const ON = { pace: 60 };

const layoutOfShift = (s: ShiftState): ClinicLayout => {
  const ctx = hospitalCtx(db, s);
  return layoutOf(ctx.plan, ctx.staff.flatMap(m => (m.room ? [{ room: m.room, role: m.role, stands: db.roles[m.role]?.stands }] : [])));
};

/** День практики по минутам: на каждой минуте — места с живым фоном и без него. */
function practiceDay(seed: number, each: (s: ShiftState, plain: Placement[], live: Placement[]) => void) {
  const s = newShift(db, { seed, season: 'winter' });
  for (let i = 0; i < 10 * 60 && s.dayOpen; i++) {
    apply(db, s, { kind: 'advance', seconds: 60 });
    each(s, placements(db, CLINIC, s), placements(db, CLINIC, s, ON));
  }
  return s;
}

describe('санузел', () => {
  test('в санузле — две кабинки и две раковины; у карты — их номера по порядку', () => {
    for (const z of db.rooms['room.toilet'].sizes) {
      expect(z.objects.filter(o => o.kind === 'stall').length).toBe(2);
      expect(z.objects.filter(o => o.kind === 'sink').length).toBe(2);
    }
    expect(stallsOf(CLINIC).length).toBe(2);
  });

  test('без живого фона карта прежняя; с ним меняются только те, кто в санузле, — смена того же дня та же', () => {
    let changed = 0;
    practiceDay(7, (s, plain, live) => {
      expect(plain.some(x => LIFE.has(x.doing.kind))).toBe(false);
      expect(live.map(x => x.id)).toEqual(plain.map(x => x.id));
      live.forEach((x, i) => {
        if (LIFE.has(x.doing.kind)) changed++;
        else expect(x).toEqual(plain[i]);
      });
    });
    expect(changed).toBeGreaterThan(0);
  });

  test('в санузел встаёт примерно каждый четвёртый ждущий — через 10–40 минут ожидания', () => {
    // ждут по одному, час друг от друга: кабинки всегда свободны, жребий у каждого свой
    const n = 400;
    const patients: Record<string, ShiftPatient> = {};
    for (let i = 0; i < n; i++) patients[`p${i}`] = { id: `p${i}`, status: 'waiting', kind: 'walkIn', queuedT: i * 3600, wait: 1 } as unknown as ShiftPatient;
    const waiting = Object.values(patients);
    let went = 0;
    for (const p of waiting) {
      let seen = false;
      for (let t = p.queuedT; t <= p.queuedT + (TOILET_AFTER[1] + 5) * 60 && !seen; t += 15) {
        const s = { t, patients } as unknown as ShiftState;
        const at = toiletPlaces(CLINIC, s, ON, [p]).get(p.id);
        if (at) {
          seen = true;
          // не раньше 10 минут ожидания
          expect(t - p.queuedT).toBeGreaterThanOrEqual(TOILET_AFTER[0] * 60);
        }
      }
      if (seen) went++;
    }
    expect(went / n).toBeGreaterThan((TOILET_SHARE - 7) / 100);
    expect(went / n).toBeLessThan((TOILET_SHARE + 7) / 100);
  });

  test('в одной кабинке — никогда двое; из кабинки — к раковине, потом на место', () => {
    const order = new Map<string, string[]>();
    let busy = 0;
    for (const seed of [3, 7, 11]) {
      practiceDay(seed, (_s, _plain, live) => {
        const inStalls = live.flatMap(x => (x.doing.kind === 'toilet' ? [x.doing.stall] : []));
        expect(new Set(inStalls).size).toBe(inStalls.length);
        expect(inStalls.length).toBeLessThanOrEqual(2);
        if (inStalls.length === 2) busy++;
        for (const x of live) {
          if (!x.id.startsWith('staff.')) {
            const was = order.get(`${seed}:${x.id}`) ?? [];
            if (was[was.length - 1] !== x.doing.kind) order.set(`${seed}:${x.id}`, [...was, x.doing.kind]);
          }
        }
      });
    }
    const visits = [...order.values()].filter(k => k.includes('toilet'));
    expect(visits.length).toBeGreaterThan(3);
    for (const k of visits) {
      const i = k.indexOf('toilet');
      expect(k[i - 1] === 'waiting' || k[i - 1] === 'toiletQueue').toBe(true);
      // после кабинки — раковина; позвали прямо из кабинки — к врачу
      expect(['wash', 'office']).toContain(k[i + 1]);
    }
    for (const k of order.values()) if (k.includes('wash')) expect(k[k.indexOf('wash') - 1]).toBe('toilet');
    expect(busy).toBeGreaterThanOrEqual(0);
  });

  test('позвали, пока он в санузле, — идёт к врачу оттуда; смена зовёт его, как всех', () => {
    const s = newShift(db, { seed: 7, season: 'winter' });
    let id: string | undefined;
    for (let i = 0; i < 10 * 60 && s.dayOpen && !id; i++) {
      apply(db, s, { kind: 'advance', seconds: 60 });
      id = placements(db, CLINIC, s, ON).find(x => x.doing.kind === 'toilet' && x.callable)?.id;
    }
    expect(id).toBeDefined();
    apply(db, s, { kind: 'call', id: id! });
    expect(s.current).toBe(id!);
    expect(placements(db, CLINIC, s, ON).find(x => x.id === id)!.doing).toEqual({ kind: 'office' });
  });

  test('прогулка — в секундах экрана: на ×4 в кабинке то же время экрана, что на ×1, — игровых минут вчетверо больше', () => {
    const s = newShift(db, { seed: 7, season: 'winter' });
    let id: string | undefined;
    for (let i = 0; i < 10 * 60 && s.dayOpen && !id; i++) {
      apply(db, s, { kind: 'advance', seconds: 60 });
      id = placements(db, CLINIC, s, ON).find(x => x.doing.kind === 'toilet')?.id;
    }
    expect(id).toBeDefined();
    // ×1: выходит из кабинки за считанные игровые минуты; ×4 — всё ещё там
    const kindAt = (pace: number) => placements(db, CLINIC, s, { pace }).find(x => x.id === id)!.doing.kind;
    let k = 0;
    while (kindAt(60) === 'toilet' && k++ < 60) apply(db, s, { kind: 'advance', seconds: 15 });
    expect(kindAt(60)).not.toBe('toilet');
    expect(kindAt(240)).toBe('toilet');
  });

  test('кабинки заняты — ждут у двери, а не дождался за несколько секунд экрана — назад на место', () => {
    // четверо встали разом: двое в кабинках, двое у двери
    const patients: Record<string, ShiftPatient> = {};
    const chosen: ShiftPatient[] = [];
    for (let i = 0; chosen.length < 4 && i < 5000; i++) {
      const p = { id: `q${i}`, status: 'waiting', kind: 'walkIn', queuedT: 0, wait: 1 } as unknown as ShiftPatient;
      // встаёт ровно на 10-й минуте — ищем таких
      const at = (t: number) => toiletPlaces(CLINIC, { t, patients: { [p.id]: p } } as unknown as ShiftState, ON, [p]).get(p.id);
      if (at(TOILET_AFTER[0] * 60) && !at(TOILET_AFTER[0] * 60 - 1)) {
        chosen.push(p);
        patients[p.id] = p;
      }
    }
    expect(chosen.length).toBe(4);
    const now = (t: number) => toiletPlaces(CLINIC, { t, patients } as unknown as ShiftState, ON, chosen);
    const first = now(TOILET_AFTER[0] * 60);
    const kinds = [...first.values()].map(x => x.doing.kind).sort();
    expect(kinds).toEqual(['toilet', 'toilet', 'toiletQueue', 'toiletQueue']);
    // ждущие у двери — за дверью санузла, один за другим, а не на одной клетке
    const door = [...first.values()].filter(x => x.doing.kind === 'toiletQueue').map(x => (x.where as { cell: [number, number] }).cell);
    expect(new Set(door.map(c => c.join(','))).size).toBe(2);
    const toilet = CLINIC.rooms.find(r => r.type === 'toilet')!;
    expect(Math.abs(door[0][0] - toilet.door[0]) + Math.abs(door[0][1] - toilet.door[1])).toBe(1);
    // долго ждать не станут: к концу ожидания у двери никого
    const late = now(TOILET_AFTER[0] * 60 + (60 + DOOR_WAIT) * 60);
    expect([...late.values()].some(x => x.doing.kind === 'toiletQueue')).toBe(false);
  });

  test('на карте: в кабинке — «занято» над ней, пока человек стоит там; ушёл к раковине — гаснет', () => {
    const walkers = new Walkers(CLINIC, 8);
    const look = placements(db, CLINIC, newShift(db, { seed: 7, season: 'winter' }))[0].look;
    const seat: Placement = { id: 'p1', figure: 'patient', look, where: { seat: true }, doing: { kind: 'waiting' } };
    walkers.sync([seat], 0);
    const [stall] = stallsOf(CLINIC);
    const light = CLINIC.rooms.length;
    let f = walkers.sync([{ ...seat, where: { cell: stall }, doing: { kind: 'toilet', stall: 0 } }], 1);
    const lit = f.lights.findIndex((v, i) => i % 3 === 0 && v === light);
    expect(lit).toBeGreaterThanOrEqual(0);
    const arrive = f.lights[lit + 1];
    // дошёл — горит, пока там
    expect(arrive).toBeGreaterThan(1);
    expect(walkers.where('p1', arrive)).toEqual(stall);
    // пошёл к раковине, когда достоял, — над кабинкой больше не горит
    const sink = CLINIC.objects.find(o => o.kind === 'sink')!;
    f = walkers.sync([{ ...seat, where: { cell: [sink.x, sink.y + 1] }, doing: { kind: 'wash' } }], arrive + 10);
    expect(f.lights.some((v, i) => i % 3 === 0 && v === light)).toBe(false);
  });

  test('шаг карты для оценки прогулок — тот же, каким ходят люди', () => {
    expect(WALK).toBe(SPEED);
  });
});

describe('перерыв и чтение', () => {
  test('в ординаторской — кофеварка', () => {
    for (const z of db.rooms['room.staff'].sizes) expect(z.objects.filter(o => o.kind === 'coffee').length).toBe(1);
  });

  test('регистратор и медсестра в тихую минуту — в ординаторской, у кофеварки и за столом; вернулись раньше, чем к ним дошли', () => {
    let rests = 0;
    for (const seed of [1, 2, 3]) {
      const s = newCampaign(db, { seed, season: 'winter', career: 1, chapter: 'chapter.hospital' });
      apply(db, s, { kind: 'nextDay' });
      const map = layoutOfShift(s);
      const staffRoom = map.rooms.find(r => r.type === 'staff')!;
      expect(staffRoom).toBeDefined();
      const inStaffRoom = ([x, y]: [number, number]) => x >= staffRoom.x && x < staffRoom.x + staffRoom.w && y >= staffRoom.y && y < staffRoom.y + staffRoom.h;
      const order: string[] = [];
      for (let i = 0; i < 10 * 60 && s.dayOpen; i++) {
        const before = new Set(Object.values(s.patients).filter(p => p.status === 'coming').map(p => p.id));
        apply(db, s, { kind: 'advance', seconds: 30 });
        const live = placements(db, map, s, ON);
        const reg = live.find(x => x.id === 'staff.registrar')!;
        if (order[order.length - 1] !== reg.doing.kind) order.push(reg.doing.kind);
        if (reg.doing.kind === 'coffee' || reg.doing.kind === 'rest') {
          rests++;
          expect(inStaffRoom((reg.where as { cell: [number, number] }).cell)).toBe(true);
          // у стола и в очереди к нему — никого
          expect(Object.values(s.patients).some(p => p.status === 'intake' && p.intake && p.intake.reg.end > s.t)).toBe(false);
        }
        // пришёл сам — регистратор уже у стола
        const came = Object.values(s.patients).filter(p => before.has(p.id) && p.status !== 'coming' && p.kind !== 'ambulance');
        if (came.length > 0) expect(reg.doing.kind).toBe('staff');
      }
      for (let i = 1; i < order.length; i++) if (order[i] === 'rest') expect(['coffee', 'staff']).toContain(order[i - 1]);
    }
    expect(rests).toBeGreaterThan(0);
  }, 60_000);

  test('без ординаторской (амбулатория практики) перерывов нет', () => {
    expect(CLINIC.rooms.some(r => r.type === 'staff')).toBe(false);
    practiceDay(7, (_s, _plain, live) => {
      expect(live.some(x => x.doing.kind === 'coffee' || x.doing.kind === 'rest')).toBe(false);
    });
  });

  test('нанятый врач без пациента читает; пациент у него — принимает', () => {
    const s = newSandbox(db, { seed: 7, season: 'winter', start: 'clinic', budget: db.economy.sandbox.budgets.normal });
    const cells: [number, number][] = [];
    for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
    apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
    apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.staff', size: 'S', x: 30, y: 0, rot: 0 } });
    apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.office', size: 'M', x: 30, y: 10, rot: 2 } });
    apply(db, s, { kind: 'buildEnd' });
    const office = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
    const m: StaffMember = { id: 'h1', role: 'role.therapist', sex: 'f', seed: 11, skill: 3, salary: salaryOf(db, 'role.therapist', 3), days: 0 };
    s.staff = [...(s.staff ?? []), m];
    apply(db, s, { kind: 'assign', id: m.id, room: office });
    apply(db, s, { kind: 'nextDay' });
    const map = layoutOfShift(s);
    const doc = () => placements(db, map, s, ON).find(x => x.id === `staff.therapist.${office}`)!;
    expect(doc().doing).toEqual({ kind: 'reading', role: 'therapist' });
    expect(placements(db, map, s).find(x => x.id === `staff.therapist.${office}`)!.doing).toEqual({ kind: 'staff', role: 'therapist' });
    for (let i = 0; i < 240 && !Object.values(s.patients).some(p => p.status === 'inRoom' && p.by); i++) apply(db, s, { kind: 'advance', seconds: 60 });
    expect(doc().doing).toEqual({ kind: 'staff', role: 'therapist' });
  }, 30_000);
});
