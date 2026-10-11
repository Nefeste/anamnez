// Цирроз и его осложнения (spec 2026-10-chapter-4, часть 54а; 715_2). Цирроз — фон: с ним не приходят, но без него не
// бывает кровотечения из варикозных вен пищевода, асцита и спонтанного бактериального перитонита. Кровотечение — в одной
// группе с язвенным и разрывом Мэллори–Вейсса: источник различает ЭГДС; вазоактивный препарат и антибиотик — сразу, до
// эндоскопии и до перевода, вены лигируют. Асцит и перитонит различает диагностический парацентез: нейтрофилов в
// асцитической жидкости больше 250 — антибиотик и альбумин; без инфекции — спиронолактон и диета, при напряжённом асците —
// лечебный парацентез с альбумином.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient, typicalPatient } from '../../src/engine/med/generate';
import { evaluatePlan, recommendedSetting, txRole, type Venue } from '../../src/engine/med/plan';
import { type DoctorPhase, examMinutes, MIN_GAIN, nextStep } from '../../src/engine/med/policy';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { article } from '../../src/state/encyclopedia';

// разумный врач по сотне больных — дольше 5 секунд
setDefaultTimeout(60_000);

const CIRR = 'cond.cirrhosis';
const VB = 'cond.variceal_bleeding';
const UB = 'cond.ulcer_bleeding';
const MW = 'cond.mallory_weiss';
const VASO = 'tx.vasoactive_portal';
const ABX = 'tx.antibiotic_iv';
const LIG = 'tx.variceal_ligation';
const ROOM = 'room.endoscopy';
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma'];
const ASC = 'cond.cirrhosis_ascites';
const SBP = 'cond.sbp';
const PARA = 'exam.paracentesis';
const SPIRO = 'tx.spironolactone';
const ALB = 'tx.albumin';
const LVP = 'tx.paracentesis_large';
const DIET = 'tx.low_salt_diet';
const PMN = 'lab.ascites_pmn_250';
const FLUID = 'lab.ascitic_fluid';

/** Больной, у которого болезнь обычна, — в своём возрасте и с тем, без чего она не бывает. */
const patient = (primary: Id, seed: number, params: Record<string, string> = {}): Patient =>
  typicalPatient(db, k => seed * 31 + k, { department: 'dept.surgery', departments: ED, season: 'autumn', primary, params });
const people = (primary: Id, n: number, from: number, params: Record<string, string> = {}) => Array.from({ length: n }, (_, i) => patient(primary, from + i, params));
/** То же — в терапии: асцит и перитонит лечат терапевты. */
const therapy = (primary: Id, n: number, from: number, params: Record<string, string> = {}) =>
  Array.from({ length: n }, (_, i) => typicalPatient(db, k => (from + i) * 31 + k, { department: 'dept.therapy', departments: ED, season: 'autumn', primary, params }));
const has = (p: Patient, f: string) => p.truth.findings.some(x => x.f === f);
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;
const near = (x: number, want: number, tol: number) => {
  expect(x).toBeGreaterThan(want - tol);
  expect(x).toBeLessThan(want + tol);
};
const params = (p: Patient) => p.truth.conditions.find(c => c.role === 'primary')!.params;

describe('цирроз — фон осложнений', () => {
  test('запись по 715_2: с циррозом не приходят; у одного из ста, у пьющих вчетверо чаще; подтверждает УЗИ', () => {
    expect(db.conditions[CIRR]).toMatchObject({ icd10: 'K74.6', presenting: false, confirm: ['exam.us_abdomen'] });
    expect(db.conditions[CIRR].chronic).toMatchObject({ p: 100, risks: [{ id: 'risk.alcohol', x: 4 }] });
    expect(db.conditions[CIRR].sources.map(s => s.url)).toEqual(['https://cr.minzdrav.gov.ru/view-cr/715_2']);
    const ps = Array.from({ length: 20000 }, (_, i) => generatePatient(db, 300_000 + i, { department: 'dept.therapy', season: 'autumn', walkIn: true }));
    const sick = ps.filter(p => p.truth.conditions.some(c => c.id === CIRR));
    near(sick.length / ps.length, 0.0105, 0.003);
    // алкоголь — у трети больных (715_2, раздел 1.3: у декомпенсированных 23–33 %)
    near(share(sick, p => p.truth.risks.includes('risk.alcohol')), 0.33, 0.1);
    // у больного циррозом — его признаки: УЗИ видит перестройку печени у каждого, варикозные вены — у трети с небольшим
    for (const p of sick) expect(has(p, 'img.us_cirrhosis')).toBe(true);
    near(share(sick, p => has(p, 'img.egd_varices')), 0.35, 0.1);
    near(share(sick, p => has(p, 'lab.platelets_low')), 0.75, 0.12);
  });
});

describe('кровотечение из варикозных вен', () => {
  const ps = people(VB, 300, 54_100);

  test('запись: хирургия, одна группа с язвенным кровотечением и разрывом; без цирроза не бывает', () => {
    expect(db.conditions[VB]).toMatchObject({ icd10: 'I85.0', department: 'dept.surgery', group: 'grp.ugi_bleeding', requires: [CIRR], params: { shock: { yes: 35, no: 65 } } });
    for (const id of [UB, MW]) expect(db.conditions[id].group).toBe('grp.ugi_bleeding');
    for (const p of ps) expect(p.truth.conditions.some(c => c.id === CIRR)).toBe(true);
  });

  test('рвота кровью, вены на ЭГДС — у каждого; шок — у трети, давление ниже 90 — ровно при нём', () => {
    expect(share(ps, p => has(p, 'sym.hematemesis'))).toBeGreaterThan(0.9);
    for (const p of ps) {
      expect(has(p, 'img.egd_varices')).toBe(true);
      expect(has(p, 'vital.bp_low')).toBe(params(p).shock === 'yes');
    }
    near(share(ps, p => params(p).shock === 'yes'), 0.35, 0.07);
    // декомпенсация — у половины: асцит на осмотре, а с ним — и на УЗИ, и в пункции
    near(share(ps, p => params(p).decomp === 'yes'), 0.5, 0.1);
    for (const p of ps) {
      if (params(p).decomp === 'yes') expect(has(p, 'sign.ascites')).toBe(true);
      if (has(p, 'sign.ascites')) for (const f of ['img.us_ascites', FLUID]) expect(has(p, f)).toBe(true);
    }
  });

  test('тактика по 715_2: терлипрессин или октреотид, антибиотик и лигирование обязательны, первые два — и до перевода', () => {
    const t = db.conditions[VB].treatment!;
    expect(t.require).toEqual([VASO, ABX, LIG]);
    expect(t.beforeTransfer).toEqual([VASO, ABX]);
    for (const shock of ['yes', 'no']) for (const tx of [VASO, ABX, LIG]) expect(txRole(db, VB, tx, { shock })).toBe('require');
    expect(txRole(db, VB, 'tx.iv_fluids', { shock: 'yes' })).toBe('require');
    expect(txRole(db, VB, 'tx.iv_fluids', { shock: 'no' })).toBe('supportive');
    expect(txRole(db, VB, 'tx.lactulose', { shock: 'no' })).toBe('supportive');
    // транексамовая кислота — «воздерживаться», ИПН — отменить, укол и клипса — для язвы
    for (const tx of ['tx.tranexamic', 'tx.ppi_iv', 'tx.endoscopic_hemostasis']) expect(txRole(db, VB, tx, { shock: 'no' })).toBe('notIndicated');
    for (const tx of ['tx.heparin_iv', 'tx.ibuprofen', 'tx.clopidogrel']) expect(txRole(db, VB, tx, { shock: 'no' })).toBe('harmful');
    // лигирование — в эндоскопическом кабинете; без него вместе с вазоактивным останавливает кровь у девяти из десяти
    expect(db.treatments[LIG]).toMatchObject({ kind: 'procedure', room: ROOM });
    const cure = (tx: Id) => db.treatments[tx].effects.find(e => e.on === VB)!.p;
    expect(1 - (1 - cure(LIG) / 10_000) * (1 - cure(VASO) / 10_000)).toBeGreaterThan(0.85);
    expect(cure(VASO)).toBeLessThan(cure(LIG));
  });

  test('место: всем — интенсивная терапия, реанимация не ошибка; без эндоскопии — перевод', () => {
    for (const shock of ['yes', 'no']) {
      const p = patient(VB, 54_900, { shock });
      expect(recommendedSetting(db, p, [], [], [ROOM])).toBe('icu');
      expect(recommendedSetting(db, p)).toBe('transfer');
    }
  });

  test('разбор: без лигирования или антибиотика лечение неполное', () => {
    const p = ps.find(x => params(x).shock === 'no')!;
    const venue: Venue = { ward: true, icu: true, rooms: [ROOM] };
    const ev = (treatments: Id[]) => evaluatePlan(db, p, { treatments, setting: 'icu' }, [], venue);
    expect(ev([VASO, ABX]).requireMissing).toEqual([LIG]);
    expect(ev([VASO, LIG]).requireMissing).toEqual([ABX]);
    expect(ev([VASO, ABX, LIG]).requireMissing).toEqual([]);
    expect(ev([VASO, ABX, LIG, 'tx.lactulose']).effective).toBe(true);
  });
});

describe('среди кровотечений из верхних отделов ЖКТ', () => {
  test('из вен — примерно каждое пятое: пришедших сами втрое больше, чем привезённых', () => {
    const seasons = ['winter', 'spring', 'summer', 'autumn'] as const;
    const count = (carried: boolean) => {
      const c: Record<string, number> = {};
      for (let i = 0; i < 30_000; i++) {
        const p = generatePatient(db, 700_000 + i, { department: 'dept.therapy', departments: ED, season: seasons[i % 4], walkIn: !carried, ...(carried ? { carried: db.economy.ambulance.weight } : {}) });
        const id = p.truth.conditions.find(x => x.role === 'primary')!.id;
        c[id] = (c[id] ?? 0) + 1;
      }
      return c;
    };
    const walk = count(false), amb = count(true);
    const n = (id: Id) => 3 * (walk[id] ?? 0) + (amb[id] ?? 0);
    near(n(VB) / (n(VB) + n(UB) + n(MW)), 0.19, 0.06);
  });
});

describe('асцит и спонтанный бактериальный перитонит', () => {
  const asc = therapy(ASC, 300, 54_300);
  const sbp = therapy(SBP, 300, 54_600);

  test('записи: терапия, одна группа, без цирроза не бывает; подтверждает диагностический парацентез', () => {
    expect(db.conditions[ASC]).toMatchObject({ icd10: 'R18', department: 'dept.therapy', group: 'grp.cirrhosis_ascites', requires: [CIRR], confirm: [PARA], params: { grade: { moderate: 60, tense: 40 } } });
    expect(db.conditions[SBP]).toMatchObject({ icd10: 'K65.0', department: 'dept.therapy', group: 'grp.cirrhosis_ascites', requires: [CIRR], confirm: [PARA] });
    for (const p of [...asc, ...sbp]) expect(p.truth.conditions.some(c => c.id === CIRR)).toBe(true);
  });

  test('асцит у каждого — на осмотре, на УЗИ и в пункции; нейтрофилов больше 250 — только при перитоните', () => {
    for (const p of [...asc, ...sbp]) for (const f of ['sign.ascites', 'img.us_ascites', FLUID]) expect(has(p, f)).toBe(true);
    for (const p of asc) expect(has(p, PMN)).toBe(false);
    for (const p of sbp) expect(has(p, PMN)).toBe(true);
    // с увеличением живота и приходят; напряжённый — живот натянут, одышка
    for (const p of asc) {
      expect(p.complaints).toContain('sym.abdomen_enlarged');
      expect(has(p, 'sign.ascites_tense')).toBe(params(p).grade === 'tense');
    }
    near(share(asc, p => params(p).grade === 'tense'), 0.4, 0.08);
    near(share(asc.filter(p => params(p).grade === 'tense'), p => has(p, 'sym.dyspnea')), 0.75, 0.12);
    // перитонит: лихорадка — у половины, раздражение брюшины — у немногих; жалоб нет почти у каждого пятого (715_2, раздел 1.6:
    // у 10–33 %)
    near(share(sbp, p => has(p, 'vital.fever')), 0.5, 0.1);
    expect(share(sbp, p => has(p, 'sign.peritoneal_signs'))).toBeLessThan(0.15);
    near(share(sbp, p => !has(p, 'vital.fever') && !has(p, 'sym.abdominal_pain') && !has(p, 'sym.confusion')), 0.19, 0.08);
  });

  test('парацентез: без асцита жидкости нет, и нейтрофилы не считают; при перитоните — больше 250', () => {
    expect(db.exams[PARA]).toMatchObject({ kind: 'lab', collect: 'room.emergency' });
    expect(db.exams[PARA].checks.find(c => c.f === PMN)!.given).toBe(FLUID);
    const dry = runExam(db, patient(UB, 54_950), PARA, Rng.seeded(1), undefined, true);
    expect(dry.map(o => [o.f, o.shown])).toEqual([[FLUID, false]]);
    const wet = runExam(db, sbp[0], PARA, Rng.seeded(1), undefined, true);
    expect(wet.find(o => o.f === PMN)).toMatchObject({ shown: true });
    expect(wet.find(o => o.f === PMN)!.value).toBeGreaterThan(250);
    const clean = runExam(db, asc[0], PARA, Rng.seeded(1), undefined, true);
    expect(clean.find(o => o.f === PMN)).toMatchObject({ shown: false });
    expect(clean.find(o => o.f === PMN)!.value).toBeLessThan(250);
  });

  test('срок: нашли асцит на осмотре или УЗИ — диагностический парацентез в первые 12 часов', () => {
    expect(db.targets['target.paracentesis_ascites']).toMatchObject({ from: 'finding', findings: ['sign.ascites', 'img.us_ascites'], exams: [PARA], minutes: 720 });
  });

  test('тактика по 715_2: асцит — спиронолактон и диета, напряжённый — лечебный парацентез и альбумин; перитонит — антибиотик и альбумин', () => {
    expect(txRole(db, ASC, SPIRO, { grade: 'moderate' })).toBe('firstLine');
    expect(txRole(db, ASC, DIET, { grade: 'moderate' })).toBe('supportive');
    for (const tx of [LVP, ALB]) {
      expect(txRole(db, ASC, tx, { grade: 'tense' })).toBe('require');
      expect(txRole(db, ASC, tx, { grade: 'moderate' })).toBe('notIndicated');
    }
    expect(txRole(db, ASC, ABX, { grade: 'moderate' })).toBe('notIndicated');
    for (const id of [ASC, SBP]) expect(txRole(db, id, 'tx.ibuprofen', { grade: 'moderate' })).toBe('harmful');
    expect(db.conditions[SBP].treatment!.require).toEqual([ABX, ALB]);
    for (const tx of [SPIRO, LVP]) expect(txRole(db, SBP, tx)).toBe('acceptable');
    expect(txRole(db, SBP, 'tx.ppi')).toBe('notIndicated');
    // цефтриаксон эффективен в 77,0 % (715_2, раздел 3.2.5); одна диета убирает асцит у 10 из 100 (раздел 3.2.1)
    expect(db.treatments[ABX].effects.find(e => e.on === SBP)!.p).toBe(7700);
    expect(db.treatments[DIET].effects.find(e => e.on === ASC)!.p).toBe(1000);
    // альбумин — в группе растворов, лечебный парацентез — в пункциях и дренажах
    expect(db.treatments[ALB].class).toBe('plasma.albumin');
    expect(db.treatments[LVP]).toMatchObject({ kind: 'procedure', class: 'drainage.ascites' });
    for (const p of [asc[0], sbp[0]]) expect(recommendedSetting(db, p)).toBe('ward');
  });

  test('разбор: при напряжённом асците без альбумина и при перитоните без него лечение неполное', () => {
    const tense = asc.find(p => params(p).grade === 'tense')!;
    const venue: Venue = { ward: true, icu: true };
    const ev = (p: Patient, treatments: Id[]) => evaluatePlan(db, p, { treatments, setting: 'admit' }, [], venue);
    expect(ev(tense, [SPIRO, DIET, LVP]).requireMissing).toEqual([ALB]);
    expect(ev(tense, [SPIRO, DIET, LVP, ALB]).requireMissing).toEqual([]);
    expect(ev(sbp[0], [ABX]).requireMissing).toEqual([ALB]);
    expect(ev(sbp[0], [ABX, ALB]).requireMissing).toEqual([]);
  });

  test('доли: перитонит — каждый одиннадцатый из пришедших с асцитом сами и каждый четвёртый из привезённых скорой', () => {
    const w = (id: Id) => db.conditions[id].weight;
    const k = db.economy.ambulance.weight;
    const amb = (id: Id) => w(id) * k[db.conditions[id].severity];
    near(w(SBP) / (w(SBP) + w(ASC)), 0.09, 0.02);
    near(amb(SBP) / (amb(SBP) + amb(ASC)), 0.23, 0.03);
  });
});

/** Разумный врач по шагам — с местом больницы и тем, что в ней можно сделать. */
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
  const noEgd = all.filter(e => e !== 'exam.egd');
  const HOSPITAL: Venue = { ward: true, icu: true, or: true, rooms: [ROOM] };
  const PLAIN: Venue = { ward: true, icu: true, or: true };

  test('с эндоскопией: по ЭГДС — вены, вазоактивный препарат, антибиотик и лигирование, ПИТ; язвенное кровотечение не лигирует', () => {
    const rs = people(VB, 100, 5400).map(p => doctor(p, all, HOSPITAL));
    expect(share(rs, r => r.diagnosis === VB)).toBeGreaterThan(0.9);
    expect(share(rs, r => [VASO, ABX, LIG].every(t => r.plan.treatments.includes(t)))).toBeGreaterThan(0.9);
    expect(share(rs, r => r.plan.setting === 'icu')).toBeGreaterThan(0.9);
    const ub = people(UB, 100, 5400).map(p => doctor(p, all, HOSPITAL));
    expect(share(ub, r => r.diagnosis === UB)).toBeGreaterThan(0.9);
    expect(share(ub, r => r.plan.treatments.includes(LIG))).toBeLessThan(0.05);
  });

  test('без эндоскопии — перевод, а до него вазоактивный препарат и антибиотик', () => {
    const rs = people(VB, 100, 5400).map(p => doctor(p, noEgd, PLAIN));
    expect(share(rs, r => r.plan.setting !== 'icu' && r.plan.setting !== 'ward' && r.plan.setting !== 'home')).toBeGreaterThan(0.9);
    expect(share(rs, r => r.plan.treatments.includes(VASO) && r.plan.treatments.includes(ABX))).toBeGreaterThan(0.8);
  });

  test('асцит: УЗИ и парацентез каждому, спиронолактон в палате; напряжённый — лечебный парацентез с альбумином', () => {
    const ps = therapy(ASC, 60, 5500);
    const rs = ps.map(p => doctor(p, all, HOSPITAL));
    expect(share(rs, r => r.diagnosis === ASC)).toBeGreaterThan(0.9);
    expect(share(rs, r => r.done.includes('exam.us_abdomen') && r.done.includes(PARA))).toBeGreaterThan(0.9);
    expect(share(rs, r => r.plan.treatments.includes(SPIRO) && r.plan.setting === 'admit')).toBeGreaterThan(0.9);
    const tense = rs.filter((_, i) => params(ps[i]).grade === 'tense');
    expect(share(tense, r => r.plan.treatments.includes(LVP) && r.plan.treatments.includes(ALB))).toBeGreaterThan(0.85);
    expect(share(rs, r => r.plan.treatments.includes(ABX))).toBeLessThan(0.05);
  });

  test('перитонит: по парацентезу — антибиотик и альбумин; без парацентеза его чаще принимают за асцит', () => {
    const ps = therapy(SBP, 60, 5600);
    const rs = ps.map(p => doctor(p, all, HOSPITAL));
    expect(share(rs, r => r.diagnosis === SBP)).toBeGreaterThan(0.9);
    expect(share(rs, r => r.done.includes(PARA))).toBeGreaterThan(0.8);
    expect(share(rs, r => r.plan.treatments.includes(ABX) && r.plan.treatments.includes(ALB))).toBeGreaterThan(0.9);
    const blind = ps.map(p => doctor(p, all.filter(e => e !== PARA), HOSPITAL));
    expect(share(blind, r => r.diagnosis === SBP)).toBeLessThan(share(rs, r => r.diagnosis === SBP));
  });
});

describe('энциклопедия', () => {
  test('кровотечение из вен: обязательное и до перевода — словами; цирроз и его признаки — статьи', () => {
    const rows = Object.fromEntries(article(db, VB)!.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(x => x.id)]));
    expect(rows).toMatchObject({ 'Обязательно': [VASO, ABX, LIG], 'Обязательно до перевода': [VASO, ABX] });
    for (const id of [CIRR, VASO, LIG, 'tx.lactulose', 'img.egd_varices', 'img.us_cirrhosis', 'sign.spider_angiomas', 'sign.ascites', 'hx.cirrhosis']) expect(article(db, id)).toBeDefined();
  });

  test('асцит и перитонит: обязательное — словами и при напряжённом асците; новое — статьи', () => {
    const rows = (id: Id) => Object.fromEntries(article(db, id)!.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(x => x.id)]));
    expect(rows(ASC)).toMatchObject({ 'Первая линия': [SPIRO], 'Обязательно, при напряжённом асците': [LVP, ALB] });
    expect(rows(SBP)).toMatchObject({ 'Обязательно': [ABX, ALB] });
    for (const id of [ASC, SBP, PARA, SPIRO, ALB, LVP, DIET, PMN, FLUID, 'sign.ascites_tense', 'sym.abdomen_enlarged']) expect(article(db, id)).toBeDefined();
  });
});
