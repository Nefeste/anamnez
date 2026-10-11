// Эндоскопический кабинет и кровотечения из верхних отделов ЖКТ (spec 2026-10-chapter-4, часть 53а): видеоэндоскопическая
// стойка, эндоскопист и медсестра; ЭГДС в первые 2 часа от поступления (277_2 и 1026_1, раздел 2.4) находит источник —
// язву или разрыв — и показывает, что в дне язвы, по Форресту. Гемостаз через эндоскоп — при F1–F2b и продолжающемся
// кровотечении из разрыва; при F2c–F3 и остановившемся — не нужен (раздел 3.3). Где кабинета нет — перевод.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { layoutOf } from '../../src/engine/hospital/clinic';
import { examWhere } from '../../src/engine/hospital/requirements';
import { salaryOf, type StaffMember } from '../../src/engine/hospital/staff';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { evaluatePlan, recommendedSetting, settingRoomsOf, txAvailable, txRole, verdictOf, type Venue } from '../../src/engine/med/plan';
import { type DoctorPhase, examMinutes, MIN_GAIN, nextStep } from '../../src/engine/med/policy';
import type { Observation, Patient } from '../../src/engine/med/types';
import { apply, candidatesOf, hospitalCtx, newSandbox } from '../../src/engine/shift/engine';
import type { ShiftState } from '../../src/engine/shift/types';
import { T } from '../../src/i18n';
import { treatmentGroupsFor } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

// разумный врач по сотне больных — дольше 5 секунд
setDefaultTimeout(60_000);

const UB = 'cond.ulcer_bleeding';
const MW = 'cond.mallory_weiss';
const EGD = 'exam.egd';
const HEMO = 'tx.endoscopic_hemostasis';
const ROOM = 'room.endoscopy';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma'];

const patient = (primary: Id, params: Record<string, string> = {}, seed = 5300): Patient =>
  generatePatient(db, seed, { department: 'dept.surgery', departments: ED, season: 'autumn', primary, params });
const people = (primary: Id, n: number, from: number, params: Record<string, string> = {}) => Array.from({ length: n }, (_, i) => patient(primary, params, from + i));
const has = (p: Patient, f: string) => p.truth.findings.some(x => x.f === f);
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;
const near = (x: number, want: number, tol: number) => {
  expect(x).toBeGreaterThan(want - tol);
  expect(x).toBeLessThan(want + tol);
};

/** Песочница с амбулаторией; справа — коридор в две клетки, над ним эндоскопический кабинет: стойка, эндоскопист и медсестра. */
function withEndoscopy(seed = 53, o: { equipment?: readonly string[] } = {}): { s: ShiftState; room: string } {
  const s = newSandbox(db, { seed, season: 'autumn', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  s.economy!.cash = 4_000_000;
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 8; y <= 9; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: ROOM, size: 'M', x: 29, y: 1, rot: 0 } });
  const room = s.hospital!.rooms.find(r => r.type === ROOM)!.id;
  for (const equipment of o.equipment ?? ['eq.videoendoscope']) apply(db, s, { kind: 'build', cmd: { kind: 'buy', room, equipment } });
  apply(db, s, { kind: 'buildEnd' });
  const hire = (id: string, role: string) => {
    const m: StaffMember = { id, role, sex: 'f', seed: 530 + id.length, skill: 3, salary: salaryOf(db, role, 3), days: 0 };
    s.staff = [...s.staff!, m];
    apply(db, s, { kind: 'assign', id: m.id, room });
  };
  hire('e1', 'role.endoscopist');
  hire('e2', 'role.nurse');
  apply(db, s, { kind: 'nextDay' });
  return { s, room };
}

/** Разумный врач по шагам — как нанятый: с местом больницы и тем, что в ней можно сделать. */
function doctor(p: Patient, exams: readonly Id[], venue: Venue) {
  const obs: Observation[] = complaintObservations(p);
  const done: Id[] = [];
  const rng = Rng.seeded(p.seed).fork('doctor');
  const candidates = candidatesOf(db, ED);
  let phase: DoctorPhase = {};
  for (;;) {
    const minutes = done.reduce((a, id) => a + examMinutes(db.exams[id]), 0);
    const r = nextStep(db, p, obs, done, phase, { candidates, exams: [...exams], threshold: 0.9, minGain: MIN_GAIN, venue: { ...venue, minutes } });
    phase = r.phase;
    if (r.step.kind === 'decide') return { ...r.step, done, obs, ev: evaluatePlan(db, p, r.step.plan, obs, venue) };
    obs.push(...runExam(db, p, r.step.exam, rng.fork(`exam:${done.length}:${r.step.exam}`)));
    done.push(r.step.exam);
  }
}
const ALL = Object.keys(db.exams).sort();
const NO_EGD = ALL.filter(id => id !== EGD);
const HOSPITAL: Venue = { ward: true, icu: true, or: true, rooms: [ROOM] };
const PLAIN: Venue = { ward: true, icu: true, or: true };

describe('эндоскопический кабинет', () => {
  test('кабинет на эндоскописта и медсестру, видеоэндоскопическая стойка; ЭГДС эндоскопист проводит и описывает сам', () => {
    expect(db.rooms[ROOM]).toMatchObject({ staff: ['role.endoscopist', 'role.nurse'], needsEquipment: true });
    expect(db.equipment['eq.videoendoscope']).toMatchObject({ rooms: [ROOM] });
    expect(db.roles['role.endoscopist']).toMatchObject({ reads: true });
    expect(db.exams[EGD]).toMatchObject({ kind: 'imaging', room: ROOM, equipment: ['eq.videoendoscope'], radiation: 'none', time: { procedure: 20, report: 5 } });
    // с частью 53б — и гастрит, и быстрый уреазный тест на H. pylori
    expect(db.exams[EGD].checks.map(c => c.f)).toEqual(['img.egd_ulcer', 'img.egd_bleeding', 'img.egd_stigmata', 'img.egd_tear', 'img.egd_gastritis', 'lab.h_pylori']);
    // что в дне язвы — только когда язва видна
    expect(db.exams[EGD].checks.find(c => c.f === 'img.egd_stigmata')!.given).toBe('img.egd_ulcer');
  });

  test('в главах 1–3 его не построить: он в песочнице, в кампании — с главой 4', () => {
    for (const ch of Object.values(db.chapters)) expect(ch.build ?? []).not.toContain(ROOM);
  });

  test('в песочнице: работает со стойкой и людьми, без стойки — серым с причиной; на карте — эндоскопист и медсестра у кушетки', () => {
    const { s, room } = withEndoscopy();
    const ctx = hospitalCtx(db, s);
    expect(examWhere(db, ctx.plan, ctx.working, ctx.staffed, EGD)).toEqual({ rooms: [room] });
    const bare = hospitalCtx(db, withEndoscopy(53, { equipment: [] }).s);
    expect('block' in examWhere(db, bare.plan, bare.working, bare.staffed, EGD)).toBe(true);
    const layout = layoutOf(ctx.plan, ctx.staff.flatMap(m => (m.room ? [{ room: m.room, role: m.role }] : [])));
    const r = ctx.plan.rooms.find(x => x.id === room)!;
    expect(layout.staff).toContainEqual({ role: 'endoscopist', cell: r.staff['role.endoscopist'] });
    expect(layout.staff).toContainEqual({ role: 'endoscopyNurse', cell: r.staff['role.nurse'] });
    expect(layout.spots.endoscopy).toEqual(r.patient!);
    expect([T.shift.map.doing.exam.endoscopy, T.shift.map.rooms.endoscopy, T.shift.map.staff.endoscopist]).toEqual(['На ЭГДС', 'Эндоскопия', 'Врач-эндоскопист']);
    // закрытый случай помнит из работающих кабинетов только тот, от которого зависит место
    expect(settingRoomsOf(db, [...ctx.rooms])).toEqual([ROOM]);
  });

  test('ЭГДС — в очереди кабинета: 20 минут и 5 на описание', () => {
    const { s, room } = withEndoscopy();
    for (let i = 0; i < 60 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 10 * 60 });
    const p = s.patients[s.queue[0]];
    apply(db, s, { kind: 'call', id: p.id });
    apply(db, s, { kind: 'exam', exam: EGD });
    const x = p.pending.find(e => e.exam === EGD)!;
    expect(x.room).toBe(room);
    expect(x.end! - x.start!).toBe(20 * 60);
    expect(x.readyAt).toBe(x.end! + 5 * 60);
  });

  test('срок: при рвоте кровью и чёрном стуле ЭГДС — в первые 2 часа; пульс и давление — каждому', () => {
    expect(db.targets['target.egd_bleeding']).toMatchObject({ complaints: ['sym.hematemesis', 'sym.melena'], exams: [EGD], minutes: 120 });
    expect(db.exams['exam.vitals'].routineFor).toEqual(expect.arrayContaining(['sym.hematemesis', 'sym.melena']));
  });
});

describe('язвенное кровотечение', () => {
  const ps = people(UB, 600, 53_000);

  test('Форрест и шок: доли; по классу — что видно на ЭГДС; при шоке давление ниже 90 у каждого', () => {
    const params = (p: Patient) => p.truth.conditions[0].params;
    near(share(ps, p => params(p).forrest === 'active'), 0.15, 0.04);
    near(share(ps, p => params(p).forrest === 'stigmata'), 0.3, 0.05);
    near(share(ps, p => params(p).forrest === 'low'), 0.55, 0.05);
    near(share(ps, p => params(p).shock === 'yes'), 0.2, 0.04);
    for (const p of ps) {
      expect(has(p, 'img.egd_ulcer')).toBe(true);
      expect(has(p, 'img.egd_bleeding')).toBe(params(p).forrest === 'active');
      expect(has(p, 'img.egd_stigmata')).toBe(params(p).forrest === 'stigmata');
      if (params(p).shock === 'yes') expect(has(p, 'vital.bp_low')).toBe(true);
    }
  });

  test('тактика: гемостаз при F1–F2b обязателен, при F2c–F3 не нужен; при шоке растворы обязательны; ИПН в вену — первая линия', () => {
    expect(txRole(db, UB, HEMO, { forrest: 'active', shock: 'no' })).toBe('require');
    expect(txRole(db, UB, HEMO, { forrest: 'stigmata', shock: 'no' })).toBe('require');
    expect(txRole(db, UB, HEMO, { forrest: 'low', shock: 'no' })).toBe('notIndicated');
    expect(txRole(db, UB, 'tx.iv_fluids', { forrest: 'low', shock: 'yes' })).toBe('require');
    expect(txRole(db, UB, 'tx.ppi_iv', { forrest: 'low', shock: 'no' })).toBe('firstLine');
    for (const tx of ['tx.ibuprofen', 'tx.aspirin_acs', 'tx.clopidogrel', 'tx.doac']) expect(txRole(db, UB, tx, { forrest: 'low', shock: 'no' })).toBe('harmful');
  });

  test('место: с работающим эндоскопическим кабинетом — палата, при шоке — ПИТ; без него — перевод', () => {
    const at = (params: Record<string, string>, rooms: Id[]) => recommendedSetting(db, patient(UB, params), [], [], rooms);
    expect(at({ forrest: 'active', shock: 'no' }, [ROOM])).toBe('ward');
    expect(at({ forrest: 'low', shock: 'yes' }, [ROOM])).toBe('icu');
    expect(at({ forrest: 'active', shock: 'no' }, [])).toBe('transfer');
    expect(at({ forrest: 'low', shock: 'yes' }, ['room.ultrasound'])).toBe('transfer');
  });

  test('гемостаз — в эндоскопическом кабинете: без него кнопка серая, «Нет работающего эндоскопического кабинета — переводят»', () => {
    expect(db.treatments[HEMO]).toMatchObject({ kind: 'procedure', room: ROOM });
    expect(txAvailable(db, HEMO, {})).toBe(false);
    expect(txAvailable(db, HEMO, { rooms: [ROOM] })).toBe(true);
    const item = (rooms: Id[]) => treatmentGroupsFor([], [], rooms).flatMap(g => g.items).find(x => x.id === HEMO)!;
    expect(item([])).toMatchObject({ disabled: true, warning: 'Нет работающего эндоскопического кабинета — переводят' });
    expect(item([ROOM]).disabled).toBeUndefined();
  });

  test('гемостаз излечивает F1–F2b, ИПН в вену — F2c–F3', () => {
    const cure = (tx: Id) => db.treatments[tx].effects.filter(e => e.on === UB && e.kind === 'cure').map(e => e.when);
    expect(cure(HEMO)).toEqual([{ forrest: ['active', 'stigmata'] }]);
    expect(cure('tx.ppi_iv')).toEqual([{ forrest: ['low'] }]);
  });
});

describe('синдром Мэллори–Вейсса', () => {
  const ps = people(MW, 400, 54_000);

  test('хирургия, одна группа с язвенным кровотечением; редкая, чаще у мужчин и пьющих; по 1026_1', () => {
    expect(db.conditions[MW]).toMatchObject({ icd10: 'K22.6', department: 'dept.surgery', group: 'grp.ugi_bleeding', confirm: 'clinical', redFlags: ['sym.hematemesis'] });
    expect(db.conditions[UB].group).toBe('grp.ugi_bleeding');
    expect(db.conditions[MW].risks).toEqual([{ id: 'risk.alcohol', x: 8 }]);
    expect(db.conditions[MW].sources.map(s => s.url)).toEqual(['https://cr.minzdrav.gov.ru/view-cr/1026_1', 'https://cr.minzdrav.gov.ru/view-cr/277_2']);
  });

  test('«сначала рвало без крови» — обычно у разрыва и не у язвы; разрыв на ЭГДС у каждого; продолжается — у пятого', () => {
    near(share(ps, p => has(p, 'hx.vomiting_before_blood')), 0.75, 0.07);
    expect(share(people(UB, 200, 55_000), p => has(p, 'hx.vomiting_before_blood'))).toBeLessThan(0.05);
    expect(ps.every(p => has(p, 'img.egd_tear'))).toBe(true);
    near(share(ps, p => p.truth.conditions[0].params.active === 'yes'), 0.2, 0.05);
    for (const p of ps) expect(has(p, 'img.egd_bleeding')).toBe(p.truth.conditions[0].params.active === 'yes');
  });

  test('разрыв вместо язвы и язва вместо разрыва — «до группы»: источник различает ЭГДС', () => {
    expect(verdictOf(db, UB, ps[0])).toBe('partly');
    expect(verdictOf(db, MW, patient(UB))).toBe('partly');
  });

  test('тактика: гемостаз — при продолжающемся, при остановившемся не нужен; место — как у язвы', () => {
    expect(txRole(db, MW, HEMO, { active: 'yes' })).toBe('require');
    expect(txRole(db, MW, HEMO, { active: 'no' })).toBe('notIndicated');
    expect(recommendedSetting(db, patient(MW, { active: 'yes' }), [], [], [ROOM])).toBe('ward');
    expect(recommendedSetting(db, patient(MW, { active: 'yes' }))).toBe('transfer');
  });
});

describe('разумный врач', () => {
  test('с эндоскопией язвенное кровотечение: ЭГДС, гемостаз по Форресту, при шоке — ПИТ', () => {
    const run = (params: Record<string, string>, from: number) => people(UB, 30, from, params).map(p => doctor(p, ALL, HOSPITAL));
    const active = run({ forrest: 'active', shock: 'no' }, 56_000);
    const stigmata = run({ forrest: 'stigmata', shock: 'no' }, 56_100);
    const low = run({ forrest: 'low', shock: 'no' }, 56_200);
    const shock = run({ forrest: 'low', shock: 'yes' }, 56_300);
    const all = [...active, ...stigmata, ...low, ...shock];
    expect(share(all, r => r.diagnosis === UB)).toBeGreaterThan(0.95);
    expect(share(all, r => r.done.includes(EGD))).toBeGreaterThan(0.95);
    expect(share([...active, ...stigmata], r => r.plan.treatments.includes(HEMO))).toBeGreaterThan(0.85);
    expect(share([...low, ...shock], r => !r.plan.treatments.includes(HEMO))).toBeGreaterThan(0.85);
    expect(share([...active, ...stigmata, ...low], r => r.plan.setting === 'admit')).toBeGreaterThan(0.9);
    expect(share(shock, r => r.plan.setting === 'icu' && r.plan.treatments.includes('tx.iv_fluids'))).toBeGreaterThan(0.8);
  });

  test('с эндоскопией разрыв: ЭГДС, гемостаз при продолжающемся кровотечении, палата', () => {
    const yes = people(MW, 30, 57_000, { active: 'yes' }).map(p => doctor(p, ALL, HOSPITAL));
    const no = people(MW, 30, 57_100, { active: 'no' }).map(p => doctor(p, ALL, HOSPITAL));
    expect(share([...yes, ...no], r => r.diagnosis === MW)).toBeGreaterThan(0.9);
    expect(share(yes, r => r.plan.treatments.includes(HEMO))).toBeGreaterThan(0.85);
    expect(share(no, r => !r.plan.treatments.includes(HEMO))).toBeGreaterThan(0.9);
    expect(share([...yes, ...no], r => r.plan.setting === 'admit')).toBeGreaterThan(0.9);
  });

  test('без эндоскопии — перевод, без гемостаза', () => {
    const rs = [...people(UB, 30, 58_000), ...people(MW, 30, 58_100)].map(p => doctor(p, NO_EGD, PLAIN));
    expect(share(rs, r => r.plan.setting === 'ambulance')).toBeGreaterThan(0.9);
    expect(rs.some(r => r.plan.treatments.includes(HEMO))).toBe(false);
  });
});

describe('энциклопедия', () => {
  test('где лечить: палата, при шоке — ПИТ, без шока ПИТ — не ошибка; без работающего эндоскопического кабинета — перевод', () => {
    expect(article(db, UB)!.blocks.find(b => b.key === 'where')!.text).toEqual([
      'Обычно — в стационаре.',
      'При шоке — верхнем давлении ниже 90 — палата интенсивной терапии.',
      'Без работающего эндоскопического кабинета — скорая, перевод в центр.',
      'Своей палаты интенсивной терапии нет — скорая, больница.',
      'Без шока — можно и палата интенсивной терапии.',
    ]);
    expect(article(db, MW)!.blocks.find(b => b.key === 'where')!.text).toEqual(['Обычно — в стационаре.', 'Без работающего эндоскопического кабинета — скорая, перевод в центр.']);
  });

  test('лечение по Форресту и по тому, идёт ли кровь, — словами', () => {
    const rows = (id: Id) => Object.fromEntries(article(db, id)!.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(x => x.id)]));
    expect(rows(UB)).toMatchObject({
      'Первая линия': ['tx.ppi_iv'],
      'Обязательно, при кровотечении, сосуде или сгустке в дне язвы (Форрест F1–F2b)': [HEMO],
      'Не нужно, при плоских пятнах или чистом дне язвы (Форрест F2c–F3)': [HEMO],
      'Обязательно, при шоке — верхнем давлении ниже 90': ['tx.iv_fluids'],
    });
    expect(rows(MW)).toMatchObject({ 'Обязательно, при продолжающемся кровотечении': [HEMO], 'Не нужно, когда кровотечение остановилось': [HEMO] });
    for (const id of [EGD, HEMO, 'tx.ppi_iv', 'img.egd_stigmata', 'hx.vomiting_before_blood']) expect(article(db, id)).toBeDefined();
  });
});
