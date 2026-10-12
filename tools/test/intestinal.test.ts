// Кишечные инфекции инфекционного отделения (spec 2026-10-chapter-4, часть 49б): сальмонеллёз (700_3), шигеллёз (869_1) и
// энтероколит, вызванный C. difficile (878_1). Приходят туда, где работает бокс (`admits: dept.infectious`); лёгкое течение
// лечат дома, среднетяжёлое и тяжёлое — в боксе, молниеносный энтероколит — в ПИТ. Антибиотик при лёгком сальмонеллёзе не
// нужен, при шигеллёзе — каждому; при C. difficile — ванкомицин внутрь и отмена антибиотика, на котором начался понос;
// лоперамид при шигеллёзе и C. difficile вреден.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, examFits, runExam } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { alsoSettings, evaluatePlan, recommendedSetting, settingFit, tacticsFor, txRole, verdictOf } from '../../src/engine/med/plan';
import { examMinutes, MIN_GAIN, nextStep } from '../../src/engine/med/policy';
import type { Observation, Patient } from '../../src/engine/med/types';
import { apply, candidatesOf, departmentsOf, newSandbox } from '../../src/engine/shift/engine';
import { txGroupOfClass } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const SALM = 'cond.salmonellosis';
const SHIG = 'cond.shigellosis';
const CDI = 'cond.cdiff';
const GE = 'cond.gastroenteritis';
const ORS = 'tx.ors';
const FQ = 'tx.fluoroquinolone';
const ABX_IV = 'tx.antibiotic_iv';
const IV = 'tx.balanced_fluids';
const VANCO = 'tx.vancomycin_oral';
const METRO = 'tx.metronidazole';
const STOP = 'tx.stop_antibiotic';
const LOPER = 'tx.loperamide';
const TEST = 'exam.cdiff_stool';
const DEPTS = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology', 'dept.infectious'];
const SEASONS = ['winter', 'spring', 'summer', 'autumn'] as const;

const patient = (id: Id, params: Record<string, string>, seed = 4949): Patient =>
  generatePatient(db, seed, { department: 'dept.therapy', departments: DEPTS, season: 'summer', primary: id, params });
const has = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f);

/** Доля пациентов с признаком при этих значениях параметров — по генератору. */
function share(id: Id, params: Record<string, string>, f: Id, n = 400): number {
  let k = 0;
  for (let i = 0; i < n; i++) if (has(patient(id, params, 91_000 + i), f)) k++;
  return k / n;
}

/** Разумный врач в больнице с боксами: обследования до уверенности 0,9, потом решение. */
function doctor(p: Patient) {
  const candidates = candidatesOf(db, DEPTS);
  const exams = Object.keys(db.exams).sort();
  const obs: Observation[] = complaintObservations(p);
  const done: Id[] = [];
  const rng = Rng.seeded(p.seed).fork('doctor:rational');
  let phase = {};
  let minutes = 0;
  for (let k = 0; k < 60; k++) {
    const r = nextStep(db, p, obs, done, phase, { candidates, exams, threshold: 0.9, minGain: MIN_GAIN, venue: { ward: true, icu: true, or: true, box: true, minutes } });
    phase = r.phase;
    if (r.step.kind === 'decide') {
      const fit = settingFit(recommendedSetting(db, p, done), r.step.plan.setting, alsoSettings(db, p, done));
      return { diagnosis: r.step.diagnosis, plan: r.step.plan, done, fit, verdict: verdictOf(db, r.step.diagnosis, p) };
    }
    obs.push(...runExam(db, p, r.step.exam, rng.fork(`exam:${done.length}:${r.step.exam}`)));
    done.push(r.step.exam);
    minutes += examMinutes(db.exams[r.step.exam]);
  }
  throw new Error('врач не решил');
}
const runs = (id: Id, params: Record<string, string>, n: number) =>
  Array.from({ length: n }, (_, i) => doctor(generatePatient(db, 6_400_000 + i, { department: 'dept.therapy', departments: DEPTS, season: SEASONS[i % 4], primary: id, params })));
const ratio = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;

describe('каталог', () => {
  test('три болезни инфекционного отделения: заразны, кишечные инфекции одной группы с гастроэнтеритом', () => {
    for (const id of [SALM, SHIG, CDI]) {
      expect(db.conditions[id]).toMatchObject({ department: 'dept.infectious', group: 'grp.intestinal_infection', system: 'digestive', isolation: 'contact', presenting: true });
    }
    expect([SALM, SHIG, CDI].map(id => db.conditions[id].icd10)).toEqual(['A02.0', 'A03.9', 'A04.7']);
    expect(db.conditions[GE].group).toBe('grp.intestinal_infection');
    expect(db.conditions[SALM].params).toEqual({ severity: { mild: 40, moderate: 45, severe: 15 } });
    expect(db.conditions[SHIG].params).toEqual({ severity: { mild: 45, moderate: 45, severe: 10 } });
    expect(db.conditions[CDI].params).toEqual({ severity: { mild: 70, severe: 24, critical: 6 }, abx: { taking: 40, stopped: 45, none: 15 } });
    expect(db.conditions[CDI].confirm).toEqual([TEST]);
  });

  test('гастроэнтерит у больного сальмонеллёзом, шигеллёзом или C. difficile — диагноз частично верный', () => {
    for (const id of [SALM, SHIG, CDI]) expect(verdictOf(db, GE, patient(id, {}))).toBe('partly');
    expect(verdictOf(db, SHIG, patient(SALM, {}))).toBe('partly');
    expect(verdictOf(db, 'cond.appendicitis', patient(SALM, {}))).toBe('wrong');
  });

  test('бокс принимает инфекционное отделение: работает бокс — больница принимает и его болезни', () => {
    expect(db.rooms['room.box'].admits).toEqual(['dept.infectious']);
    const s = newSandbox(db, { seed: 49, season: 'summer', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
    expect(departmentsOf(db, s)).not.toContain('dept.infectious');
    const cells: [number, number][] = [];
    for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
    apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
    apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.box', size: 'S', x: 29, y: 0, rot: 0 } });
    const box = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
    apply(db, s, { kind: 'buildEnd' });
    apply(db, s, { kind: 'assign', id: s.staff!.find(m => m.role === 'role.nurse' && m.room === 'r7')!.id, room: box });
    expect(departmentsOf(db, s)).toContain('dept.infectious');
  });

  test('редкие: среди пришедших сами в больницу с боксом — каждый 300-й с сальмонеллёзом, реже шигеллёз и C. difficile', () => {
    const n: Record<string, number> = {};
    const N = 6000;
    for (let s = 1; s <= N; s++) {
      const id = generatePatient(db, 9_100_000 + s, { department: 'dept.therapy', departments: DEPTS, season: SEASONS[s % 4], walkIn: true }).truth.conditions[0].id;
      n[id] = (n[id] ?? 0) + 1;
    }
    const at = (id: Id) => (n[id] ?? 0) / N;
    expect(at(GE)).toBeGreaterThan(0.03);
    expect(at(SALM)).toBeGreaterThan(0.001);
    expect(at(SALM)).toBeLessThan(0.008);
    expect(at(SHIG) + at(CDI)).toBeLessThan(0.008);
  }, 30_000);
});

describe('признаки', () => {
  test('сальмонеллёз: обильный зелёный стул без крови и ложных позывов; температура с средней тяжести; тяжёлый — давление и обезвоживание', () => {
    expect(share(SALM, { severity: 'moderate' }, 'sym.green_stool')).toBeGreaterThan(0.6);
    expect(share(SALM, { severity: 'moderate' }, 'sym.mucus_blood_stool')).toBeLessThan(0.15);
    expect(share(SALM, { severity: 'mild' }, 'vital.fever')).toBeLessThan(0.15);
    expect(share(SALM, { severity: 'moderate' }, 'vital.fever')).toBeGreaterThan(0.9);
    expect(share(SALM, { severity: 'severe' }, 'vital.bp_low')).toBeGreaterThan(0.6);
    expect(share(SALM, { severity: 'severe' }, 'sign.dry_mucosa')).toBeGreaterThan(0.9);
  });

  test('шигеллёз: скудный стул со слизью и кровью, ложные позывы, боль и болезненность слева внизу', () => {
    expect(share(SHIG, { severity: 'moderate' }, 'sym.mucus_blood_stool')).toBeGreaterThan(0.65);
    expect(share(SHIG, { severity: 'severe' }, 'sym.mucus_blood_stool')).toBeGreaterThan(0.9);
    expect(share(SHIG, { severity: 'moderate' }, 'sym.tenesmus')).toBeGreaterThan(0.65);
    expect(share(SHIG, { severity: 'moderate' }, 'sign.llq_tenderness')).toBeGreaterThan(0.65);
    expect(share(SHIG, { severity: 'moderate' }, 'sym.vomiting')).toBeLessThan(0.15);
    expect(share(SHIG, { severity: 'moderate' }, 'sym.green_stool')).toBeLessThan(0.15);
  });

  test('C. difficile: антибиотик в анамнезе — по параметру; тест положителен у больного; молниеносный — давление ниже 90', () => {
    for (const abx of ['taking', 'stopped']) expect(share(CDI, { abx }, 'hx.antibiotics_recent')).toBe(1);
    expect(share(CDI, { abx: 'taking' }, 'hx.antibiotic_now')).toBe(1);
    expect(share(CDI, { abx: 'stopped' }, 'hx.antibiotic_now')).toBeLessThan(0.08);
    expect(share(CDI, { abx: 'none' }, 'hx.antibiotics_recent')).toBeLessThan(0.2);
    expect(share(CDI, {}, 'lab.cdiff_gdh')).toBeGreaterThan(0.9);
    expect(share(CDI, {}, 'lab.cdiff_toxin')).toBeGreaterThan(0.65);
    expect(share(CDI, { severity: 'critical' }, 'vital.bp_low')).toBeGreaterThan(0.9);
    expect(share(CDI, { severity: 'severe' }, 'lab.wbc_high')).toBeGreaterThan(0.9);
  });

  test('о стуле спрашивают при расспросе о животе, об антибиотиках — каждого с поносом; тест на C. difficile — только при поносе', () => {
    expect(db.exams['exam.ask_abdomen'].checks.map(c => c.f)).toEqual(expect.arrayContaining(['sym.green_stool', 'sym.mucus_blood_stool', 'sym.tenesmus']));
    expect(db.exams['exam.ask_meds'].checks.map(c => c.f)).toEqual(expect.arrayContaining(['hx.antibiotics_recent', 'hx.antibiotic_now']));
    // с частью 55а — и при стуле с кровью: атака язвенного колита, антибиотики и НПВП (193_2, раздел 2.1)
    expect(db.exams['exam.ask_meds'].routineFor).toEqual(['sym.nosebleed', 'sym.diarrhea', 'sym.bloody_diarrhea']);
    // с частью 55а — и при стуле с кровью: «пациентам с обострением ЯК» (193_2, раздел 2.3)
    expect(db.exams[TEST]).toMatchObject({ kind: 'lab', room: 'room.lab', equipment: ['eq.immuno_analyzer'], complaints: ['sym.diarrhea', 'sym.bloody_diarrhea'] });
    expect(db.exams[TEST].checks.map(c => c.f)).toEqual(['lab.cdiff_gdh', 'lab.cdiff_toxin']);
    const flu = generatePatient(db, 7, { department: 'dept.therapy', season: 'winter', primary: 'cond.influenza' });
    expect([examFits(db.exams[TEST], patient(CDI, { severity: 'mild' })), examFits(db.exams[TEST], flu)]).toEqual([true, false]);
  });
});

describe('лечение', () => {
  test('сальмонеллёз: лёгкий — без антибиотика; средний — антибиотик и капельница не ошибка; тяжёлый — растворы в вену и антибиотик обязательны', () => {
    const t = db.conditions[SALM].treatment!;
    expect(tacticsFor(t, { severity: 'mild' })).toMatchObject({ firstLine: [ORS], notIndicated: expect.arrayContaining([FQ, ABX_IV, LOPER]) });
    expect(tacticsFor(t, { severity: 'moderate' })).toMatchObject({ firstLine: [ORS], acceptable: expect.arrayContaining([FQ, ABX_IV, IV]) });
    expect(tacticsFor(t, { severity: 'severe' })).toMatchObject({ firstLine: [], acceptable: [ORS], require: [[IV, 'tx.iv_fluids'], [ABX_IV, FQ]] });
    // посев кала — до антибиотика (критерий качества 9)
    expect(t.supportive).toContain('tx.stool_culture');
  });

  test('шигеллёз: антибиотик каждому — без него лечения причины нет; ципрофлоксацин — выбор; лоперамид вреден', () => {
    const t = db.conditions[SHIG].treatment!;
    expect(t).toMatchObject({ firstLine: [FQ], acceptable: [ABX_IV], harmful: [LOPER] });
    expect(t.notIndicated).toEqual(expect.arrayContaining(['tx.amoxicillin', 'tx.nitrofurantoin', 'tx.cephalosporin_oral']));
    const mild = patient(SHIG, { severity: 'mild' });
    expect(evaluatePlan(db, mild, { treatments: [ORS], setting: 'home' }, []).effective).toBe(false);
    expect(evaluatePlan(db, mild, { treatments: [FQ, ORS], setting: 'home' }, []).effective).toBe(true);
    expect(txRole(db, SHIG, LOPER, { severity: 'mild' })).toBe('harmful');
    // с частью 55а — и при тяжёлой атаке язвенного колита (193_2, раздел 3.2.2); с частью 55б — польза при СРК с диареей (892_1)
    expect(db.treatments[LOPER].effects.map(e => [e.on, e.kind])).toEqual([[SHIG, 'harm'], [CDI, 'harm'], ['cond.uc_attack', 'harm'], ['cond.ibs', 'cure']]);
  });

  test('C. difficile: ванкомицин внутрь; метронидазол — при лёгком; молниеносный — оба и растворы; идёт антибиотик — отменить', () => {
    const t = db.conditions[CDI].treatment!;
    expect(t).toMatchObject({ firstLine: [VANCO], harmful: [LOPER] });
    expect(t.notIndicated).toEqual(expect.arrayContaining([FQ, ABX_IV]));
    expect(tacticsFor(t, { severity: 'mild', abx: 'stopped' })).toMatchObject({ firstLine: [VANCO], acceptable: [METRO], notIndicated: expect.arrayContaining([STOP]) });
    expect(tacticsFor(t, { severity: 'critical', abx: 'stopped' })).toMatchObject({ firstLine: [], require: [VANCO, METRO, [IV, 'tx.iv_fluids']] });
    expect(tacticsFor(t, { severity: 'mild', abx: 'taking' }).require).toEqual([STOP]);
    const taking = patient(CDI, { severity: 'mild', abx: 'taking' });
    const plain = evaluatePlan(db, taking, { treatments: [VANCO], setting: 'home' }, []);
    expect([plain.effective, plain.requireMissing]).toEqual([true, [STOP]]);
    // новый антибиотик широкого спектра болезнь не лечит
    expect(evaluatePlan(db, patient(CDI, { severity: 'mild', abx: 'stopped' }), { treatments: [FQ], setting: 'home' }, []).effective).toBe(false);
    expect(txGroupOfClass(db.treatments[LOPER].class)).toBe('digestive');
    expect(txGroupOfClass(db.treatments[VANCO].class)).toBe('antibiotics');
  });
});

describe('где лечить', () => {
  test('лёгкое — дома (бокс не ошибка), среднетяжёлое и тяжёлое — бокс; молниеносный C. difficile — ПИТ', () => {
    const at = (id: Id, severity: string, abx?: string) => recommendedSetting(db, patient(id, { severity, ...(abx ? { abx } : {}) }));
    expect(['mild', 'moderate', 'severe'].map(v => at(SALM, v))).toEqual(['home', 'box', 'box']);
    expect(['mild', 'moderate', 'severe'].map(v => at(SHIG, v))).toEqual(['home', 'box', 'box']);
    expect(['mild', 'severe', 'critical'].map(v => at(CDI, v, 'stopped'))).toEqual(['home', 'box', 'icu']);
    expect(alsoSettings(db, patient(SALM, { severity: 'mild' }))).toEqual(['box']);
    expect(alsoSettings(db, patient(SHIG, { severity: 'severe' }))).toEqual(['icu']);
    expect(db.conditions[CDI].treatment!.setting.redFlag).toBe('icu');
  });
});

describe('разумный врач в больнице с боксами', () => {
  test('шигеллёз средней тяжести: верный диагноз, ципрофлоксацин и бокс почти у каждого', () => {
    const xs = runs(SHIG, { severity: 'moderate' }, 40);
    expect(ratio(xs, x => x.verdict === 'correct')).toBeGreaterThan(0.85);
    expect(ratio(xs, x => x.plan.treatments.includes(FQ))).toBeGreaterThan(0.85);
    expect(ratio(xs, x => x.plan.setting === 'box')).toBeGreaterThan(0.8);
    expect(ratio(xs, x => x.plan.treatments.includes(LOPER))).toBe(0);
  }, 120_000);

  test('тяжёлый сальмонеллёз: бокс, растворы в вену и антибиотик', () => {
    const xs = runs(SALM, { severity: 'severe' }, 40);
    expect(ratio(xs, x => x.verdict !== 'wrong')).toBe(1);
    expect(ratio(xs, x => x.fit === 'ok')).toBeGreaterThan(0.9);
    expect(ratio(xs, x => x.plan.treatments.includes(IV) || x.plan.treatments.includes('tx.iv_fluids'))).toBeGreaterThan(0.85);
    expect(ratio(xs, x => x.plan.treatments.includes(ABX_IV) || x.plan.treatments.includes(FQ))).toBeGreaterThan(0.8);
  }, 120_000);

  test('C. difficile: спрашивает о лекарствах, проверяет кал; ванкомицин, а при идущем антибиотике — и отмену', () => {
    const xs = runs(CDI, { severity: 'mild' }, 40);
    expect(ratio(xs, x => x.done.includes('exam.ask_meds'))).toBe(1);
    expect(ratio(xs, x => x.done.includes(TEST))).toBeGreaterThan(0.5);
    expect(ratio(xs, x => x.verdict === 'correct')).toBeGreaterThan(0.65);
    const right = xs.filter(x => x.verdict === 'correct');
    expect(ratio(right, x => x.plan.treatments.includes(VANCO))).toBe(1);
    expect(ratio(right, x => x.plan.treatments.includes(LOPER))).toBe(0);
    const critical = runs(CDI, { severity: 'critical' }, 30);
    expect(ratio(critical, x => x.plan.setting === 'icu')).toBeGreaterThan(0.8);
    expect(ratio(critical.filter(x => x.verdict === 'correct'), x => x.plan.treatments.includes(METRO))).toBeGreaterThan(0.85);
  }, 180_000);
});

describe('энциклопедия', () => {
  test('у энтероколита — путь передачи, бокс, антибиотик в параметрах; у теста — двухступенчатость', () => {
    const where = article(db, CDI)!.blocks.find(b => b.key === 'where')!.text!;
    expect(where).toContain('Заразна: передаётся через руки, посуду и предметы.');
    expect(article(db, TEST)).toBeDefined();
    expect(article(db, LOPER)).toBeDefined();
    expect(article(db, SHIG)!.title).toBe('Шигеллёз (дизентерия)');
  });
});
