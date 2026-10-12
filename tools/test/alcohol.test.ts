// Алкоголь (spec 2026-10-chapter-4, часть 54б). Синдром зависимости — фон, с ним не приходят. Синдром отмены — по 784_1:
// тяжесть по CIWA-Ar, тиамин и нарколог — каждому, бензодиазепин и растворы в вену — при средней и тяжёлой, лёгкую лечат
// дома. Алкогольный гепатит — по 711_2: желтуха, АСТ выше АЛТ, тяжесть по индексу Маддрея — при тяжёлом преднизолон; отказ
// от алкоголя, еда с белком и нарколог — каждому, лечат в стационаре. Глюкоза зависимому от алкоголя — только с тиамином.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient, typicalPatient } from '../../src/engine/med/generate';
import { knownFacts } from '../../src/engine/med/infer';
import { alsoSettings, curesOf, evaluatePlan, recommendedSetting, txRole, type Venue } from '../../src/engine/med/plan';
import { choosePlan, type DoctorPhase, examMinutes, MIN_GAIN, nextStep } from '../../src/engine/med/policy';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { article } from '../../src/state/encyclopedia';

// разумный врач по сотне больных — дольше 5 секунд
setDefaultTimeout(60_000);

const DEP = 'cond.alcohol_dependence';
const AWS = 'cond.alcohol_withdrawal';
const BENZO = 'tx.benzodiazepine';
const THIA = 'tx.thiamine';
const NARC = 'tx.narcologist_consult';
const FLUIDS = ['tx.balanced_fluids', 'tx.iv_fluids'];
const AH = 'cond.alcoholic_hepatitis';
const STEROID = 'tx.steroid_systemic_short';
const DIET = 'tx.liver_diet';
const DEX = 'tx.dextrose_iv';
const HYPO = 'cond.hypoglycemia';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma'];

const therapy = (primary: Id, n: number, from: number, params: Record<string, string> = {}) =>
  Array.from({ length: n }, (_, i) => typicalPatient(db, k => (from + i) * 31 + k, { department: 'dept.therapy', departments: ED, season: 'autumn', primary, params }));
const has = (p: Patient, f: string) => p.truth.findings.some(x => x.f === f);
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;
const near = (x: number, want: number, tol: number) => {
  expect(x).toBeGreaterThan(want - tol);
  expect(x).toBeLessThan(want + tol);
};
const params = (p: Patient) => p.truth.conditions.find(c => c.role === 'primary')!.params;

describe('синдром зависимости от алкоголя — фон', () => {
  test('запись: с ним не приходят; у злоупотребляющих алкоголем — у четырёх из десяти, у остальных почти нет', () => {
    expect(db.conditions[DEP]).toMatchObject({ icd10: 'F10.2', presenting: false, confirm: 'clinical' });
    const ps = Array.from({ length: 20000 }, (_, i) => generatePatient(db, 410_000 + i, { department: 'dept.therapy', season: 'autumn', walkIn: true }));
    const dependent = (p: Patient) => p.truth.conditions.some(c => c.id === DEP);
    near(share(ps.filter(p => p.truth.risks.includes('risk.alcohol')), dependent), 0.4, 0.05);
    expect(share(ps.filter(p => !p.truth.risks.includes('risk.alcohol')), dependent)).toBeLessThan(0.005);
  });

  test('запои и похмелье по утрам выдают зависимость, а «выпивает почти каждый день» — только злоупотребление', () => {
    const seen = (f: Id): Observation[] => [{ f, shown: true, exam: 'exam.ask_lifestyle' }];
    expect(knownFacts(db, seen('hx.binge')).conditions).toContain(DEP);
    expect(knownFacts(db, seen('hx.alcohol')).conditions).not.toContain(DEP);
    expect(knownFacts(db, seen('hx.alcohol')).risks).toContain('risk.alcohol');
  });
});

describe('синдром отмены алкоголя', () => {
  const ps = therapy(AWS, 300, 54_100);

  test('запись по 784_1: терапия, только при зависимости, тяжесть по CIWA-Ar; подтверждают клинически', () => {
    expect(db.conditions[AWS]).toMatchObject({ icd10: 'F10.3', department: 'dept.therapy', requires: [DEP], confirm: 'clinical', params: { severity: { mild: 45, moderate: 35, severe: 20 } } });
    for (const p of ps) expect(p.truth.conditions.some(c => c.id === DEP)).toBe(true);
  });

  test('признаки: бросил пить — у каждого; CIWA-Ar 9–15 — ровно при средней, 16 и больше — при тяжёлой; судороги и обманы восприятия — не при лёгкой', () => {
    for (const p of ps) {
      const s = params(p).severity;
      expect(has(p, 'hx.stopped_drinking')).toBe(true);
      expect(has(p, 'sign.ciwa')).toBe(s === 'moderate');
      expect(has(p, 'sign.ciwa_16')).toBe(s === 'severe');
      if (s === 'mild') expect(has(p, 'sym.seizure') || has(p, 'sym.hallucinations')).toBe(false);
    }
    near(share(ps, p => has(p, 'sym.tremor')), 0.75, 0.08);
    near(share(ps.filter(p => params(p).severity === 'severe'), p => has(p, 'sym.hallucinations')), 0.75, 0.15);
    near(share(ps.filter(p => params(p).severity === 'severe'), p => has(p, 'sym.seizure')), 0.25, 0.15);
  });

  test('шкала CIWA-Ar: лёгкая — до 8 баллов, средняя — 9–15, тяжёлая — 16 и больше', () => {
    const score = (p: Patient) => {
      const obs = runExam(db, p, 'exam.ciwa', Rng.seeded(p.seed).fork('ciwa'));
      return obs.find(o => o.f === 'sign.ciwa')?.value ?? obs.find(o => o.f === 'sign.ciwa_16')?.value ?? -1;
    };
    const band = (sev: string, lo: number, hi: number) => share(ps.filter(p => params(p).severity === sev), p => score(p) >= lo && score(p) <= hi);
    expect(band('mild', 0, 8)).toBeGreaterThan(0.9);
    expect(band('moderate', 9, 15)).toBeGreaterThan(0.9);
    expect(band('severe', 16, 30)).toBeGreaterThan(0.9);
    expect(db.exams['exam.ciwa'].routineSeen).toEqual(['hx.stopped_drinking']);
  });

  test('тактика по 784_1: бензодиазепин — первая линия, при средней и тяжёлой обязателен с растворами; тиамин — профилактика, нарколог — каждому', () => {
    const t = db.conditions[AWS].treatment!;
    expect(t.firstLine).toEqual([BENZO]);
    expect(t.prevent).toEqual([THIA]);
    expect(t.require).toEqual([NARC]);
    expect(txRole(db, AWS, 'tx.valproate_iv', { severity: 'severe' })).toBe('acceptable');
    expect(txRole(db, AWS, 'tx.ors', { severity: 'mild' })).toBe('supportive');
    const one = (sev: string) => ps.find(p => params(p).severity === sev)!;
    const venue: Venue = { ward: true, icu: true };
    // средняя без бензодиазепина — обязательного нет; лёгкая без тиамина — нет профилактики
    const moderate = one('moderate');
    const noBenzo = evaluatePlan(db, moderate, { treatments: [THIA, NARC, FLUIDS[0]], setting: 'admit' }, complaintObservations(moderate), venue);
    expect(noBenzo.requireMissing).toContain(BENZO);
    const full = evaluatePlan(db, moderate, { treatments: [BENZO, THIA, NARC, FLUIDS[0]], setting: 'admit' }, complaintObservations(moderate), venue);
    expect(full.requireMissing).toEqual([]);
    expect(full.preventMissing).toEqual([]);
    const mild = one('mild');
    expect(evaluatePlan(db, mild, { treatments: [NARC, 'tx.ors'], setting: 'home' }, complaintObservations(mild), venue).preventMissing).toEqual([THIA]);
  });

  test('место: лёгкая — дома, средняя и тяжёлая — в стационаре, при тяжёлой ПИТ не ошибка', () => {
    const one = (sev: string) => ps.find(p => params(p).severity === sev)!;
    expect(recommendedSetting(db, one('mild'))).toBe('home');
    expect(recommendedSetting(db, one('moderate'))).toBe('ward');
    expect(recommendedSetting(db, one('severe'))).toBe('ward');
    expect(alsoSettings(db, one('severe'))).toEqual(['icu']);
    expect(alsoSettings(db, one('moderate'))).toEqual([]);
  });
});

describe('алкогольный гепатит', () => {
  const hs = therapy(AH, 300, 54_200);
  const one = (sev: string) => hs.find(p => params(p).severity === sev)!;

  test('запись по 711_2: терапия, только при зависимости, K70.1; подтверждают печёночные пробы; тяжесть — лёгкий и тяжёлый', () => {
    expect(db.conditions[AH]).toMatchObject({ icd10: 'K70.1', department: 'dept.therapy', requires: [DEP], confirm: ['exam.liver_panel'], params: { severity: { mild: 60, severe: 40 } } });
    expect(db.conditions[AH].risks).toEqual([{ id: 'cond.cirrhosis', x: 24 }]);
    for (const p of hs) expect(p.truth.conditions.some(c => c.id === DEP)).toBe(true);
  });

  test('признаки: желтуха — у каждого; билирубин выше 200 и сниженный протромбиновый индекс — при тяжёлом; АСТ выше АЛТ — у большинства', () => {
    for (const p of hs) {
      expect(has(p, 'sym.yellow_skin') && has(p, 'sign.jaundice') && has(p, 'lab.bilirubin_high')).toBe(true);
      if (params(p).severity === 'severe') expect(has(p, 'lab.bilirubin_200') && has(p, 'lab.pti_low')).toBe(true);
    }
    expect(share(hs.filter(p => params(p).severity === 'mild'), p => has(p, 'lab.bilirubin_200'))).toBeLessThan(0.05);
    near(share(hs, p => has(p, 'lab.ast_over_alt')), 0.75, 0.08);
    // при остром вирусном гепатите выше АЛТ: АСТ выше АЛТ — только фон
    const hav = therapy('cond.hepatitis_a', 100, 54_600);
    expect(share(hav, p => has(p, 'lab.ast_over_alt'))).toBeLessThan(0.05);
  });

  test('тактика по 711_2: отказ от алкоголя и еда с белком, нарколог — каждому; при тяжёлом — преднизолон, при лёгком он не нужен; парацетамол и ибупрофен — вред', () => {
    const t = db.conditions[AH].treatment!;
    expect(t.firstLine).toEqual([DIET]);
    expect(t.require).toEqual([NARC]);
    expect(t.harmful).toEqual(['tx.ibuprofen', 'tx.paracetamol']);
    expect(txRole(db, AH, STEROID, { severity: 'severe' })).toBe('require');
    expect(txRole(db, AH, STEROID, { severity: 'mild' })).toBe('notIndicated');
    expect(txRole(db, AH, 'tx.ademetionine', { severity: 'severe' })).toBe('supportive');
    const venue: Venue = { ward: true, icu: true };
    const severe = one('severe');
    expect(evaluatePlan(db, severe, { treatments: [DIET, NARC], setting: 'admit' }, complaintObservations(severe), venue).requireMissing).toContain(STEROID);
    expect(evaluatePlan(db, severe, { treatments: [DIET, NARC, STEROID], setting: 'admit' }, complaintObservations(severe), venue).requireMissing).toEqual([]);
    // излечивает преднизолон — только тяжёлый: лёгкий без алкоголя проходит сам
    expect(curesOf(db, { id: AH, params: { severity: 'severe' } }, [STEROID]).map(e => e.p)).toEqual([7500]);
    expect(curesOf(db, { id: AH, params: { severity: 'mild' } }, [STEROID])).toEqual([]);
  });

  test('место: в стационаре — желтуха; при тяжёлом ПИТ не ошибка', () => {
    expect(recommendedSetting(db, one('mild'))).toBe('ward');
    expect(recommendedSetting(db, one('severe'))).toBe('ward');
    expect(alsoSettings(db, one('severe'))).toEqual(['icu']);
    expect(alsoSettings(db, one('mild'))).toEqual([]);
  });
});

describe('глюкоза зависимому от алкоголя — только с тиамином', () => {
  const who = { age: 55, sex: 'm' as const };
  const seen = (f: Id, exam: Id, on = true, value?: number): Observation => ({ f, shown: on, exam, ...(value !== undefined ? { value } : {}) });
  // тяжёлая гипогликемия на инсулине — декстроза в вену (часть 44а)
  const severe = [seen('sym.confusion', 'complaint'), seen('sign.gcs_low', 'exam.neuro_exam', true, 14), seen('lab.glucose_low', 'exam.glucometer', true, 2.2), seen('hx.insulin', 'exam.ask_meds'), seen('hx.sulfonylurea', 'exam.ask_meds', false)];
  const binge = seen('hx.binge', 'exam.ask_lifestyle');
  const venue: Venue = { ward: true, icu: true, bedside: ['eq.monitor_defib'] };

  test('запись: спутник декстрозы — тиамин, только у тех, у кого синдром зависимости от алкоголя', () => {
    for (const tx of [DEX, 'tx.dextrose_infusion']) expect(db.treatments[tx]).toMatchObject({ companions: [THIA], companionsIf: [DEP] });
  });

  test('гипогликемия: о запоях знает — разумный врач добавляет тиамин, а без него лечение неполное; не знает — не требуем', () => {
    expect(choosePlan(db, HYPO, [...severe, binge], who, venue)).toEqual({ treatments: [DEX, THIA], setting: 'admit' });
    expect(choosePlan(db, HYPO, severe, who, venue)).toEqual({ treatments: [DEX], setting: 'admit' });
    const p = generatePatient(db, 54_300, { department: 'dept.therapy', departments: ED, season: 'winter', primary: HYPO, params: { severity: 'severe' } });
    const dexOnly = { treatments: [DEX], setting: 'admit' as const };
    expect(evaluatePlan(db, p, dexOnly, [...severe, binge], venue).companionsMissing).toEqual([{ tx: THIA, of: DEX }]);
    expect(evaluatePlan(db, p, dexOnly, severe, venue).companionsMissing).toEqual([]);
  });

  test('синдром отмены и гепатит бывают только при зависимости: декстроза без тиамина неполная и без расспроса', () => {
    for (const id of [AWS, AH]) {
      const p = therapy(id, 1, 54_400)[0];
      expect(evaluatePlan(db, p, { treatments: [DEX], setting: 'admit' }, complaintObservations(p), { ward: true }).companionsMissing).toEqual([{ tx: THIA, of: DEX }]);
    }
  });
});

/** Разумный врач по шагам — с местом больницы. */
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
    if (r.step.kind === 'decide') return { ...r.step, done };
    obs.push(...runExam(db, p, r.step.exam, rng.fork(`exam:${done.length}:${r.step.exam}`)));
    done.push(r.step.exam);
  }
}

describe('разумный врач', () => {
  const all = Object.keys(db.exams).sort();
  const HOSPITAL: Venue = { ward: true, icu: true, ricu: true, or: true };

  test('синдром отмены: тиамин и нарколог каждому; лёгкую — домой, среднюю и тяжёлую — в стационар с бензодиазепином и растворами', () => {
    const ps = therapy(AWS, 60, 6100);
    const rs = ps.map(p => doctor(p, all, HOSPITAL));
    expect(share(rs, r => r.diagnosis === AWS)).toBeGreaterThan(0.9);
    expect(share(rs, r => r.plan.treatments.includes(THIA) && r.plan.treatments.includes(NARC))).toBeGreaterThan(0.9);
    // тяжесть — по шкале CIWA-Ar, сахар — глюкометром: дрожь и пот бывают и при гипогликемии
    expect(share(rs, r => r.done.includes('exam.ciwa'))).toBeGreaterThan(0.8);
    expect(share(rs, r => r.done.includes('exam.glucometer'))).toBeGreaterThan(0.7);
    const mild = rs.filter((_, i) => params(ps[i]).severity === 'mild');
    expect(share(mild, r => r.plan.setting === 'home')).toBeGreaterThan(0.75);
    const heavy = rs.filter((_, i) => params(ps[i]).severity !== 'mild');
    expect(share(heavy, r => ['admit', 'icu'].includes(r.plan.setting))).toBeGreaterThan(0.9);
    expect(share(heavy, r => r.plan.treatments.includes(BENZO) && FLUIDS.some(t => r.plan.treatments.includes(t)))).toBeGreaterThan(0.9);
  });

  test('алкогольный гепатит: отказ от алкоголя и нарколог каждому, всех — в стационар; тяжесть — по свёртываемости или билирубину, при тяжёлом — преднизолон', () => {
    const hs = therapy(AH, 60, 6200);
    const rs = hs.map(p => doctor(p, all, HOSPITAL));
    expect(share(rs, r => r.diagnosis === AH)).toBeGreaterThan(0.9);
    expect(share(rs, r => r.plan.treatments.includes(DIET) && r.plan.treatments.includes(NARC))).toBeGreaterThan(0.9);
    expect(share(rs, r => ['admit', 'icu'].includes(r.plan.setting))).toBeGreaterThan(0.9);
    expect(share(rs, r => r.done.includes('exam.coagulation') || r.done.includes('exam.liver_panel'))).toBeGreaterThan(0.9);
    const severe = rs.filter((_, i) => params(hs[i]).severity === 'severe');
    expect(share(severe, r => r.plan.treatments.includes(STEROID))).toBeGreaterThan(0.85);
    const mild = rs.filter((_, i) => params(hs[i]).severity === 'mild');
    expect(share(mild, r => !r.plan.treatments.includes(STEROID))).toBeGreaterThan(0.85);
  });
});

describe('энциклопедия', () => {
  test('синдром отмены: профилактика и обязательное — словами, при средней и тяжёлой — бензодиазепин и растворы; новое — статьи', () => {
    const rows = Object.fromEntries(article(db, AWS)!.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(x => x.id)]));
    expect(rows).toMatchObject({ 'Первая линия': [BENZO], 'Обязательная профилактика': [THIA], 'Обязательно': [NARC], 'Обязательно, при среднетяжёлом и тяжёлом течении': [BENZO] });
    for (const id of [AWS, DEP, THIA, NARC, 'exam.ciwa', 'sign.ciwa', 'sign.ciwa_16', 'hx.binge', 'hx.stopped_drinking', 'sym.anxiety', 'sym.insomnia', 'sym.craving', 'sym.hallucinations']) expect(article(db, id)).toBeDefined();
  });

  test('алкогольный гепатит: преднизолон обязателен при тяжёлом и не нужен при лёгком; у декстрозы — «Только тем, у кого» зависимость', () => {
    const rows = Object.fromEntries(article(db, AH)!.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(x => x.id)]));
    expect(rows).toMatchObject({ 'Первая линия': [DIET], 'Обязательно': [NARC], 'Обязательно, при тяжёлом течении': [STEROID], 'Не нужно, при лёгком течении': [STEROID], 'Опасно': ['tx.ibuprofen', 'tx.paracetamol'] });
    const dex = Object.fromEntries(article(db, DEX)!.blocks.find(b => b.key === 'companions')!.rows!.map(r => [r.label, r.refs.map(x => x.id)]));
    expect(dex).toEqual({ 'Каждое': [THIA], 'Только тем, у кого': [DEP] });
    for (const id of [AH, 'tx.ademetionine', 'lab.ast_over_alt']) expect(article(db, id)).toBeDefined();
  });
});
