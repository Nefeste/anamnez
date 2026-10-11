// Кабинет МРТ, МРТ головного мозга и герпетический энцефалит (spec 2026-10-chapter-4, часть 50б): томограф 1,5 Тл,
// рентгенолаборант и рентгенолог; МРТ находит кровь, свежий очаг ишемии и очаг в височной доле — при инсульте она, как КТ,
// закрывает срок 40 минут (814_1, раздел 2.4). Энцефалит — по 492_2: ацикловир в вену сразу, ПЦР ликвора, МРТ; прошедший
// приступ пункцию не запрещает (раздел 2.4), идущие судороги — да.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { layoutOf } from '../../src/engine/hospital/clinic';
import { examWhere } from '../../src/engine/hospital/requirements';
import { salaryOf, type StaffMember } from '../../src/engine/hospital/staff';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { evaluatePlan, recommendedSetting, settingFit, tacticsFor, verdictOf } from '../../src/engine/med/plan';
import { examMinutes, MIN_GAIN, nextStep } from '../../src/engine/med/policy';
import { harmCheck } from '../../src/engine/med/rules';
import type { Observation, Patient } from '../../src/engine/med/types';
import { apply, hospitalCtx, newSandbox } from '../../src/engine/shift/engine';
import type { ShiftState } from '../../src/engine/shift/types';
import { T } from '../../src/i18n';
import { type CaseInput, makeCaseView, whenText } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const HSV = 'cond.hsv_encephalitis';
const MRI = 'exam.mri_head';
const LP = 'exam.lumbar_puncture';
const DEPTS = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology', 'dept.infectious'];
const PLAIN = { coma: 'no', seizures: 'no' };
const FITS = { coma: 'no', seizures: 'yes' };
const COMA = { coma: 'yes', seizures: 'no' };

const patient = (primary: Id, params: Record<string, string> = {}, seed = 5050): Patient =>
  generatePatient(db, seed, { department: 'dept.therapy', departments: DEPTS, season: 'winter', primary, params, carried: db.economy.ambulance.weight });
const has = (p: Patient, f: string) => p.truth.findings.some(x => x.f === f);
const obs = (f: string, shown: boolean, exam = 'exam.neuro_exam'): Observation => ({ f, shown, exam });

/** Доля больных с признаком — по генератору. */
function share(params: Record<string, string>, f: string, primary = HSV, n = 300): number {
  let k = 0;
  for (let i = 0; i < n; i++) if (has(patient(primary, params, 60_000 + i), f)) k++;
  return k / n;
}

/** Песочница с амбулаторией; справа — коридор в две клетки (ниже — туалет), над ним кабинет МРТ: томограф, рентгенолаборант и рентгенолог. */
function withMri(seed = 41, o: { equipment?: readonly string[] } = {}): { s: ShiftState; room: string } {
  const s = newSandbox(db, { seed, season: 'winter', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  // томограф дороже «щедрого» бюджета
  s.economy!.cash = 8_000_000;
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 8; y <= 9; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.mri', size: 'L', x: 29, y: 0, rot: 0 } });
  const room = s.hospital!.rooms.find(r => r.type === 'room.mri')!.id;
  for (const equipment of o.equipment ?? ['eq.mri_15']) apply(db, s, { kind: 'build', cmd: { kind: 'buy', room, equipment } });
  apply(db, s, { kind: 'buildEnd' });
  const hire = (id: string, role: string) => {
    const m: StaffMember = { id, role, sex: 'f', seed: 300 + id.length, skill: 3, salary: salaryOf(db, role, 3), days: 0 };
    s.staff = [...s.staff!, m];
    apply(db, s, { kind: 'assign', id: m.id, room });
  };
  hire('m1', 'role.radiographer');
  hire('m2', 'role.radiologist');
  apply(db, s, { kind: 'nextDay' });
  return { s, room };
}

describe('кабинет МРТ', () => {
  test('кабинет на рентгенолаборанта и рентгенолога, томограф 1,5 Тл; работает кабинет — привозят и больных неврологии', () => {
    expect(db.rooms['room.mri']).toMatchObject({ staff: ['role.radiographer', 'role.radiologist'], needsEquipment: true, admits: ['dept.neurology'] });
    expect(db.equipment['eq.mri_15']).toMatchObject({ rooms: ['room.mri'], sprite: 'mri' });
    expect(db.exams[MRI]).toMatchObject({ room: 'room.mri', equipment: ['eq.mri_15'], radiation: 'none', time: { procedure: 15, report: 15 } });
    expect(db.exams[MRI].checks.map(c => c.f)).toEqual(['img.ct_blood', 'img.ct_hematoma', 'img.ct_hematoma_large', 'img.ct_sah', 'img.mri_ischemia', 'img.temporal_lesion']);
  });

  test('в песочнице: работает с томографом и людьми, без томографа — серым с причиной; на карте — фигурки и стол в тоннеле', () => {
    const { s, room } = withMri();
    const ctx = hospitalCtx(db, s);
    expect(examWhere(db, ctx.plan, ctx.working, ctx.staffed, MRI)).toEqual({ rooms: [room] });
    const bare = withMri(41, { equipment: [] }).s;
    const bareCtx = hospitalCtx(db, bare);
    expect('block' in examWhere(db, bareCtx.plan, bareCtx.working, bareCtx.staffed, MRI)).toBe(true);
    const layout = layoutOf(ctx.plan, ctx.staff.flatMap(m => (m.room ? [{ room: m.room, role: m.role }] : [])));
    const r = ctx.plan.rooms.find(x => x.id === room)!;
    expect(layout.staff).toContainEqual({ role: 'mriTech', cell: r.staff['role.radiographer'] });
    expect(layout.staff).toContainEqual({ role: 'mriDoctor', cell: r.staff['role.radiologist'] });
    expect(layout.spots.mri).toEqual(r.patient!);
    expect(layout.objects).toContainEqual({ kind: 'mri', x: r.patient![0], y: r.patient![1] });
    expect([T.shift.map.doing.exam.mri, T.shift.map.rooms.mri, T.shift.map.staff.mriDoctor]).toEqual(['На МРТ', 'МРТ', 'Рентгенолог кабинета МРТ']);
  });

  test('МРТ — в очереди кабинета: 15 минут и 15 на описание', () => {
    const { s, room } = withMri();
    for (let i = 0; i < 60 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 10 * 60 });
    const p = s.patients[s.queue[0]];
    apply(db, s, { kind: 'call', id: p.id });
    apply(db, s, { kind: 'exam', exam: MRI });
    const x = p.pending.find(e => e.exam === MRI)!;
    expect(x.room).toBe(room);
    expect(x.end! - x.start!).toBe(15 * 60);
    expect(x.readyAt).toBe(x.end! + 15 * 60);
  });
});

describe('МРТ при инсульте и кровоизлияниях', () => {
  test('МРТ подтверждает инсульт, ТИА и кровоизлияния и закрывает срок «КТ или МРТ» в 40 минут', () => {
    for (const c of ['cond.stroke_ischemic', 'cond.tia', 'cond.ich', 'cond.sah']) expect(db.conditions[c].confirm).toContain(MRI);
    expect(db.targets['target.stroke_ct']).toMatchObject({ minutes: 40, exams: ['exam.ct_head', 'exam.cta_head', MRI] });
    expect(db.targets['target.stroke_ct'].name.ru).toBe('КТ или МРТ при подозрении на инсульт');
  });

  test('свежий очаг ишемии — у инсульта, в полушарии напротив слабости; у ТИА его нет', () => {
    expect(share({}, 'img.mri_ischemia', 'cond.stroke_ischemic')).toBeGreaterThan(0.85);
    expect(share({}, 'img.mri_ischemia', 'cond.tia')).toBe(0);
    const p = patient('cond.stroke_ischemic', {}, 61_000);
    const weak = p.truth.findings.find(x => x.f === 'sym.weakness_one_side')?.attrs?.side;
    const focus = p.truth.findings.find(x => x.f === 'img.mri_ischemia')?.attrs?.side;
    if (weak && focus) expect(focus).not.toBe(weak);
  });

  test('карта пациента: МРТ — срез в режиме МРТ; очаг ишемии — светлый клин, кровь — светлое пятно', () => {
    const p = patient('cond.stroke_ischemic', {}, 61_001);
    const input = (o: Observation[]): CaseInput => ({
      version: 1, patient: p, clock: 600, minutesSpent: 0, money: 0, step: 1, pending: [], meanwhile: [], done: [MRI],
      draft: { treatments: [], setting: 'home' },
      arrived: [{ exam: MRI, step: 1, at: 600, obs: o }],
    });
    const image = (o: Observation[]) => makeCaseView(input(o)).groups.find(g => g.exam === MRI)!.image;
    expect(image([obs('img.ct_blood', false, MRI), { f: 'img.mri_ischemia', shown: true, exam: MRI, attrs: { side: 'left' } }]))
      .toMatchObject({ kind: 'head', mode: 'mri', findings: { focus: { density: 'high', shape: 'wedge', side: 'left' } } });
    expect(image([{ f: 'img.ct_blood', shown: true, exam: MRI, attrs: { side: 'right' } }]))
      .toMatchObject({ kind: 'head', mode: 'mri', findings: { focus: { density: 'high', shape: 'blob', side: 'right' } } });
    expect(image([obs('img.ct_blood', false, MRI), obs('img.mri_ischemia', false, MRI)])).toMatchObject({ kind: 'head', mode: 'mri', findings: {} });
  });
});

describe('герпетический энцефалит: болезнь и признаки', () => {
  test('инфекционное отделение без изоляции, привозит скорая, реже всего; ацикловир в вену обязателен и до перевода', () => {
    expect(db.conditions[HSV]).toMatchObject({ department: 'dept.infectious', arrival: 'ambulance', confirm: [LP] });
    expect(db.conditions[HSV].isolation).toBeUndefined();
    const t = db.conditions[HSV].treatment!;
    expect([t.require, t.beforeTransfer, t.notIndicated, t.acceptable]).toEqual([['tx.acyclovir_iv'], ['tx.acyclovir_iv'], ['tx.valaciclovir'], ['tx.antibiotic_iv']]);
    expect(db.treatments['tx.acyclovir_iv']).toMatchObject({ route: 'iv', class: 'antiviral.herpes' });
  });

  test('кома — у 12 %: 5–8 баллов по Глазго, без спутанности; судороги — у каждого с этим параметром; поведение, пузырьки, ПЦР', () => {
    const coma = patient(HSV, COMA);
    expect([has(coma, 'sign.gcs_coma'), has(coma, 'sym.confusion'), has(coma, 'sign.gcs_low')]).toEqual([true, false, false]);
    expect(share(FITS, 'sym.seizure')).toBe(1);
    expect(share(PLAIN, 'sym.seizure')).toBe(0);
    expect(share(PLAIN, 'sym.strange_behavior')).toBeGreaterThan(0.6);
    const lips = share(PLAIN, 'sign.herpes_labialis');
    expect(lips).toBeGreaterThan(0.55);
    expect(lips).toBeLessThan(0.8);
    expect(share(PLAIN, 'lab.csf_hsv')).toBeGreaterThan(0.85);
    expect(share(PLAIN, 'img.temporal_lesion')).toBeGreaterThan(0.65);
    expect(db.exams[LP].checks.find(c => c.f === 'lab.csf_hsv')).toMatchObject({ sens: 9800, spec: 10000 });
  });

  test('место: без комы и судорог — палата, при судорогах — ПИТ, при коме — реанимация, ПИТ не ошибка', () => {
    expect(recommendedSetting(db, patient(HSV, PLAIN), [])).toBe('ward');
    expect(recommendedSetting(db, patient(HSV, FITS), [])).toBe('icu');
    expect(recommendedSetting(db, patient(HSV, COMA, 61_002), [])).toBe('ricu');
    expect(settingFit('icu', 'admit')).toBe('under');
    expect(settingFit('ricu', 'icu', ['icu'])).toBe('ok');
    const tactic = tacticsFor(db.conditions[HSV].treatment!, patient(HSV, PLAIN).truth.conditions[0].params);
    expect(tactic.require).toEqual(['tx.acyclovir_iv']);
  });

  test('без ацикловира — неполное лечение; с ним — действует', () => {
    const p = patient(HSV, PLAIN);
    expect(evaluatePlan(db, p, { treatments: ['tx.paracetamol'], setting: 'admit' }, []).requireMissing).toEqual(['tx.acyclovir_iv']);
    expect(evaluatePlan(db, p, { treatments: ['tx.acyclovir_iv'], setting: 'admit' }, []).effective).toBe(true);
  });

  test('энциклопедия: условия по коме и судорогам — словами; у МРТ — что она находит', () => {
    for (const v of ['yes', 'no']) {
      expect(whenText({ coma: [v] })).toEqual(expect.any(String));
      expect(whenText({ seizures: [v] })).toEqual(expect.any(String));
    }
    expect(article(db, HSV)).toBeDefined();
    expect(article(db, MRI)).toBeDefined();
  });
});

describe('пункция при энцефалите', () => {
  const known = (on: string[], off: string[] = []) => (f: string) => (on.includes(f) ? true : off.includes(f) ? false : undefined);
  const rest = (on: string[]) => db.rules['rule.lp_safe'].any.filter(f => !on.includes(f));

  test('прошедший приступ пункцию не запрещает, идущие судороги, кома и гемипарез — запрещают', () => {
    expect(db.rules['rule.lp_safe'].any).not.toContain('sym.seizure');
    expect(db.rules['rule.lp_safe'].about).toContain(HSV);
    expect(harmCheck(db, LP, known(['sym.seizure'], rest([]))).verdict).toBe('no');
    for (const f of ['sym.seizure_ongoing', 'sign.gcs_coma', 'sign.hemiparesis']) expect(harmCheck(db, LP, known([f], rest([f]))).verdict).toBe('yes');
  });
});

describe('разумный врач при энцефалите', () => {
  const candidates = Object.keys(db.conditions).filter(id => db.conditions[id].presenting && DEPTS.includes(db.conditions[id].department));
  const exams = Object.keys(db.exams).sort();
  const venue = { ward: true, icu: true, ricu: true, box: true, bedside: ['eq.monitor_defib'] };

  function run(p: Patient): { done: string[]; diagnosis: string; plan: { treatments: string[]; setting: string } } {
    const observations: Observation[] = complaintObservations(p);
    const done: string[] = [];
    const rng = Rng.seeded(p.seed).fork('doctor:rational');
    let phase = {};
    let t = 0;
    for (;;) {
      const r = nextStep(db, p, observations, done, phase, { candidates, exams, threshold: 0.9, minGain: MIN_GAIN, venue: { ...venue, minutes: t } });
      phase = r.phase;
      if (r.step.kind === 'decide') return { done, diagnosis: r.step.diagnosis, plan: r.step.plan };
      observations.push(...runExam(db, p, r.step.exam, rng.fork(`exam:${done.length}:${r.step.exam}`)));
      done.push(r.step.exam);
      t += examMinutes(db.exams[r.step.exam]);
    }
  }

  test('ставит энцефалит и назначает ацикловир в вену; при коме пункцию не делает', () => {
    let right = 0, acyclovir = 0;
    const n = 30;
    for (let i = 0; i < n; i++) {
      const p = patient(HSV, i % 3 === 0 ? FITS : PLAIN, 62_000 + i);
      const r = run(p);
      if (verdictOf(db, r.diagnosis, p) === 'correct') right++;
      if (r.plan.treatments.includes('tx.acyclovir_iv')) acyclovir++;
    }
    expect(right / n).toBeGreaterThan(0.85);
    expect(acyclovir / n).toBeGreaterThan(0.85);
    for (let i = 0; i < 10; i++) expect(run(patient(HSV, COMA, 63_000 + i)).done).not.toContain(LP);
  }, 60_000);
});
