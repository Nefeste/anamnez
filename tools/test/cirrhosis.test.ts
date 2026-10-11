// Цирроз и его осложнения (spec 2026-10-chapter-4, часть 54а; 715_2). Цирроз — фон: с ним не приходят, но без него не
// бывает кровотечения из варикозных вен пищевода. Кровотечение — в одной группе с язвенным и разрывом Мэллори–Вейсса:
// источник различает ЭГДС; вазоактивный препарат и антибиотик — сразу, до эндоскопии и до перевода, вены лигируют.
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

/** Больной, у которого болезнь обычна, — в своём возрасте и с тем, без чего она не бывает. */
const patient = (primary: Id, seed: number, params: Record<string, string> = {}): Patient =>
  typicalPatient(db, k => seed * 31 + k, { department: 'dept.surgery', departments: ED, season: 'autumn', primary, params });
const people = (primary: Id, n: number, from: number, params: Record<string, string> = {}) => Array.from({ length: n }, (_, i) => patient(primary, from + i, params));
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
    // декомпенсация: асцит — часто
    near(share(ps, p => has(p, 'sign.ascites')), 0.5, 0.1);
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
});

describe('энциклопедия', () => {
  test('кровотечение из вен: обязательное и до перевода — словами; цирроз и его признаки — статьи', () => {
    const rows = Object.fromEntries(article(db, VB)!.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(x => x.id)]));
    expect(rows).toMatchObject({ 'Обязательно': [VASO, ABX, LIG], 'Обязательно до перевода': [VASO, ABX] });
    for (const id of [CIRR, VASO, LIG, 'tx.lactulose', 'img.egd_varices', 'img.us_cirrhosis', 'sign.spider_angiomas', 'sign.ascites', 'hx.cirrhosis']) expect(article(db, id)).toBeDefined();
  });
});
