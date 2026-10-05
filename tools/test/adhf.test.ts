// Острая декомпенсация сердечной недостаточности (spec 2026-10-chapter-3, часть 43в; 156_2 «Хроническая сердечная
// недостаточность», раздел 7; ALARM-HF, ICON, Collins 2006): три формы — застой, отёк лёгких и «холодный» с
// гипоперфузией; NT-proBNP и снимок груди с застоем; тёплому — фуросемид в вену, при отёке лёгких — ещё нитроглицерин
// и маска CPAP; «холодному» — допамин, мочегонное, нитроглицерин и CPAP вредны; ПИТ — если хоть один признак: отёк
// лёгких, гипоперфузия, частота дыхания выше 25 или сатурация ниже 90 (производный параметр «хоть один из»).
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { crosses, type DerivedByParams, type DerivedByValue, type Id, paramsHold, type Setting } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient, presentingWeight } from '../../src/engine/med/generate';
import { paramBeliefs } from '../../src/engine/med/infer';
import { curesOf, evaluatePlan, type Plan, txAvailable, txRole, untreatedOf, type Venue } from '../../src/engine/med/plan';
import { type DoctorPhase, examMinutes, nextStep } from '../../src/engine/med/policy';
import { observationText } from '../../src/engine/med/text';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { makeCaseView, txGroupOfClass } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const HF = 'cond.adhf';
const FUROSEMIDE = 'tx.furosemide_iv';
const NITRO = 'tx.nitroglycerin_iv';
const CPAP = 'tx.cpap';
const DOPAMINE = 'tx.dopamine';
const MONITOR = 'eq.monitor_defib';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology'];
const BAY: Venue = { bedside: [MONITOR], icu: true };

const paramsOf = (p: Patient) => p.truth.conditions.find(c => c.role === 'primary')!.params;
const byHf = (p: Patient, f: Id) => p.truth.findings.some(x => x.f === f && x.cause === HF);
const gen = (seed: number, params: Record<string, string> = {}) =>
  generatePatient(db, seed, { department: 'dept.therapy', departments: ED, season: 'winter', primary: HF, params });
/** Больные в возрасте болезни. */
function people(n: number, params: Record<string, string> = {}, from = 1): Patient[] {
  const out: Patient[] = [];
  for (let seed = from; out.length < n; seed++) {
    if (seed > from + 100_000) throw new Error('нет таких больных');
    const p = gen(seed, params);
    if (p.age >= db.conditions[HF].age.min) out.push(p);
  }
  return out;
}
const seen = (f: Id, exam: Id, on = true): Observation => ({ f, shown: on, exam });
/** Всё, что видит врач, — правда: каждое обследование показало то, что есть. */
const truthful = (p: Patient, exams: Id[]): Observation[] => [
  ...complaintObservations(p),
  ...exams.flatMap((exam, i) => runExam(db, p, exam, Rng.seeded(i).fork(exam), undefined, true)),
];
const plan = (treatments: Id[], setting: Setting = 'home'): Plan => ({ treatments: [...treatments].sort(), setting });
const ALL = ['exam.ask_chronic', 'exam.ask_complaints', 'exam.vitals', 'exam.general_exam', 'exam.lung_auscultation', 'exam.nt_probnp', 'exam.xray_chest', 'exam.ecg'];

describe('каталог', () => {
  test('терапия, угрожает жизни, приходят и сами; подтверждает NT-proBNP; три формы по ALARM-HF; место — палата, ПИТ по признакам', () => {
    const c = db.conditions[HF];
    expect(c).toMatchObject({
      icd10: 'I50.0', department: 'dept.therapy', severity: 'critical', confirm: ['exam.nt_probnp'],
      redFlags: ['vital.bp_low', 'sign.cold_clammy', 'sign.crackles_diffuse'],
    });
    expect(c.arrival).toBeUndefined();
    expect(c.params!.type).toEqual({ congestion: 44, edema: 42, cold: 14 });
    expect(c.derived).toEqual({
      spo2_below90: { f: 'vital.spo2_low', below: 90 },
      rr_above25: { f: 'vital.tachypnea', above: 25 },
      icu: { any: { type: ['edema', 'cold'], rr_above25: ['yes'], spo2_below90: ['yes'] } },
    });
    expect(c.treatment!.setting).toEqual({ default: 'ward', param: { name: 'icu', map: { yes: 'icu', no: 'ward' } }, redFlag: 'icu' });
    // хроническая сердечная недостаточность в прошлом — ×150: у скорой она уже была у 62 из 100 (ALARM-HF: впервые — 36 %)
    const who = { sex: 'f' as const, age: 75, season: 'winter' as const, risks: [] as Id[], chronic: [] as Id[] };
    expect(presentingWeight(c, { ...who, risks: ['risk.heart_failure'] }) / presentingWeight(c, who)).toBe(150);
  });

  test('NT-proBNP — 90/84 (ICON), каждому с одышкой лёжа, хрипами в обоих лёгких и отёками ног; снимок груди — застой 81 % (Collins), отёк, тень сердца', () => {
    const nt = db.exams['exam.nt_probnp'];
    expect(nt).toMatchObject({ kind: 'lab', room: 'room.lab', equipment: ['eq.immuno_analyzer'], routineFor: ['sym.orthopnea'] });
    expect(nt.routineSeen).toEqual(['sign.crackles_bilateral', 'sign.crackles_diffuse', 'sign.leg_edema_bilateral']);
    expect(nt.checks).toEqual([expect.objectContaining({ f: 'lab.ntprobnp_high', sens: 9000, spec: 8400 })]);
    const xr = db.exams['exam.xray_chest'];
    expect(xr.checks.find(k => k.f === 'img.cxr_congestion')).toMatchObject({ sens: 8100, spec: 9500 });
    expect(xr.checks.find(k => k.f === 'img.cxr_edema')).toMatchObject({ sens: 9000, spec: 9900 });
    expect(xr.checks.find(k => k.f === 'img.cxr_cardiomegaly')).toMatchObject({ sens: 9000, spec: 9500 });
    expect(xr.routineSeen).toEqual(['sign.crackles_bilateral', 'sign.crackles_diffuse']);
    // ЭКГ — всем с ОДСН (раздел 7.3.2); холодную кожу и слабый пульс отмечают вместе с пульсом
    expect(db.exams['exam.ecg'].routineFor).toContain('sym.orthopnea');
    expect(db.exams['exam.ecg'].routineSeen).toEqual(expect.arrayContaining(['sign.crackles_bilateral', 'sign.crackles_diffuse']));
    expect(db.exams['exam.vitals'].checks.find(k => k.f === 'sign.cold_clammy')).toMatchObject({ sens: 9500, spec: 9800 });
    for (const f of ['sign.crackles_bilateral', 'sign.crackles_diffuse']) expect(db.exams['exam.lung_auscultation'].checks.some(k => k.f === f)).toBe(true);
    expect(db.exams['exam.ask_complaints'].checks.some(k => k.f === 'sym.orthopnea')).toBe(true);
  });

  test('фуросемид в вену — и в кабинете, без монитора; CPAP — у постели под монитором; группы — «Сердце и сосуды» и «Кислород»', () => {
    expect(db.treatments[FUROSEMIDE]).toMatchObject({ route: 'iv', class: 'diuretic.loop' });
    expect(txAvailable(db, FUROSEMIDE, {})).toBe(true);
    expect(txAvailable(db, CPAP, {})).toBe(false);
    expect(txAvailable(db, CPAP, BAY)).toBe(true);
    expect(txGroupOfClass(db.treatments[FUROSEMIDE].class)).toBe('heart');
    expect(txGroupOfClass(db.treatments[CPAP].class)).toBe('oxygen');
  });
});

describe('производные параметры: порог «выше» и «хоть один из»', () => {
  const d = db.conditions[HF].derived!;
  const xs = people(600);

  test('частота дыхания выше 25 — по настоящему числу; ниже порога и «нет числа» — «no»', () => {
    const rr = d.rr_above25 as DerivedByValue;
    expect([crosses(rr, 26), crosses(rr, 25), crosses({ f: 'vital.spo2_low', below: 90 }, 89), crosses({ f: 'vital.spo2_low', below: 90 }, 90)]).toEqual([true, false, true, false]);
    for (const p of xs) {
      const v = p.truth.values['vital.tachypnea'];
      expect({ seed: p.seed, rr: paramsOf(p).rr_above25 }).toEqual({ seed: p.seed, rr: v !== undefined && v > 25 ? 'yes' : 'no' });
    }
  });

  test('ПИТ — если хоть один из признаков; у больных — по их параметрам', () => {
    const icu = d.icu as DerivedByParams;
    expect(paramsHold(icu, { type: 'congestion', rr_above25: 'no', spo2_below90: 'no' })).toBe(false);
    expect(paramsHold(icu, { type: 'congestion', rr_above25: 'yes', spo2_below90: 'no' })).toBe(true);
    expect(paramsHold(icu, { type: 'cold', rr_above25: 'no', spo2_below90: 'no' })).toBe(true);
    for (const p of xs) {
      const q = paramsOf(p);
      const want = q.type !== 'congestion' || q.rr_above25 === 'yes' || q.spo2_below90 === 'yes' ? 'yes' : 'no';
      expect({ seed: p.seed, icu: q.icu }).toEqual({ seed: p.seed, icu: want });
    }
  });

  test('вывод: «хоть один» — дополнение произведения «не»; измерили — по числу', () => {
    const c = db.conditions[HF];
    const share = (name: string, v: string) => c.params![name][v] / Object.values(c.params![name]).reduce((a, b) => a + b, 0);
    const yes = (obs: Observation[]) => paramBeliefs(db, HF, 'icu', obs, 75).find(b => b.value === 'yes')!.p;
    const warm = 1 - share('type', 'edema') - share('type', 'cold');
    expect(yes([])).toBeCloseTo(1 - warm * share('rr_above25', 'no') * share('spo2_below90', 'no'), 6);
    // дыхание 30 в минуту — ПИТ наверняка
    expect(yes([{ f: 'vital.tachypnea', shown: true, exam: 'exam.vitals', value: 30 }])).toBeCloseTo(1, 6);
    // холодная кожа на осмотре с пульсом (95/98) — «холодный» почти наверняка: 14 из 100 до осмотра, по Байесу — 89
    const cold = share('type', 'cold');
    const after = (cold * 0.95) / (cold * 0.95 + (1 - cold) * 0.02);
    expect(paramBeliefs(db, HF, 'type', [seen('sign.cold_clammy', 'exam.vitals')], 75).find(b => b.value === 'cold')!.p).toBeCloseTo(after, 6);
    expect(after).toBeGreaterThan(0.85);
  });
});

describe('больные', () => {
  const xs = people(1500);
  const part = (f: (p: Patient) => boolean, ps = xs) => ps.filter(f).length / ps.length;

  test('формы — 44, 42 и 14 из 100 (ALARM-HF: застой 38,6, отёк лёгких 36,7, шок 11,7 — на 100)', () => {
    for (const [t, want] of [['congestion', 0.44], ['edema', 0.42], ['cold', 0.14]] as const) expect(Math.abs(part(p => paramsOf(p).type === t) - want)).toBeLessThan(0.03);
  });

  test('признаки по форме: «холодный» — холодная кожа; отёк лёгких — хрипы внизу почти всегда, над всеми полями обычно и отёк на снимке; NT-proBNP и застой на снимке — у всех', () => {
    for (const p of xs) {
      const t = paramsOf(p).type;
      expect({ seed: p.seed, cold: byHf(p, 'sign.cold_clammy'), edema: byHf(p, 'img.cxr_edema') }).toEqual({ seed: p.seed, cold: t === 'cold', edema: t === 'edema' });
      expect({ seed: p.seed, nt: byHf(p, 'lab.ntprobnp_high'), xray: byHf(p, 'img.cxr_congestion') }).toEqual({ seed: p.seed, nt: true, xray: true });
      if (t !== 'edema') expect(byHf(p, 'sign.crackles_diffuse')).toBe(false);
    }
    const edema = xs.filter(p => paramsOf(p).type === 'edema');
    // «всегда» — 95 из 100
    expect(Math.abs(part(p => byHf(p, 'sign.crackles_bilateral'), edema) - 0.95)).toBeLessThan(0.03);
    expect(Math.abs(part(p => byHf(p, 'sign.crackles_diffuse'), edema) - 0.75)).toBeLessThan(0.06);
    // одышка — 89 из 100 (156_2, раздел 1.6); отёки обеих ног — около половины (53 %)
    expect(part(p => byHf(p, 'sym.dyspnea'))).toBeGreaterThan(0.85);
    expect(Math.abs(part(p => byHf(p, 'sign.leg_edema_bilateral')) - 0.5)).toBeLessThan(0.05);
  });

  test('приходят и сами', () => {
    let walk = 0;
    for (let seed = 1; seed <= 20_000 && walk === 0; seed++) {
      const p = generatePatient(db, seed, { department: 'dept.therapy', departments: ['dept.therapy'], season: 'winter', walkIn: true });
      if (p.truth.conditions[0].id === HF) walk++;
    }
    expect(walk).toBeGreaterThan(0);
  });
});

describe('обследования и карта', () => {
  test('строки: NT-proBNP, застой и отёк на снимке, хрипы', () => {
    const line = (o: Observation) => observationText(db, o, 'm', 1);
    expect(line(seen('lab.ntprobnp_high', 'exam.nt_probnp'))).toBe('NT-proBNP выше порога для возраста — острая сердечная недостаточность вероятна');
    expect(line(seen('img.cxr_edema', 'exam.xray_chest'))).toBe('Отёк лёгких: вокруг корней с обеих сторон — затемнение «крыльями бабочки»');
    expect(line(seen('img.cxr_congestion', 'exam.xray_chest', false))).toBe('Признаков застоя в лёгких нет');
    expect(line(seen('sign.crackles_diffuse', 'exam.lung_auscultation'))).toBe('Над всеми полями обоих лёгких — влажные хрипы, до верхушек');
  });

  test('карта: снимок груди с застоем, отёком лёгких и большой тенью сердца — по показанному', () => {
    const image = (p: Patient) => {
      const arrived = [{ exam: 'exam.xray_chest', step: 1, at: 600, obs: runExam(db, p, 'exam.xray_chest', Rng.seeded(5).fork('xr'), undefined, true) }];
      return makeCaseView({
        version: 0, patient: p, clock: 700, minutesSpent: 0, money: 0, step: 1, pending: [], meanwhile: [], done: [],
        draft: { treatments: [], setting: 'home' }, arrived, departments: ED, difficulty: 'doctor',
      }).groups.find(g => g.exam === 'exam.xray_chest')!.image;
    };
    const edema = people(1, { type: 'edema' })[0];
    expect(image(edema)).toMatchObject({ kind: 'xray', congestion: 'edema' });
    expect(image(people(1, { type: 'congestion' })[0])).toMatchObject({ kind: 'xray', congestion: 'congestion' });
    const flu = generatePatient(db, 3, { department: 'dept.therapy', departments: ED, season: 'winter', primary: 'cond.influenza' });
    const plain = image(flu) as { congestion?: string; cardiomegaly?: boolean };
    expect(plain.congestion).toBeUndefined();
  });
});

describe('тактика и разбор', () => {
  const xs = people(800);
  const pick = (f: (q: Record<string, string>) => boolean) => xs.find(p => f(paramsOf(p)))!;
  const warm = pick(q => q.type === 'congestion' && q.rr_above25 === 'no' && q.spo2_below90 === 'no');
  const breathless = pick(q => q.type === 'congestion' && q.rr_above25 === 'yes' && q.spo2_below90 === 'no');
  const edema = pick(q => q.type === 'edema' && q.spo2_below90 === 'no');
  const cold = pick(q => q.type === 'cold' && q.spo2_below90 === 'no');
  const hypox = pick(q => q.type === 'congestion' && q.spo2_below90 === 'yes');
  const ev = (p: Patient, x: Plan) => evaluatePlan(db, p, x, truthful(p, ALL), BAY);
  const harmful = (e: ReturnType<typeof ev>) => e.roles.filter(r => r.role === 'harmful').map(r => r.tx);

  test('застой: фуросемид в вену обязателен, НМГ — профилактика тромбоэмболий, палата; капельница — вредно', () => {
    expect(ev(warm, plan([])).requireMissing).toContain(FUROSEMIDE);
    const e = ev(warm, plan([FUROSEMIDE, 'tx.lmwh'], 'admit'));
    expect({ missing: e.requireMissing, harmful: harmful(e), setting: e.setting.recommended }).toEqual({ missing: [], harmful: [], setting: 'ward' });
    expect([txRole(db, HF, NITRO, paramsOf(warm)), txRole(db, HF, 'tx.lmwh', paramsOf(warm)), txRole(db, HF, 'tx.iv_fluids', paramsOf(warm))]).toEqual(['acceptable', 'supportive', 'harmful']);
  });

  test('тёплый с частотой дыхания выше 25 — маска CPAP обязательна и ПИТ; при сатурации ниже 90 — ещё и кислород', () => {
    const e = ev(breathless, plan([FUROSEMIDE], 'icu'));
    expect({ missing: e.requireMissing, setting: e.setting.recommended }).toEqual({ missing: [CPAP], setting: 'icu' });
    expect(ev(hypox, plan([FUROSEMIDE, CPAP], 'icu')).requireMissing).toEqual(['tx.oxygen_mask']);
  });

  test('отёк лёгких: фуросемид и CPAP обязательны, нитроглицерин — первая линия, морфин — можно; ПИТ', () => {
    const e = ev(edema, plan([FUROSEMIDE, NITRO, CPAP, 'tx.lmwh'], 'icu'));
    expect({ missing: e.requireMissing, harmful: harmful(e), setting: e.setting.recommended }).toEqual({ missing: [], harmful: [], setting: 'icu' });
    expect([txRole(db, HF, NITRO, paramsOf(edema)), txRole(db, HF, 'tx.morphine_iv', paramsOf(edema)), txRole(db, HF, 'tx.morphine_iv', paramsOf(warm))]).toEqual(['firstLine', 'acceptable', 'notIndicated']);
  });

  test('«холодный»: допамин обязателен; фуросемид, нитроглицерин, CPAP и морфин — вредно; ПИТ', () => {
    for (const tx of [FUROSEMIDE, NITRO, CPAP, 'tx.morphine_iv']) expect(txRole(db, HF, tx, paramsOf(cold))).toBe('harmful');
    expect(ev(cold, plan(['tx.lmwh'], 'icu')).requireMissing).toEqual([DOPAMINE]);
    const e = ev(cold, plan([DOPAMINE, 'tx.lmwh'], 'icu'));
    expect({ missing: e.requireMissing, harmful: harmful(e), setting: e.setting.recommended }).toEqual({ missing: [], harmful: [], setting: 'icu' });
  });

  test('всем: НПВП и верапамил — вредно; антибиотики и тромболизис — не нужны', () => {
    for (const tx of ['tx.ibuprofen', 'tx.verapamil', 'tx.verapamil_iv']) expect(txRole(db, HF, tx, paramsOf(warm))).toBe('harmful');
    for (const tx of ['tx.amoxicillin', 'tx.thrombolysis', 'tx.thrombolysis_pe']) expect(txRole(db, HF, tx, paramsOf(warm))).toBe('notIndicated');
  });

  test('действие: фуросемид вылечивает тёплого обычно, нитроглицерин при отёке лёгких — часто, допамин «холодного» — часто; без лечения «холодному» хуже почти всегда', () => {
    const p = (x: Patient, txs: Id[]) => curesOf(db, { id: HF, params: paramsOf(x) }, txs).map(e => e.p);
    expect(p(warm, [FUROSEMIDE])).toEqual([7500]);
    expect(p(edema, [FUROSEMIDE, NITRO])).toEqual([7500, 5000]);
    expect(p(cold, [FUROSEMIDE])).toEqual([]);
    expect(p(cold, [DOPAMINE])).toEqual([5000]);
    expect(untreatedOf(db, { id: HF, params: paramsOf(cold) })).toMatchObject({ p: 9500, days: [0, 1] });
    expect(untreatedOf(db, { id: HF, params: paramsOf(warm) })).toMatchObject({ p: 5000, days: [1, 5] });
  });
});

describe('энциклопедия', () => {
  test('где лечить — в стационаре, ПИТ по признакам; лечение по формам', () => {
    const x = article(db, HF)!;
    const where = x.blocks.find(b => b.key === 'where')!.text!;
    expect(where[0]).toBe('Обычно — в стационаре.');
    expect(where).toContain('При отёке лёгких, гипоперфузии, частоте дыхания выше 25 или сатурации ниже 90 % — палата интенсивной терапии.');
    const rows = Object.fromEntries(x.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(y => y.id)]));
    expect(rows['Обязательно, при гипоперфузии — холодной влажной коже']).toEqual([DOPAMINE]);
    expect(rows['Опасно, при гипоперфузии — холодной влажной коже']).toEqual(expect.arrayContaining([FUROSEMIDE, NITRO, CPAP]));
    expect(rows['Обязательно, при отёке лёгких']).toEqual([CPAP]);
  });
});

describe('разумный врач', () => {
  const exams = Object.keys(db.exams).sort();
  function run(p: Patient, venue: Venue, departments: Id[]) {
    const cands = candidatesOf(db, departments);
    const obs: Observation[] = complaintObservations(p);
    const done: Id[] = [];
    let phase: DoctorPhase = {};
    const rng = Rng.seeded(p.seed).fork('doctor');
    for (let k = 0; k < 40; k++) {
      const minutes = done.reduce((acc, id) => acc + examMinutes(db.exams[id]), 0);
      const r = nextStep(db, p, obs, done, phase, { candidates: cands, exams, threshold: 0.9, minGain: 0.02, venue: { ...venue, minutes } });
      phase = r.phase;
      if (r.step.kind === 'decide') return { done, plan: r.step.plan, diagnosis: r.step.diagnosis, obs };
      obs.push(...runExam(db, p, r.step.exam, rng.fork(`${k}`)));
      done.push(r.step.exam);
    }
    throw new Error('врач не решил');
  }

  test('у постели в приёмном: NT-proBNP и снимок груди; тёплому — фуросемид, вредного нет', () => {
    const xs = people(60, { type: 'congestion' }, 8_300_001);
    let right = 0;
    let tested = 0;
    for (const p of xs) {
      const r = run(p, BAY, ED);
      if (r.done.includes('exam.nt_probnp') && r.done.includes('exam.xray_chest')) tested++;
      if (r.diagnosis !== HF) continue;
      right++;
      const e = evaluatePlan(db, p, r.plan, r.obs, BAY);
      expect({ seed: p.seed, harmful: e.roles.filter(x => x.role === 'harmful').map(x => x.tx) }).toEqual({ seed: p.seed, harmful: [] });
      expect(r.plan.treatments).toContain(FUROSEMIDE);
    }
    expect(right / xs.length).toBeGreaterThan(0.9);
    expect(tested / xs.length).toBeGreaterThan(0.75);
  }, 60_000);
});
