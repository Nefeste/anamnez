// Кабинет КТ и КТ головного мозга (spec 2026-10-chapter-3, часть 40): кабинет, томограф на 16 и на 64
// среза, рентгенолаборант и рентгенолог; правило КТ при лёгкой черепно-мозговой травме ведёт в свой
// кабинет, а где его нет — на перевод; после КТ без крови сотрясение лечат дома, а оглушённого
// кладут в стационар (734_2, приложение Б); разумный врач, страховая, кабинет в песочнице, карта,
// срез в карте пациента и энциклопедия.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { layoutOf } from '../../src/engine/hospital/clinic';
import { examWhere } from '../../src/engine/hospital/requirements';
import { salaryOf, type StaffMember } from '../../src/engine/hospital/staff';
import { runExam } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { alsoSettings, evaluatePlan, recommendedSetting, settingFit } from '../../src/engine/med/plan';
import { choosePlan, indicated, runDoctor } from '../../src/engine/med/policy';
import { checkRule, knownOf } from '../../src/engine/med/rules';
import type { Observation, Patient } from '../../src/engine/med/types';
import { apply, candidatesOf, hospitalCtx, newSandbox } from '../../src/engine/shift/engine';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';
import { T } from '../../src/i18n';
import { type CaseInput, makeCaseView } from '../../src/state/caseView';
import { placements } from '../../src/state/clinicMap';
import { article } from '../../src/state/encyclopedia';
import { roomSigns } from '../../src/state/roomSigns';
import { examBlockText } from '../../src/state/sandboxView';

const CT = 'exam.ct_head';
const BLOOD = 'img.ct_blood';
const CONC = 'cond.concussion';
const BRUISE = 'cond.head_bruise';
const LOC = 'sym.loss_of_consciousness';
const VOMIT = 'sym.vomiting';
const SEIZURE = 'sym.seizure_after_injury';
const GCS = 'sign.gcs_low';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma'];
const rule = db.rules['rule.ct_head'];

const people = (primary: Id, n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => generatePatient(db, from + i, { department: 'dept.therapy', departments: ED, season: 'autumn', primary }));
const has = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f);
const ct = (p: Patient) => p.truth.conditions[0].params.ct;
const obs = (f: Id, shown: boolean, exam: Id = 'exam.ask_head_injury'): Observation => ({ f, shown, exam });
/** КТ без крови: так её видит врач */
const scan: Observation = { f: BLOOD, shown: false, exam: CT };
const candidates = candidatesOf(db, ED);
const exams = Object.keys(db.exams).sort();
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;

describe('каталог: кабинет КТ, томографы, обследование', () => {
  test('кабинет КТ: рентгенолаборант и рентгенолог, без томографа не работает; один размер, пациент — на столе томографа', () => {
    const r = db.rooms['room.ct'];
    // КТ-ангиография — с частью 41а, груди — с частью 43а
    expect(r).toMatchObject({ staff: ['role.radiographer', 'role.radiologist'], needsEquipment: true, equipment: ['eq.ct_16', 'eq.ct_64'], exams: [CT, 'exam.cta_chest', 'exam.cta_head'] });
    expect(r.sizes.map(z => [z.id, z.w, z.h])).toEqual([['M', 9, 7]]);
    expect(r.sizes[0].patient).toEqual(r.sizes[0].slots[0]);
    // рентгенолог описывает срезы — точность от его навыка, как у снимков
    expect(db.roles['role.radiologist'].rooms).toEqual(['room.ct', 'room.xray']);
    expect(db.roles['role.radiographer'].rooms).toEqual(['room.ct', 'room.xray']);
  });

  test('томограф на 64 среза — улучшение томографа на 16: быстрее и точнее, дороже в покупке и в обслуживании; дороже всех аппаратов больницы', () => {
    const [a, b] = [db.equipment['eq.ct_16'], db.equipment['eq.ct_64']];
    expect(a).toMatchObject({ rooms: ['room.ct'], sprite: 'ct', speed: 1.3, quality: { sens: -3, spec: -1 }, exams: [CT, 'exam.cta_chest', 'exam.cta_head'] });
    expect(b).toMatchObject({ rooms: ['room.ct'], sprite: 'ct', upgradeOf: 'eq.ct_16', speed: 1, quality: { sens: 0, spec: 0 }, exams: [CT, 'exam.cta_chest', 'exam.cta_head'] });
    expect(b.price).toBeGreaterThan(a.price);
    expect(b.upkeep).toBeGreaterThan(a.upkeep);
    const others = Object.values(db.equipment).filter(e => e.sprite !== 'ct');
    expect(Math.min(a.price, b.price)).toBeGreaterThan(Math.max(...others.map(e => e.price)));
  });

  test('КТ головного мозга: в кабинете КТ, облучение среднее, 10 минут и 15 на описание; ищет кровь внутри черепа, ложной не показывает; правило КТ ведёт на неё', () => {
    expect(db.exams[CT]).toMatchObject({ kind: 'imaging', room: 'room.ct', equipment: ['eq.ct_16', 'eq.ct_64'], radiation: 'medium', time: { procedure: 10, report: 15 }, cost: 3000 });
    // с частью 41в — где кровь и сколько её: уточнения, только когда кровь видна
    expect(db.exams[CT].checks).toEqual([
      { f: BLOOD, sens: 9900, spec: 10000 },
      { f: 'img.ct_hematoma', sens: 9900, spec: 9800, given: BLOOD },
      { f: 'img.ct_hematoma_large', sens: 9800, spec: 10000 },
      { f: 'img.ct_sah', sens: 9800, spec: 9900, given: BLOOD },
    ]);
    // при сотрясении изменений на КТ нет (734_2, раздел 1.1): кровь — только у кровоизлияний в мозг, а у
    // сотрясения и ушиба её не бывает по записи
    expect(Object.values(db.conditions).filter(c => c.findings.some(l => l.f === BLOOD)).map(c => c.id).sort()).toEqual(['cond.ich', 'cond.sah']);
    expect(db.conditions[CONC].masks).toEqual([BLOOD]);
    expect(rule.exams).toEqual([CT]);
    expect(rule.texts.exam).toBeUndefined();
    // КТ у сотрясения — всегда без крови, и уточнять нечего
    for (const p of people(CONC, 40, 300)) expect(runExam(db, p, CT, Rng.seeded(p.seed).fork('ct'))).toEqual([{ f: BLOOD, shown: false, exam: CT }]);
  });
});

describe('где лечить сотрясение после КТ', () => {
  const ps = people(CONC, 800, 1);
  const yes = ps.find(p => ct(p) === 'yes' && !has(p, GCS) && !has(p, SEIZURE))!;
  const flag = ps.find(p => has(p, GCS))!;
  const seizure = ps.find(p => has(p, SEIZURE) && !has(p, GCS))!;
  const no = ps.find(p => ct(p) === 'no')!;
  const after = [CT];

  test('до КТ — как было: показана — перевод или своя палата, оглушение и судороги — только перевод', () => {
    expect([recommendedSetting(db, yes), alsoSettings(db, yes)]).toEqual(['transfer', ['ward']]);
    expect([recommendedSetting(db, flag), alsoSettings(db, flag)]).toEqual(['transfer', []]);
    expect([recommendedSetting(db, seizure), alsoSettings(db, seizure)]).toEqual(['transfer', []]);
    expect(recommendedSetting(db, no)).toBe('home');
  });

  test('КТ без крови: домой с инструкциями, своя палата — не ошибка, перевод — больше нужного', () => {
    expect([recommendedSetting(db, yes, after), alsoSettings(db, yes, after)]).toEqual(['home', ['ward']]);
    expect(settingFit('home', 'home', ['ward'])).toBe('ok');
    expect(settingFit('home', 'admit', ['ward'])).toBe('ok');
    expect(settingFit('home', 'transfer', ['ward'])).toBe('over');
    expect(recommendedSetting(db, no, after)).toBe('home');
  });

  test('оглушение и после КТ — госпитализация: своя палата или перевод, домой — меньше нужного (734_2, приложение Б)', () => {
    expect([recommendedSetting(db, flag, after), alsoSettings(db, flag, after)]).toEqual(['ambulance', []]);
    for (const chosen of ['admit', 'transfer', 'ambulance'] as const) expect(settingFit('ambulance', chosen)).toBe('ok');
    expect(settingFit('ambulance', 'home')).toBe('under');
  });

  test('судороги сразу после травмы — показание к КТ, но не к госпитализации: после КТ — дома, палата — не ошибка', () => {
    expect([recommendedSetting(db, seizure, after), alsoSettings(db, seizure, after)]).toEqual(['home', ['ward']]);
  });

  test('проверка плана — по пришедшим результатам: КТ в наблюдениях — дома', () => {
    const plan = { treatments: ['tx.screen_rest', 'tx.paracetamol'], setting: 'home' as const };
    expect(evaluatePlan(db, yes, plan, [obs(VOMIT, true)]).setting).toEqual({ chosen: 'home', recommended: 'transfer', also: ['ward'] });
    expect(evaluatePlan(db, yes, plan, [obs(VOMIT, true), scan]).setting).toEqual({ chosen: 'home', recommended: 'home', also: ['ward'] });
  });
});

describe('план и разумный врач', () => {
  test('план: показана КТ — скорая, после КТ — дома; оглушение после КТ — скорая, со своей палатой — в неё', () => {
    const vomit = [obs(VOMIT, true)];
    expect(choosePlan(db, CONC, vomit, 30).setting).toBe('ambulance');
    expect(choosePlan(db, CONC, [...vomit, scan], 30).setting).toBe('home');
    const dazed = [obs(GCS, true, 'exam.neuro_exam'), scan];
    expect(choosePlan(db, CONC, dazed, 30).setting).toBe('ambulance');
    expect(choosePlan(db, CONC, dazed, 30, { ward: true }).setting).toBe('admit');
    // судороги — не довод после КТ
    expect(choosePlan(db, CONC, [obs(SEIZURE, true), scan], 30).setting).toBe('home');
  });

  const conc = people(CONC, 300, 20_001);
  const doctor = (p: Patient, list = exams) => runDoctor(db, p, 'rational', Rng.seeded(p.seed).fork('doctor'), { candidates, exams: list, threshold: 0.9 });
  const runs = conc.map(p => ({ p, r: doctor(p) }));
  const verdict = (x: (typeof runs)[number]) => checkRule(rule, x.p.age, knownOf(x.r.observations)).verdict;

  test('с кабинетом КТ: правило сказало «нужна» — КТ, без показаний — нет; после КТ — дома, оглушённого — скорая; перевода нет', () => {
    const right = runs.filter(x => x.r.correct);
    expect(share(runs, x => x.r.correct)).toBeGreaterThan(0.9);
    const needed = right.filter(x => verdict(x) === 'yes');
    expect(needed.length).toBeGreaterThan(100);
    expect(needed.every(x => x.r.exams.includes(CT))).toBe(true);
    expect(right.filter(x => verdict(x) === 'no').some(x => x.r.exams.includes(CT))).toBe(false);
    const dazed = (x: (typeof runs)[number]) => x.r.observations.some(o => o.f === GCS && o.shown);
    expect(needed.every(x => x.r.plan.setting === (dazed(x) ? 'ambulance' : 'home'))).toBe(true);
    expect(needed.some(dazed)).toBe(true);
  });

  test('без кабинета КТ — как было: при показаниях скорая, перевод', () => {
    const noCt = exams.filter(id => id !== CT);
    const x = conc.map(p => ({ p, r: doctor(p, noCt) })).filter(y => y.r.correct && checkRule(rule, y.p.age, knownOf(y.r.observations)).verdict === 'yes');
    expect(x.length).toBeGreaterThan(100);
    expect(x.every(y => y.r.plan.setting === 'ambulance' && !y.r.exams.includes(CT))).toBe(true);
  });

  test('страховая: КТ при показаниях по правилу — показана; без показаний и при ушибе — нет', () => {
    const p = conc[0];
    expect(indicated(db, p, [obs(VOMIT, true)], candidates, CT)).toBe(true);
    const clear = [obs(LOC, true), ...rule.any.map(f => obs(f, false))];
    expect(indicated(db, { ...p, age: 30 }, clear, candidates, CT)).toBe(false);
    const bruise = people(BRUISE, 1, 7)[0];
    expect(indicated(db, bruise, [], candidates, CT)).toBe(false);
  });
});

/**
 * Песочница с готовой амбулаторией; справа — коридор, над ним кабинет КТ с томографами `equipment`,
 * рентгенолаборантом и рентгенологом (без `radiologist: false`).
 */
function withCt(seed = 41, o: { equipment?: readonly string[]; radiologist?: boolean } = {}) {
  const s = newSandbox(db, { seed, season: 'winter', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  // томограф дороже «щедрого» бюджета
  s.economy!.cash = 6_000_000;
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.ct', size: 'M', x: 29, y: 0, rot: 0 } });
  const room = s.hospital!.rooms.find(r => r.type === 'room.ct')!.id;
  for (const equipment of o.equipment ?? ['eq.ct_16']) apply(db, s, { kind: 'build', cmd: { kind: 'buy', room, equipment } });
  apply(db, s, { kind: 'buildEnd' });
  const hire = (id: string, role: string) => {
    const m: StaffMember = { id, role, sex: 'f', seed: 300 + id.length, skill: 3, salary: salaryOf(db, role, 3), days: 0 };
    s.staff = [...s.staff!, m];
    apply(db, s, { kind: 'assign', id: m.id, room });
  };
  hire('c1', 'role.radiographer');
  if (o.radiologist !== false) hire('c2', 'role.radiologist');
  apply(db, s, { kind: 'nextDay' });
  return { s, room };
}

const where = (s: ShiftState) => {
  const ctx = hospitalCtx(db, s);
  return examWhere(db, ctx.plan, ctx.working, ctx.staffed, CT);
};

/** Первый в очереди вызван в кабинет, ему назначена КТ. */
function scanned(s: ShiftState): ShiftPatient {
  for (let i = 0; i < 60 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 10 * 60 });
  const p = s.patients[s.queue[0]];
  apply(db, s, { kind: 'call', id: p.id });
  apply(db, s, { kind: 'exam', exam: CT });
  return p;
}

describe('кабинет КТ своей больницы', () => {
  test('работает с томографом, рентгенолаборантом и рентгенологом; без томографа и без рентгенолога — серым с причиной', () => {
    const { s, room } = withCt();
    expect(where(s)).toEqual({ rooms: [room] });
    const bare = where(withCt(41, { equipment: [] }).s);
    expect('block' in bare && examBlockText(db, bare.block)).toBe(T.sandbox.examBlock.down('Кабинет КТ', T.sandbox.problem.noEquipment));
    const nobody = where(withCt(41, { radiologist: false }).s);
    expect('block' in nobody && examBlockText(db, nobody.block)).toBe(T.sandbox.examBlock.down('Кабинет КТ', T.sandbox.problem.noStaff('рентгенолога')));
  });

  test('КТ — в очереди кабинета: на 16 срезов — 13 минут, на 64 — 10, описание — 15 минут после; второй — после первого', () => {
    const slow = scanned(withCt().s).pending.find(x => x.exam === CT)!;
    expect(slow.end! - slow.start!).toBe(Math.round(10 * 60 * 1.3));
    expect(slow.readyAt).toBe(slow.end! + 15 * 60);
    const { s, room } = withCt(41, { equipment: ['eq.ct_64'] });
    const first = scanned(s);
    const a = first.pending.find(x => x.exam === CT)!;
    expect(a.room).toBe(room);
    expect(a.end! - a.start!).toBe(10 * 60);
    apply(db, s, { kind: 'sendAway' });
    const b = scanned(s).pending.find(x => x.exam === CT)!;
    expect(b.start!).toBeGreaterThanOrEqual(a.end!);
  });

  test('карта: рентгенолаборант и рентгенолог КТ на местах; пациент — на столе томографа, следующий — на скамье; у кабинета — очередь', () => {
    const { s, room } = withCt();
    const ctx = hospitalCtx(db, s);
    const layout = layoutOf(ctx.plan, ctx.staff.flatMap(m => (m.room ? [{ room: m.room, role: m.role }] : [])));
    const r = ctx.plan.rooms.find(x => x.id === room)!;
    expect(layout.staff).toContainEqual({ role: 'ctTech', cell: r.staff['role.radiographer'] });
    expect(layout.staff).toContainEqual({ role: 'ctDoctor', cell: r.staff['role.radiologist'] });
    // у рентгена — свои, прежние фигурки
    expect(layout.staff.some(x => x.role === 'radiographer' && !x.id)).toBe(true);
    expect(layout.spots.ct).toEqual(r.patient!);
    expect(layout.objects).toContainEqual({ kind: 'ct', x: r.patient![0], y: r.patient![1] });
    // двоих в очереди — по КТ одному за другим: второй ждёт, пока первый на столе
    for (let i = 0; i < 60 && s.queue.length < 2; i++) apply(db, s, { kind: 'advance', seconds: 5 * 60 });
    const first = scanned(s);
    apply(db, s, { kind: 'sendAway' });
    const second = scanned(s);
    apply(db, s, { kind: 'sendAway' });
    const a = first.pending.find(x => x.exam === CT)!;
    expect(second.pending.find(x => x.exam === CT)!.start!).toBeGreaterThanOrEqual(a.end!);
    apply(db, s, { kind: 'advance', seconds: Math.max(0, a.start! - s.t + 60) });
    const map = placements(db, layout, s);
    expect(map.find(x => x.id === first.id)).toMatchObject({ where: { cell: r.patient }, doing: { kind: 'exam', room: 'ct' } });
    expect(map.find(x => x.id === second.id)).toMatchObject({ where: { bench: true }, doing: { kind: 'examQueue', room: 'ct' } });
    expect(roomSigns(layout, s).find(x => x.id === room)!.queue).toBe(1);
    expect([T.shift.map.doing.exam.ct, T.shift.map.doing.examQueue.ct, T.shift.map.rooms.ct]).toEqual(['На КТ', 'Ждёт очереди на КТ', 'КТ']);
    expect(T.shift.map.staff.ctDoctor).toBe('Рентгенолог кабинета КТ');
  });

  test('кандидаты в песочнице — и для кабинета КТ: рентгенолаборанты и рентгенологи', () => {
    const { s } = withCt();
    expect(s.candidates!.some(c => c.role === 'role.radiologist')).toBe(true);
  });
});

describe('карта пациента и энциклопедия', () => {
  const p = people(CONC, 1, 5)[0];
  const input = (shown: boolean): CaseInput => ({
    version: 1, patient: p, clock: 600, minutesSpent: 0, money: 0, step: 1, pending: [], meanwhile: [], done: [CT],
    draft: { treatments: [], setting: 'home' },
    arrived: [{ exam: CT, step: 1, at: 600, obs: [{ f: BLOOD, shown, exam: CT, ...(shown ? { attrs: { side: 'left' } } : {}) }] }],
  });
  const group = (shown: boolean) => makeCaseView(input(shown)).groups.find(g => g.exam === CT)!;

  test('результат КТ — срезом головы: без крови — обычный срез и «Крови внутри черепа нет»; кровь — светлое пятно на её стороне', () => {
    expect(group(false).image).toMatchObject({ kind: 'head', findings: {} });
    expect(group(false).lines.map(l => l.text)).toEqual(['Крови внутри черепа нет']);
    expect(group(true).image).toMatchObject({ kind: 'head', findings: { focus: { density: 'high', shape: 'blob', side: 'left' } } });
    expect(group(true).image!.seed).toBe(group(false).image!.seed);
  });

  test('статьи: кабинет КТ — томографы и обследование; томограф на 16 срезов — улучшение на 64; КТ — где делают', () => {
    expect(JSON.stringify(article(db, 'room.ct'))).toContain('eq.ct_64');
    expect(JSON.stringify(article(db, 'eq.ct_16'))).toContain('eq.ct_64');
    expect(JSON.stringify(article(db, CT))).toContain('room.ct');
  });
});
