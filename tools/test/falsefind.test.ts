// Ложные находки по жалобам (вопрос 33, 0.5.5): осмотр, снимок и ЭКГ ошибаются с частотой из рекомендации у того, кому
// они показаны по жалобам, у остальных — в пять раз реже; так же считает вывод разумного врача, а разбор называет частоту.
import { describe, expect, test } from 'bun:test';
import { NO_ECONOMY } from '../content/load';
import { db } from '../../src/content';
import type { Condition, ContentDb, Exam, Finding } from '../../src/content/types';
import { P_ONE, Rng } from '../../src/engine/core/rng';
import { expectedFindings, falseRate, runExam, UNEXPECTED_FALSE } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { contextOf, entropy, expectedGain, posterior } from '../../src/engine/med/infer';
import type { Observation, Patient } from '../../src/engine/med/types';
import { falseFindings } from '../../src/state/caseView';

const MURPHY = 'sign.murphy';
const LEVELS = 'img.xr_bowel_levels';
const SEASONS = ['winter', 'spring', 'summer', 'autumn'] as const;

describe('какие находки ждут по жалобам', () => {
  test('симптом Мерфи — при боли в правом подреберье, а не при кашле и насморке; «уровни» на снимке — не при мигрени', () => {
    expect(expectedFindings(db, ['sym.ruq_pain', 'sym.nausea']).has(MURPHY)).toBe(true);
    expect(expectedFindings(db, ['sym.cough', 'sym.sore_throat', 'sym.rhinorrhea']).has(MURPHY)).toBe(false);
    expect(expectedFindings(db, ['sym.cough', 'sym.sore_throat', 'sym.rhinorrhea']).has('sign.pharyngeal_hyperemia')).toBe(true);
    // рвота и тошнота бывают и при непроходимости, но головную боль она не объясняет
    expect(expectedFindings(db, ['sym.vomiting', 'sym.headache', 'sym.nausea']).has(LEVELS)).toBe(false);
    expect(expectedFindings(db, ['sym.abdominal_pain', 'sym.colicky_pain', 'sym.vomiting']).has(LEVELS)).toBe(true);
  });

  test('последняя из жалоб может быть не от болезни, первая — нет; без жалоб не ждут ничего', () => {
    expect(expectedFindings(db, ['sym.ruq_pain', 'sym.nausea', 'sym.back_pain']).has(MURPHY)).toBe(true);
    expect(expectedFindings(db, ['sym.back_pain', 'sym.ruq_pain', 'sym.nausea']).has(MURPHY)).toBe(false);
    expect(expectedFindings(db, []).size).toBe(0);
  });

  test('ждут и признаки того, без чего болезнь не бывает, и её факторов риска: камни на УЗИ при колике, фибрилляцию на ЭКГ при ишемии ноги', () => {
    // камни — у хронической болезни фона, без которой нет ни колики, ни холецистита
    expect(db.conditions['cond.biliary_colic'].requires).toContain('cond.cholelithiasis');
    expect(expectedFindings(db, ['sym.ruq_pain', 'sym.nausea']).has('img.us_gallstones')).toBe(true);
    expect(expectedFindings(db, ['sym.cough', 'sym.sore_throat', 'sym.rhinorrhea']).has('img.us_gallstones')).toBe(false);
    expect(db.conditions['cond.limb_ischemia'].risks!.map(r => r.id)).toContain('risk.atrial_fibrillation');
    expect(expectedFindings(db, ['sym.leg_numb', 'sym.leg_pain']).has('ecg.af')).toBe(true);
  });

  test('сочетания скрытых параметров — порознь: сепсис из лёгких объясняет кашель, а симптом Мерфи — у сепсиса из живота', () => {
    const sepsis = db.conditions['cond.sepsis'];
    expect(sepsis.findings.some(l => l.f === MURPHY && l.when?.source?.includes('abdomen'))).toBe(true);
    expect(sepsis.findings.some(l => l.f === 'sym.cough' && l.when?.source?.includes('lungs'))).toBe(true);
    expect(expectedFindings(db, ['sym.cough', 'sym.fever_hx']).has(MURPHY)).toBe(false);
  });

  test('у больных холециститом и непроходимостью их находку ждут почти всегда, у больных ОРВИ и мигренью — почти никогда', () => {
    const share = (primary: string, departments: string[], f: string) => {
      let yes = 0;
      let all = 0;
      for (let i = 0; i < 300; i++) {
        const p = generatePatient(db, 8_000_000 + i, { department: db.conditions[primary].department, departments, season: SEASONS[i % 4], primary });
        if (p.complaints.length === 0) continue;
        all++;
        if (expectedFindings(db, p.complaints).has(f)) yes++;
      }
      return yes / all;
    };
    const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma'];
    expect(share('cond.cholecystitis', ED, MURPHY)).toBeGreaterThan(0.95);
    expect(share('cond.adhesive_sbo', ED, LEVELS)).toBeGreaterThan(0.95);
    expect(share('cond.arvi', ['dept.therapy'], MURPHY)).toBeLessThan(0.1);
    expect(share('cond.migraine', ['dept.therapy'], LEVELS)).toBeLessThan(0.1);
  }, 30_000);
});

describe('частота ложной находки', () => {
  test('осмотр, снимок и ЭКГ, не показанные по жалобам, — в пять раз реже; анализы — как в рекомендации у всех', () => {
    const palpation = db.exams['exam.abdomen_palpation'];
    const spec = palpation.checks.find(k => k.f === MURPHY)!.spec;
    expect(UNEXPECTED_FALSE).toBe(5);
    expect(falseRate(palpation, MURPHY, spec, expectedFindings(db, ['sym.ruq_pain', 'sym.nausea']))).toBe(P_ONE - spec);
    expect(falseRate(palpation, MURPHY, spec, new Set())).toBe(Math.round((P_ONE - spec) / 5));
    for (const kind of ['physical', 'imaging', 'functional'] as const) expect(falseRate({ kind }, MURPHY, 9000, new Set())).toBe(200);
    for (const kind of ['lab', 'rapid', 'bedside', 'ask'] as const) expect(falseRate({ kind }, MURPHY, 9000, new Set())).toBe(1000);
  });

  test('движок: у больного ОРВИ ложный симптом Мерфи — у 1 из 100, у пришедшего с болью в правом подреберье — у 5', () => {
    let p: Patient | undefined;
    for (let seed = 1; !p; seed++) {
      const q = generatePatient(db, seed, { department: 'dept.therapy', season: 'winter', primary: 'cond.arvi' });
      if (q.complaints.length === 3 && !expectedFindings(db, q.complaints).has(MURPHY) && !q.truth.findings.some(x => x.f === MURPHY)) p = q;
    }
    const rate = (patient: Patient) => {
      let shown = 0;
      for (let i = 0; i < 20_000; i++) if (runExam(db, patient, 'exam.abdomen_palpation', Rng.seeded(7).fork(`n${i}`)).find(o => o.f === MURPHY)!.shown) shown++;
      return shown / 20_000;
    };
    // 3 сигмы при 20 000 бросках — около 0,2 п. п. при 1 % и 0,5 п. п. при 5 %
    expect(Math.abs(rate(p) - 0.01)).toBeLessThan(0.003);
    expect(Math.abs(rate({ ...p, complaints: ['sym.ruq_pain', 'sym.nausea'] }) - 0.05)).toBeLessThan(0.005);
  });
});

// Маленькая база: болезнь «a» даёт жалобу x и признак f, болезнь «b» — жалобу y; у жалобы y фон 10 %, поэтому с ней «a»
// возможна. Пришедший с жалобой y признака f не ждёт: его не даёт болезнь, которая объясняет жалобу.
const cond = (id: string, findings: { f: string; p: number }[]): Condition => ({
  id, name: { ru: id }, department: 'dept.test', kind: 'disease', severity: 'minor', presenting: true,
  weight: 50, age: { min: 18, max: 100 }, stages: [{ id: 'all', days: [0, 30] }],
  findings, confirm: 'clinical', texts: { summary: { ru: id } }, sources: [], review: 'draft',
});
const finding = (id: string, kind: Finding['kind'], leak: number): Finding => ({
  id, name: { ru: id }, kind, leak, salience: kind === 'sym' ? 3 : 0, texts: { present: [{ ru: id }] }, review: 'draft',
});
const exam = (id: string, kind: Exam['kind']): Exam => ({
  id, name: { ru: id }, kind, time: { procedure: 1 }, cost: 0, discomfort: 0,
  checks: [{ f: 'sign.f', sens: 8000, spec: 9000 }], texts: { summary: { ru: id } }, sources: [], review: 'draft',
});
const mini: ContentDb = {
  contentVersion: 1, hash: 'test', risks: {}, jobs: {}, treatments: {}, rooms: {}, equipment: {}, roles: {}, presets: {}, economy: NO_ECONOMY, characters: {}, chapters: {}, tips: {}, achievements: {}, scores: {}, rules: {}, targets: {}, revealedBy: {},
  conditions: {
    'cond.a': cond('cond.a', [{ f: 'sym.x', p: P_ONE }, { f: 'sign.f', p: 8000 }]),
    'cond.b': cond('cond.b', [{ f: 'sym.y', p: P_ONE }]),
  },
  findings: { 'sym.x': finding('sym.x', 'sym', 0), 'sym.y': finding('sym.y', 'sym', 1000), 'sign.f': finding('sign.f', 'sign', 0) },
  exams: { 'exam.look': exam('exam.look', 'physical'), 'exam.blood': exam('exam.blood', 'lab') },
};
const told: Observation = { f: 'sym.y', shown: true, exam: 'complaint' };
const who = { sex: 'm' as const, age: 40, season: 'winter' as const, complaints: ['sym.y'] };

describe('вывод разумного врача — с той же частотой', () => {
  test('движок маленькой базы: ложный признак f при жалобе y — у 2 из 100 на осмотре и у 10 — в анализе', () => {
    const patient: Patient = {
      seed: 1, sex: 'm', age: 40, season: 'winter', department: 'dept.test', complaints: ['sym.y'],
      truth: { conditions: [{ id: 'cond.b', role: 'primary', day: 1, stage: 'all', params: {} }], risks: [], findings: [{ f: 'sym.y', cause: 'cond.b' }], values: {} },
    };
    const rate = (examId: string, complaints: string[]) => {
      let shown = 0;
      for (let i = 0; i < 20_000; i++) if (runExam(mini, { ...patient, complaints }, examId, Rng.seeded(3).fork(`n${i}`))[0].shown) shown++;
      return shown / 20_000;
    };
    expect(Math.abs(rate('exam.look', ['sym.y']) - 0.02)).toBeLessThan(0.003);
    expect(Math.abs(rate('exam.blood', ['sym.y']) - 0.1)).toBeLessThan(0.007);
    // с жалобой x признак ждут — частота из рекомендации
    expect(Math.abs(rate('exam.look', ['sym.x']) - 0.1)).toBeLessThan(0.007);
  });

  test('показанный признак — довод во столько раз, во сколько его вероятность у «a» больше, чем у «b»: с той же частотой ложного', () => {
    const odds = (obs: Observation[]) => {
      const b = posterior(mini, ['cond.a', 'cond.b'], obs, contextOf(mini, who, obs));
      return b.find(x => x.id === 'cond.a')!.p / b.find(x => x.id === 'cond.b')!.p;
    };
    const base = odds([told]);
    // у «a» признак есть у 80 %: показан — 0,8 × 0,8 + ложный у остальных; у «b» — только ложный
    expect(odds([told, { f: 'sign.f', shown: true, exam: 'exam.look' }]) / base).toBeCloseTo((0.64 + 0.02 * 0.2) / 0.02, 6);
    expect(odds([told, { f: 'sign.f', shown: true, exam: 'exam.blood' }]) / base).toBeCloseTo((0.64 + 0.1 * 0.2) / 0.1, 6);
  });

  test('польза осмотра — с той же частотой ложного, что у движка', () => {
    const ctx = contextOf(mini, who, [told]);
    const beliefs = posterior(mini, ['cond.a', 'cond.b'], [told], ctx);
    const gain = (fp: number) => {
      const yes = beliefs.map(b => (b.id === 'cond.a' ? 0.8 * 0.8 + fp * 0.2 : fp));
      const pYes = beliefs.reduce((a, b, i) => a + b.p * yes[i], 0);
      const after = (shown: boolean) => entropy(beliefs.map((b, i) => ({ id: b.id, p: (b.p * (shown ? yes[i] : 1 - yes[i])) / (shown ? pYes : 1 - pYes) })));
      return entropy(beliefs) - pYes * after(true) - (1 - pYes) * after(false);
    };
    expect(expectedGain(mini, 'exam.look', beliefs, ctx, new Set(['sym.y']))).toBeCloseTo(gain(0.02), 9);
    expect(expectedGain(mini, 'exam.blood', beliefs, ctx, new Set(['sym.y']))).toBeCloseTo(gain(0.1), 9);
  });
});

describe('разбор: находка была ложной', () => {
  test('строка с частотой: у больного ОРВИ ложный симптом Мерфи — «у 1 из 100», у пришедшего с болью в подреберье — «у 5»', () => {
    const p = generatePatient(db, 11, { department: 'dept.therapy', season: 'winter', primary: 'cond.arvi' });
    const seen: Observation[] = [{ f: MURPHY, shown: true, exam: 'exam.abdomen_palpation' }];
    const lines = (patient: Patient) => falseFindings(patient, seen).map(l => l.cause);
    expect(p.truth.findings.some(x => x.f === MURPHY)).toBe(false);
    expect(expectedFindings(db, p.complaints).has(MURPHY)).toBe(false);
    expect(lines(p)).toEqual(['находка была ложной: так бывает у 1 из 100 без болезни']);
    expect(lines({ ...p, complaints: ['sym.ruq_pain', 'sym.nausea'] })).toEqual(['находка была ложной: так бывает у 5 из 100 без болезни']);
    // реже одного из ста — из тысячи
    expect(falseFindings(p, [{ f: 'img.cxr_pneumothorax', shown: true, exam: 'exam.xray_chest' }]).map(l => l.cause)[0]).toMatch(/из 1000 без болезни$/);
  });

  test('настоящая находка, «нет» и ответ на вопрос — не ложные находки', () => {
    const p = generatePatient(db, 11, { department: 'dept.therapy', season: 'winter', primary: 'cond.arvi' });
    const present = p.truth.findings.find(x => db.exams['exam.throat'].checks.some(k => k.f === x.f));
    const seen: Observation[] = [
      { f: MURPHY, shown: false, exam: 'exam.abdomen_palpation' },
      ...(present ? [{ f: present.f, shown: true, exam: 'exam.throat' }] : []),
      { f: 'hx.smoking', shown: true, exam: 'exam.ask_lifestyle' },
    ];
    expect(present).toBeDefined();
    // некурящий сказал «курю» — неверный ответ, но не находка
    expect(falseFindings({ ...p, truth: { ...p.truth, findings: p.truth.findings.filter(x => x.f !== 'hx.smoking') } }, seen)).toEqual([]);
  });
});
