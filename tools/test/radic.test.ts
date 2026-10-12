// Дискогенная радикулопатия и синдром конского хвоста (spec 2026-10-chapter-4, часть 58б; 777_1): грыжа диска прижимает корешок L5
// или S1 — боль простреливает в ногу ниже колена, немеет голень, бывает слабая стопа; лечат как неспецифическую боль в спине:
// активность и НПВП, снимки в первые 4 недели не нужны. Большая грыжа перекрывает канал — задержка мочи, онемение промежности,
// слабость обеих ног: экстренная МРТ и нейрохирург, в игре — перевод. МРТ позвоночника в карте — срезом.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id, Setting } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient, typicalPatient } from '../../src/engine/med/generate';
import { alsoSettings, curesOf, evaluatePlan, type Plan, recommendedSetting, selfLimits, txRole, untreatedOf, type Venue, verdictOf } from '../../src/engine/med/plan';
import { type DoctorPhase, examMinutes, MIN_GAIN, nextStep } from '../../src/engine/med/policy';
import { scoreCase } from '../../src/engine/med/score';
import type { Observation, Patient } from '../../src/engine/med/types';
import type { SpineFindings } from '../../src/render/mri/spineGeometry';
import { candidatesOf } from '../../src/engine/shift/engine';
import { type CaseInput, makeCaseView, txGroupOfClass } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

// разумный врач по сотне больных — дольше 5 секунд
setDefaultTimeout(120_000);

const RAD = 'cond.radiculopathy';
const CES = 'cond.cauda_equina';
const LBP = 'cond.low_back_pain';
const MRI = 'exam.mri_spine';
const ACTIVE = 'tx.stay_active';
const NSAID = 'tx.ibuprofen';
const VITB = 'tx.b_vitamins';
const GABA = 'tx.gabapentinoid';
const RELAX = 'tx.muscle_relaxant';
const STEROID = 'tx.steroid_systemic_short';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.infectious'];
const VENUE: Venue = { ward: true, icu: true, ricu: true, rooms: ['room.mri'] };

const patients = (cond: Id, n: number, from: number, params: Record<string, string> = {}) =>
  Array.from({ length: n }, (_, i) => typicalPatient(db, k => (from + i) * 31 + k, { department: 'dept.therapy', departments: ED, season: 'autumn', primary: cond, params }));
const has = (p: Patient, f: string) => p.truth.findings.some(x => x.f === f && x.cause === p.truth.conditions.find(c => c.role === 'primary')!.id);
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;
const param = (p: Patient, k: string) => p.truth.conditions.find(c => c.role === 'primary')!.params[k];
const plan = (treatments: Id[], setting: Setting = 'home'): Plan => ({ treatments: [...treatments].sort(), setting });
/** Жалобы, расспрос о спине и неврологический осмотр. */
const checked = (p: Patient, exams: Id[] = ['exam.ask_back', 'exam.neuro_exam', 'exam.spine_exam']): Observation[] => {
  const rng = Rng.seeded(p.seed).fork('checked');
  return [...complaintObservations(p), ...exams.flatMap(e => runExam(db, p, e, rng.fork(e)))];
};

describe('радикулопатия', () => {
  const ps = patients(RAD, 300, 58_300);

  test('запись по 777_1: терапия, M51.1, одна группа с неспецифической болью в спине; диагноз клинический; корешок L5 или S1', () => {
    expect(db.conditions[RAD]).toMatchObject({
      icd10: 'M51.1', department: 'dept.therapy', group: 'grp.back_pain', system: 'nerves', kind: 'disease', severity: 'moderate', confirm: 'clinical',
      params: { root: { l5: 50, s1: 50 }, paresis: { yes: 30, no: 70 } },
    });
    expect(db.conditions[RAD].arrival).toBeUndefined();
    expect(db.conditions[RAD].differential).toEqual([LBP, CES]);
    expect(db.conditions[LBP]).toMatchObject({ group: 'grp.back_pain', differential: [RAD] });
    // у врача общей практики — 2–11 % болей в спине (раздел 1.3); 45–64 года, чаще мужчины
    expect(db.conditions[RAD].weight).toBeLessThan(db.conditions[LBP].weight / 5);
    expect(db.conditions[RAD].weight).toBeGreaterThan(db.conditions[LBP].weight / 20);
    // перепутать с неспецифической болью в спине — диагноз частично верный: лечат одинаково
    expect(verdictOf(db, LBP, ps[0])).toBe('partly');
    expect(verdictOf(db, CES, ps[0])).toBe('wrong');
  });

  test('боль в спине у каждого, обычно — ниже колена; не стоит на пятке — L5 с парезом, на носке — S1 с парезом; ахиллов рефлекс — у S1', () => {
    for (const p of ps) {
      const root = param(p, 'root'), paresis = param(p, 'paresis') === 'yes';
      expect(has(p, 'sym.back_pain')).toBe(true);
      expect(has(p, 'sign.heel_walk_weak')).toBe(root === 'l5' && paresis);
      expect(has(p, 'sign.toe_walk_weak')).toBe(root === 's1' && paresis);
      if (root === 'l5') expect(has(p, 'sign.ankle_reflex_low')).toBe(false);
      for (const f of ['sym.urinary_retention', 'sym.saddle_numbness', 'sign.saddle_anesthesia', 'img.mri_canal_block']) expect(has(p, f)).toBe(false);
    }
    expect(share(ps, p => has(p, 'sym.sciatica'))).toBeGreaterThan(0.6);
    expect(share(ps, p => has(p, 'sign.slr_positive'))).toBeGreaterThan(0.6);
    expect(share(ps.filter(p => param(p, 'root') === 's1'), p => has(p, 'sign.ankle_reflex_low'))).toBeGreaterThan(0.6);
    for (const f of ['sym.pain_cough', 'hx.heavy_lifting']) {
      expect(share(ps, p => has(p, f))).toBeGreaterThan(0.35);
      expect(share(ps, p => has(p, f))).toBeLessThan(0.65);
    }
    const paresis = share(ps, p => param(p, 'paresis') === 'yes');
    expect(paresis).toBeGreaterThan(0.2);
    expect(paresis).toBeLessThan(0.4);
  });

  test('тактика: активность и НПВП; витамины группы B, габапентиноид и миорелаксант — можно; системные ГК, парацетамол, опиоиды и постель — не нужны', () => {
    const t = db.conditions[RAD].treatment!;
    expect([t.firstLine, t.acceptable, t.notIndicated, t.harmful]).toEqual([[ACTIVE, NSAID], [VITB, GABA, RELAX], [STEROID, 'tx.paracetamol', 'tx.morphine_iv', 'tx.bed_rest'], []]);
    expect([VITB, GABA, RELAX].map(tx => txGroupOfClass(db.treatments[tx].class))).toEqual(['metabolic', 'pain', 'pain']);
    // у неспецифической боли в спине новые лекарства — не нужны: их там нет
    expect([VITB, GABA, RELAX].map(tx => txRole(db, LBP, tx, {}))).toEqual(['notIndicated', 'notIndicated', 'notIndicated']);
    // проходит сама; активность лечит, НПВП облегчают
    expect(selfLimits(db, { id: RAD, params: { root: 'l5', paresis: 'no' } })).toBe(true);
    expect(curesOf(db, { id: RAD, params: { root: 's1', paresis: 'no' } }, [ACTIVE]).map(e => e.p)).toEqual([5000]);
    expect(db.treatments[NSAID].effects.find(e => e.on === RAD)).toMatchObject({ kind: 'relieve', p: 5000 });
  });

  test('место: дома; с парезом — и палата: плановая госпитализация (раздел 6)', () => {
    for (const p of ps.slice(0, 80)) {
      expect(recommendedSetting(db, p)).toBe('home');
      expect(alsoSettings(db, p)).toEqual(param(p, 'paresis') === 'yes' ? ['ward'] : []);
    }
  });

  test('разбор: активность и НПВП дома — без замечаний; с системными ГК — лишнее; МРТ без тревожных признаков — дорогая трата', () => {
    const p = patients(RAD, 1, 58_310, { paresis: 'no' })[0];
    const obs = checked(p);
    const grade = (x: Plan, cost = 0) => scoreCase({
      verdict: 'correct', confidence: 1, cost, rationalCost: 0, plan: evaluatePlan(db, p, x, obs, VENUE),
      outcome: { kind: 'recovered', day: 30, cured: true }, selfLimiting: true, redFlags: [],
    });
    expect(grade(plan([ACTIVE, NSAID]))).toMatchObject({ treatment: 'A', setting: 'A' });
    expect(evaluatePlan(db, p, plan([ACTIVE, NSAID, STEROID]), obs, VENUE).roles.find(r => r.tx === STEROID)!.role).toBe('notIndicated');
    expect(grade(plan([ACTIVE, NSAID, VITB])).treatment).toBe('A');
    // МРТ стоит, как полсотни приёмов: без тревожных признаков её цена — трата (Р12, УУР A)
    expect(db.exams[MRI].cost).toBeGreaterThan(5000);
    expect(grade(plan([ACTIVE, NSAID]), db.exams[MRI].cost).thrift).not.toBe('A');
  });
});

describe('синдром конского хвоста', () => {
  const ps = patients(CES, 300, 58_400);

  test('запись по 777_1: терапия, G83.4, критическое; подтверждает МРТ; задержка мочи и онемение промежности — красные флаги', () => {
    expect(db.conditions[CES]).toMatchObject({ icd10: 'G83.4', department: 'dept.therapy', system: 'nerves', kind: 'syndrome', severity: 'critical', confirm: [MRI] });
    expect(db.conditions[CES].group).toBeUndefined();
    expect(db.conditions[CES].redFlags).toEqual(['sym.urinary_retention', 'sym.saddle_numbness', 'sign.saddle_anesthesia']);
    expect(db.conditions[CES].differential).toEqual([RAD]);
    // «в редких случаях» (приложение В): в сто раз реже радикулопатии — игровая оценка
    expect(db.conditions[CES].weight).toBeLessThan(db.conditions[RAD].weight / 50);
    expect(verdictOf(db, RAD, ps[0])).toBe('wrong');
  });

  test('боль в спине и перекрытый канал у каждого; обычно — задержка мочи, онемение промежности и её чувствительность', () => {
    for (const p of ps) for (const f of ['sym.back_pain', 'img.mri_canal_block']) expect(has(p, f)).toBe(true);
    for (const f of ['sym.urinary_retention', 'sym.saddle_numbness', 'sign.saddle_anesthesia']) expect(share(ps, p => has(p, f))).toBeGreaterThan(0.6);
    for (const f of ['sym.legs_weak', 'sign.legs_paresis', 'sign.bladder_distended']) expect(share(ps, p => has(p, f))).toBeGreaterThan(0.35);
    // хоть один красный флаг — почти у каждого
    expect(share(ps, p => ['sym.urinary_retention', 'sym.saddle_numbness', 'sign.saddle_anesthesia'].some(f => has(p, f)))).toBeGreaterThan(0.95);
  });

  test('тактика: перевод в нейрохирургию, НПВП — можно; без перевода хуже; домой — ошибка, и красный флаг без внимания — замечание', () => {
    const t = db.conditions[CES].treatment!;
    expect([t.firstLine, t.acceptable, t.notIndicated, t.harmful]).toEqual([[], [NSAID], [STEROID, 'tx.bed_rest'], []]);
    expect(selfLimits(db, { id: CES, params: {} })).toBe(false);
    expect(untreatedOf(db, { id: CES, params: {} })).toMatchObject({ p: 7500, days: [1, 7] });
    for (const p of ps.slice(0, 40)) {
      expect(recommendedSetting(db, p)).toBe('transfer');
      expect(alsoSettings(db, p)).toEqual([]);
    }
    const p = ps.find(x => has(x, 'sym.urinary_retention'))!;
    const obs = checked(p);
    const grade = (x: Plan, seen: boolean) => scoreCase({
      verdict: 'correct', confidence: 1, cost: 0, rationalCost: 0, plan: evaluatePlan(db, p, x, obs, VENUE),
      outcome: { kind: x.setting === 'home' ? 'worse' : 'transferred', day: 0, cured: false }, selfLimiting: false,
      redFlags: [{ f: 'sym.urinary_retention', seen }],
    });
    expect(grade(plan([], 'ambulance'), true).setting).toBe('A');
    expect(grade(plan([NSAID], 'home'), true)).toMatchObject({ setting: 'D', safety: 'D' });
  });
});

describe('обследования', () => {
  test('МРТ позвоночника — в кабинете МРТ на томографе 1,5 Тл; находит грыжу у корешка и перекрытый канал; грыжи бывают и без боли', () => {
    expect(db.exams[MRI]).toMatchObject({ kind: 'imaging', room: 'room.mri', equipment: ['eq.mri_15'], radiation: 'none' });
    expect(db.exams[MRI].checks.map(c => c.f)).toEqual(['img.mri_disc_herniation', 'img.mri_canal_block']);
    expect(examMinutes(db.exams[MRI])).toBe(35);
    // фон грыжи — каждый пятый (раздел 1.2): находка без клиники диагноз не ставит
    expect(db.findings['img.mri_disc_herniation'].leak).toBeGreaterThan(1500);
    expect(db.findings['img.mri_canal_block'].leak).toBeLessThan(100);
  });

  test('расспрос о спине — кашель, онемение, тяжесть и красные флаги; неврологический осмотр — каждому с болью ниже колена; пузырь — на пальпации', () => {
    expect(db.exams['exam.ask_back'].checks.map(c => c.f)).toEqual(expect.arrayContaining(['sym.pain_cough', 'sym.leg_tingling', 'hx.heavy_lifting', 'sym.urinary_retention', 'sym.saddle_numbness', 'sym.legs_weak']));
    expect(db.exams['exam.neuro_exam'].routineFor).toEqual(expect.arrayContaining(['sym.sciatica', 'sym.saddle_numbness', 'sym.legs_weak']));
    expect(db.exams['exam.neuro_exam'].checks.map(c => c.f)).toEqual(expect.arrayContaining(['sign.heel_walk_weak', 'sign.toe_walk_weak', 'sign.ankle_reflex_low', 'sign.leg_hypoesthesia', 'sign.saddle_anesthesia', 'sign.legs_paresis']));
    expect(db.exams['exam.abdomen_palpation'].routineFor).toContain('sym.urinary_retention');
    expect(db.exams['exam.abdomen_palpation'].checks.map(c => c.f)).toContain('sign.bladder_distended');
  });
});

describe('МРТ позвоночника в карте', () => {
  const ASK = 'exam.ask_back';
  const NEURO = 'exam.neuro_exam';
  /** Карта с результатом МРТ: `shown` — что показала МРТ, `told` — что сказал больной, `seen` — что нашёл осмотр. */
  const image = (seed: number, shown: readonly string[], told: readonly string[] = [], seen: readonly string[] = []) => {
    const p = generatePatient(db, seed, { department: 'dept.therapy', departments: ED, season: 'autumn', primary: RAD, params: {} });
    const obs = (exam: Id, fs: readonly string[], on: readonly string[]): Observation[] => fs.map(f => ({ f, shown: on.includes(f), exam }));
    const input: CaseInput = {
      version: 1, patient: p, clock: 600, minutesSpent: 0, money: 0, step: 1, pending: [], meanwhile: [], done: [ASK, NEURO, MRI],
      draft: { treatments: [], setting: 'home' },
      arrived: [
        { exam: ASK, step: 1, at: 580, obs: obs(ASK, ['sym.urinary_retention'], told) },
        { exam: NEURO, step: 1, at: 590, obs: obs(NEURO, ['sign.heel_walk_weak', 'sign.toe_walk_weak', 'sign.ankle_reflex_low'], seen) },
        { exam: MRI, step: 1, at: 600, obs: obs(MRI, ['img.mri_disc_herniation', 'img.mri_canal_block'], shown) },
      ],
    };
    return { p, img: makeCaseView(input).groups.find(g => g.exam === MRI)!.image as { kind: 'spine'; seed: number; findings: SpineFindings } };
  };

  test('грыжа у корешка — купол в канал, перекрытый канал — во всю глубину, ничего — обычный срез; уровень — по корешку; пузырь — при задержке мочи', () => {
    for (const seed of [5801, 5802]) {
      const { p, img } = image(seed, []);
      expect(img).toMatchObject({ kind: 'spine', findings: {} });
      const bulge = image(seed, ['img.mri_disc_herniation']).img.findings.hernia!;
      expect(bulge.size).toBeGreaterThanOrEqual(0.35);
      expect(bulge.size).toBeLessThan(0.75);
      // без подсказки осмотра уровень — по зерну пациента
      expect(bulge.level).toBe(p.seed % 2 === 1 ? 'L4-L5' : 'L5-S1');
      // не встаёт на пятку — L5, грыжа L4–L5; на носок или снижен ахиллов рефлекс — S1, грыжа L5–S1
      expect(image(seed, ['img.mri_disc_herniation'], [], ['sign.heel_walk_weak']).img.findings.hernia!.level).toBe('L4-L5');
      for (const f of ['sign.toe_walk_weak', 'sign.ankle_reflex_low']) expect(image(seed, ['img.mri_disc_herniation'], [], [f]).img.findings.hernia!.level).toBe('L5-S1');
      expect(image(seed, ['img.mri_disc_herniation', 'img.mri_canal_block']).img.findings.hernia!.size).toBeGreaterThanOrEqual(0.75);
      expect(image(seed, ['img.mri_canal_block'], ['sym.urinary_retention']).img.findings.bladder).toBeGreaterThan(0.5);
      expect(image(seed, ['img.mri_canal_block']).img.findings.bladder).toBeUndefined();
    }
  });
});

/** Разумный врач по шагам: в приёмном с палатой, ПИТ, реанимацией и кабинетом МРТ. */
function doctor(p: Patient, exams = Object.keys(db.exams).sort()) {
  const obs: Observation[] = complaintObservations(p);
  const done: Id[] = [];
  const rng = Rng.seeded(p.seed).fork('doctor');
  const candidates = candidatesOf(db, ED);
  let phase: DoctorPhase = {};
  for (;;) {
    const minutes = done.reduce((a, id) => a + examMinutes(db.exams[id]), 0);
    const r = nextStep(db, p, obs, done, phase, { candidates, exams, threshold: 0.9, minGain: MIN_GAIN, venue: { ...VENUE, minutes } });
    phase = r.phase;
    if (r.step.kind === 'decide') return { ...r.step, done, obs, minutes };
    obs.push(...runExam(db, p, r.step.exam, rng.fork(`exam:${done.length}:${r.step.exam}`)));
    done.push(r.step.exam);
  }
}

describe('разумный врач', () => {
  const rad = patients(RAD, 60, 58_200).map(p => ({ p, r: doctor(p) }));
  const ces = patients(CES, 60, 58_200).map(p => ({ p, r: doctor(p) }));

  test('радикулопатию ставит у большинства, остальным — неспецифическую боль в спине: та же группа, то же лечение; МРТ не делает', () => {
    expect(share(rad, x => x.r.diagnosis === RAD)).toBeGreaterThan(0.7);
    expect(share(rad, x => verdictOf(db, x.r.diagnosis, x.p) !== 'wrong')).toBeGreaterThan(0.95);
    expect(share(rad, x => x.r.done.includes(MRI))).toBeLessThan(0.05);
    for (const x of rad.filter(y => verdictOf(db, y.r.diagnosis, y.p) !== 'wrong')) {
      expect(x.r.plan.treatments).toEqual(expect.arrayContaining([ACTIVE]));
      expect(x.r.plan.treatments).not.toContain(STEROID);
      expect(x.r.plan.setting).toBe('home');
    }
  });

  test('конский хвост ставит почти у каждого и переводит; неврологический осмотр — почти каждому', () => {
    expect(share(ces, x => x.r.diagnosis === CES)).toBeGreaterThan(0.85);
    for (const x of ces.filter(y => y.r.diagnosis === CES)) expect(x.r.plan.setting).toBe('ambulance');
    expect(share(ces, x => x.r.done.includes('exam.neuro_exam'))).toBeGreaterThan(0.85);
  });
});

describe('энциклопедия', () => {
  test('тактика строками; новые записи — статьями', () => {
    const rows = (id: Id) => Object.fromEntries(article(db, id)!.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(x => x.id)]));
    expect(rows(RAD)).toMatchObject({ 'Можно также': [VITB, GABA, RELAX], 'Не нужно': [STEROID, 'tx.paracetamol', 'tx.morphine_iv', 'tx.bed_rest'] });
    expect(rows(CES)).toMatchObject({ 'Можно также': [NSAID], 'Не нужно': [STEROID, 'tx.bed_rest'] });
    for (const id of [RAD, CES, MRI, VITB, GABA, RELAX, 'hx.heavy_lifting', 'sym.pain_cough', 'sym.leg_tingling', 'sym.urinary_retention', 'sym.saddle_numbness', 'sym.legs_weak', 'sign.heel_walk_weak', 'sign.toe_walk_weak', 'sign.ankle_reflex_low', 'sign.leg_hypoesthesia', 'sign.saddle_anesthesia', 'sign.legs_paresis', 'sign.bladder_distended', 'img.mri_disc_herniation', 'img.mri_canal_block']) {
      expect(article(db, id)).toBeDefined();
    }
  });
});
