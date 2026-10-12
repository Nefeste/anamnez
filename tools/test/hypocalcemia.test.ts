// Острая гипокальциемия после операции на щитовидной железе (spec 2026-10-chapter-4, часть 56в; 627_3): в первые сутки-двое
// онемение вокруг рта и в пальцах, потом судорогой сводит кисти, бывает ларингоспазм. Симптомы Труссо и Хвостека, кальций с
// поправкой на альбумин — каждому с такими жалобами. Кальция глюконат в вену — после анализа, и сразу кальций внутрь с
// альфакальцидолом или кальцитриолом; кальция хлорид — вредно. Палата; при тетании ПИТ — не ошибка.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { typicalPatient } from '../../src/engine/med/generate';
import { alsoSettings, curesOf, evaluatePlan, recommendedSetting, txRole, type Venue } from '../../src/engine/med/plan';
import { type DoctorPhase, examMinutes, MIN_GAIN, nextStep } from '../../src/engine/med/policy';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { article } from '../../src/state/encyclopedia';

// разумный врач по сотне больных — дольше 5 секунд
setDefaultTimeout(60_000);

const HC = 'cond.hypocalcemia_acute';
const CA = 'lab.ca_low';
const CALCIUM = 'exam.calcium';
const SIGNS = 'exam.tetany_signs';
const GLUC = 'tx.calcium_gluconate_iv';
const CHLOR = 'tx.calcium_chloride_iv';
const ORAL = 'tx.calcium_oral';
const VITD = 'tx.active_vitamin_d';
const PTH = 'tx.pth_sample';
const PAR = 'sym.perioral_paresthesia';
const SPASM = 'sym.hand_spasm';
const POLY = ['dept.therapy'];
const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.infectious'];

const patients = (n: number, from: number, departments: Id[], params: Record<string, string> = {}) =>
  Array.from({ length: n }, (_, i) => typicalPatient(db, k => (from + i) * 31 + k, { department: 'dept.therapy', departments, season: 'autumn', primary: HC, params }));
const has = (p: Patient, f: string) => p.truth.findings.some(x => x.f === f && x.cause === HC);
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / xs.length;
const param = (p: Patient, k: string) => p.truth.conditions.find(c => c.role === 'primary')!.params[k];

describe('острая гипокальциемия', () => {
  const ps = patients(300, 56_700, ED);

  test('запись по 627_3: терапия, E89.2, подтверждает кальций крови; явная тетания — параметр', () => {
    expect(db.conditions[HC]).toMatchObject({ icd10: 'E89.2', department: 'dept.therapy', severity: 'serious', confirm: [CALCIUM], params: { tetany: { yes: 70, no: 30 } } });
    expect(db.conditions[HC].differential).toEqual(['cond.thyroid_storm', 'cond.hypoglycemia', 'cond.seizure']);
    expect(db.conditions[HC].redFlags).toEqual(['sign.stridor']);
  });

  test('у каждого — операция на щитовидной железе, рубец, низкий кальций и скрытая тетания; кисти сводит — только при явной', () => {
    for (const p of ps) {
      for (const f of ['hx.thyroidectomy', 'sign.neck_scar', CA, 'sign.trousseau', 'sign.chvostek']) expect(has(p, f)).toBe(true);
      expect(has(p, SPASM)).toBe(param(p, 'tetany') === 'yes');
      // без явной тетании жалоба — покалывание вокруг рта
      if (param(p, 'tetany') === 'no') expect(p.complaints).toContain(PAR);
      expect(p.complaints.some(f => f === PAR || f === SPASM)).toBe(true);
    }
    // ларингоспазм — редко и только при явной тетании
    expect(ps.filter(p => param(p, 'tetany') === 'no').some(p => has(p, 'sign.stridor'))).toBe(false);
    expect(share(ps, p => has(p, 'sign.stridor'))).toBeLessThan(0.15);
    expect(share(ps, p => has(p, PAR))).toBeGreaterThan(0.9);
  });

  test('кальций и пробы Труссо и Хвостека — каждому с покалыванием или судорогами кистей; точность проб — по 627_3', () => {
    expect(db.exams[SIGNS].routineFor).toEqual([PAR, SPASM]);
    // с частью 57в — и кальций каждому, кто пил антифриз (873_1, раздел 3.2)
    expect(db.exams[CALCIUM].routineFor).toEqual([PAR, SPASM, 'sym.antifreeze_drink']);
    expect(db.exams[CALCIUM]).toMatchObject({ kind: 'lab', room: 'room.lab', equipment: ['eq.biochem_analyzer'] });
    expect(db.exams[CALCIUM].checks.map(c => c.f)).toEqual([CA]);
    expect(db.exams[SIGNS].checks.map(c => [c.f, c.sens, c.spec])).toEqual([['sign.trousseau', 9400, 9900], ['sign.chvostek', 7000, 9000]]);
    expect(examMinutes(db.exams[CALCIUM])).toBe(65);
    // о жалобах и операции — в расспросах, рубец — на осмотре, QT — на ЭКГ
    expect(db.exams['exam.ask_general'].checks.map(c => c.f)).toEqual(expect.arrayContaining([PAR, SPASM]));
    expect(db.exams['exam.ask_chronic'].checks.map(c => c.f)).toContain('hx.thyroidectomy');
    expect(db.exams['exam.general_exam'].checks.find(c => c.f === 'sign.neck_scar')).toMatchObject({ spec: 10000 });
    expect(db.exams['exam.ecg'].checks.map(c => c.f)).toContain('ecg.qt_long');
    expect(db.findings[CA].value).toMatchObject({ unit: 'ммоль/л', ref: [2.12, 2.62] });
  });

  test('тактика: кальция глюконат — первая линия, после анализа; кальций внутрь и альфакальцидол — обязательно; кальция хлорид — опасно', () => {
    const t = db.conditions[HC].treatment!;
    expect([t.firstLine, t.acceptable, t.supportive, t.notIndicated, t.harmful, t.require]).toEqual([[GLUC], [PTH], [], [], [CHLOR], [ORAL, VITD]]);
    expect(db.treatments[GLUC].confirmFirst).toBe(true);
    expect(curesOf(db, { id: HC, params: {} }, [GLUC]).map(e => e.p)).toEqual([7500]);
    expect(curesOf(db, { id: HC, params: {} }, [CHLOR])).toEqual([]);
    expect(txRole(db, HC, CHLOR, {})).toBe('harmful');
    expect(txRole(db, HC, VITD, {})).toBe('require');
    const p = ps[0];
    const obs = complaintObservations(p);
    const venue: Venue = { ward: true, icu: true };
    // недостающее — по алфавиту идентификаторов
    expect(evaluatePlan(db, p, { treatments: [GLUC], setting: 'admit' }, obs, venue).requireMissing).toEqual([VITD, ORAL]);
    const ok = evaluatePlan(db, p, { treatments: [GLUC, ORAL, VITD], setting: 'admit' }, obs, venue);
    expect([ok.requireMissing, ok.effective]).toEqual([[], true]);
  });

  test('место — палата; при явной тетании ПИТ — не ошибка', () => {
    for (const p of ps.slice(0, 30)) {
      expect(recommendedSetting(db, p)).toBe('ward');
      expect(alsoSettings(db, p)).toEqual(param(p, 'tetany') === 'yes' ? ['icu'] : []);
    }
  });
});

/** Разумный врач по шагам: в приёмном — с палатой и ПИТ, в поликлинике — без них. */
function doctor(p: Patient, departments: Id[], venue: Venue) {
  const obs: Observation[] = complaintObservations(p);
  const done: Id[] = [];
  const rng = Rng.seeded(p.seed).fork('doctor');
  const candidates = candidatesOf(db, departments);
  const exams = Object.keys(db.exams).sort();
  let phase: DoctorPhase = {};
  for (;;) {
    const minutes = done.reduce((a, id) => a + examMinutes(db.exams[id]), 0);
    const r = nextStep(db, p, obs, done, phase, { candidates, exams, threshold: 0.9, minGain: MIN_GAIN, venue: { ...venue, minutes } });
    phase = r.phase;
    if (r.step.kind === 'decide') return { ...r.step, done, minutes };
    obs.push(...runExam(db, p, r.step.exam, rng.fork(`exam:${done.length}:${r.step.exam}`)));
    done.push(r.step.exam);
  }
}

describe('разумный врач', () => {
  test('в приёмном: верно — почти у каждого; кальций и пробы — до решения; кальций в вену, внутрь и альфакальцидол — в палату', () => {
    const rs = patients(60, 56_760, ED).map(p => ({ p, r: doctor(p, ED, { ward: true, icu: true }) }));
    expect(share(rs, x => x.r.diagnosis === HC)).toBeGreaterThan(0.95);
    expect(rs.every(x => x.r.done.includes(CALCIUM) && x.r.done.includes(SIGNS))).toBe(true);
    expect(share(rs, x => [GLUC, ORAL, VITD].every(tx => x.r.plan.treatments.includes(tx)))).toBeGreaterThan(0.95);
    expect(share(rs, x => x.r.plan.setting === 'admit')).toBeGreaterThan(0.95);
    // ответ кальция — через час: решение — меньше чем за полтора
    expect(share(rs, x => x.r.minutes <= 90)).toBeGreaterThan(0.9);
  });

  test('в поликлинике — то же лечение и в стационар', () => {
    const rs = patients(30, 56_830, POLY).map(p => ({ p, r: doctor(p, POLY, {}) }));
    expect(share(rs, x => x.r.diagnosis === HC)).toBeGreaterThan(0.95);
    expect(share(rs, x => x.r.plan.setting === 'ward')).toBeGreaterThan(0.95);
  });
});

describe('энциклопедия', () => {
  test('тактика строками; новые записи — статьями', () => {
    const rows = Object.fromEntries(article(db, HC)!.blocks.find(b => b.key === 'treatment')!.rows!.map(r => [r.label, r.refs.map(x => x.id)]));
    expect(rows).toMatchObject({ 'Первая линия': [GLUC], 'Можно также': [PTH], 'Опасно': [CHLOR], 'Обязательно': [ORAL, VITD] });
    for (const id of [HC, CA, CALCIUM, SIGNS, GLUC, CHLOR, ORAL, VITD, PTH, PAR, SPASM, 'hx.thyroidectomy', 'sign.trousseau', 'sign.chvostek', 'sign.neck_scar', 'ecg.qt_long']) {
      expect(article(db, id)).toBeDefined();
    }
  });
});
