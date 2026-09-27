// Вывод уверенности (`docs/04-medical-model.md` §10–12): пример из документа, посчитанный
// руками, — маленькая база из четырёх состояний и двух признаков.
import { describe, expect, test } from 'bun:test';
import type { Condition, ContentDb, Exam, Finding } from '../../src/content/types';
import { entropy, expectedGain, posterior } from '../../src/engine/med/infer';
import type { Observation } from '../../src/engine/med/types';

const cond = (id: string, weight: number, crackles: number, infiltrate: number): Condition => ({
  id, name: { ru: id }, department: 'dept.test', kind: 'disease', severity: 'minor', presenting: true,
  weight, age: { min: 18, max: 100 }, stages: [{ id: 'all', days: [0, 30] }],
  findings: [{ f: 'sign.crackles', p: crackles }, { f: 'img.infiltrate', p: infiltrate }],
  confirm: 'clinical', texts: { summary: { ru: id } }, sources: [], review: 'draft',
});
const finding = (id: string, leak: number): Finding => ({
  id, name: { ru: id }, kind: id.startsWith('img') ? 'img' : 'sign', leak, salience: 0, texts: { present: [{ ru: id }] }, review: 'draft',
});
const exam = (id: string, f: string, sens: number, spec: number): Exam => ({
  id, name: { ru: id }, kind: 'physical', time: { procedure: 1 }, cost: 0, discomfort: 0,
  checks: [{ f, sens, spec }], texts: { summary: { ru: id } }, sources: [], review: 'draft',
});

/** Числа — иллюстрация из документа: q в долях 1/10 000, априорные 45/25/15/15. */
const db: ContentDb = {
  contentVersion: 1, hash: 'test', risks: {}, treatments: {}, rooms: {}, equipment: {}, roles: {}, presets: {}, economy: { corridor: { cost: 0, upkeep: 0 }, refund: 50 }, revealedBy: {},
  conditions: {
    'cond.arvi': cond('cond.arvi', 45, 200, 100),
    'cond.bronchitis': cond('cond.bronchitis', 25, 1000, 200),
    'cond.pneumonia': cond('cond.pneumonia', 15, 7500, 9500),
    'cond.copd': cond('cond.copd', 15, 1500, 500),
  },
  findings: { 'sign.crackles': finding('sign.crackles', 200), 'img.infiltrate': finding('img.infiltrate', 100) },
  exams: {
    'exam.auscultation': exam('exam.auscultation', 'sign.crackles', 8000, 9500),
    'exam.xray': exam('exam.xray', 'img.infiltrate', 8500, 9500),
  },
};
const candidates = Object.keys(db.conditions);
const ctx = { sex: 'm' as const, age: 67, season: 'winter' as const, knownRisks: [], knownConditions: [] };
const p = (beliefs: { id: string; p: number }[], id: string) => beliefs.find(b => b.id === id)!.p;
const crackles = (shown: boolean): Observation => ({ f: 'sign.crackles', shown, exam: 'exam.auscultation' });
const infiltrate = (shown: boolean): Observation => ({ f: 'img.infiltrate', shown, exam: 'exam.xray' });

describe('пример из 04-medical-model.md §12', () => {
  test('априорные вероятности — 45/25/15/15', () => {
    const b = posterior(db, candidates, [], ctx);
    expect(p(b, 'cond.arvi')).toBeCloseTo(0.45, 6);
    expect(p(b, 'cond.pneumonia')).toBeCloseTo(0.15, 6);
  });

  test('крепитация есть: пневмония 49 %', () => {
    const b = posterior(db, candidates, [crackles(true)], ctx);
    expect(p(b, 'cond.pneumonia')).toBeCloseTo(0.4885, 3);
    expect(p(b, 'cond.arvi')).toBeCloseTo(0.1895, 3);
    expect(p(b, 'cond.bronchitis')).toBeCloseTo(0.1830, 3);
    expect(p(b, 'cond.copd')).toBeCloseTo(0.1390, 3);
  });

  test('крепитации нет: пневмония падает до 7 %, но не до нуля', () => {
    const b = posterior(db, candidates, [crackles(false)], ctx);
    expect(p(b, 'cond.pneumonia')).toBeCloseTo(0.0710, 3);
    expect(p(b, 'cond.arvi')).toBeCloseTo(0.5108, 3);
    expect(p(b, 'cond.pneumonia')).toBeGreaterThan(0);
  });

  test('крепитация и инфильтрат: пневмония 91 %', () => {
    const b = posterior(db, candidates, [crackles(true), infiltrate(true)], ctx);
    expect(p(b, 'cond.pneumonia')).toBeCloseTo(0.9091, 3);
    expect(b[0].id).toBe('cond.pneumonia');
  });

  test('польза: рентген после крепитации информативнее повторной аускультации', () => {
    const b = posterior(db, candidates, [crackles(true)], ctx);
    const observed = new Set(['sign.crackles']);
    const xray = expectedGain(db, 'exam.xray', b, ctx, observed);
    const again = expectedGain(db, 'exam.auscultation', b, ctx, observed);
    expect(xray).toBeGreaterThan(0.3);
    expect(again).toBe(0); // уже наблюдалось — приближение среза считает только новое
  });

  test('два совпавших ответа об одном признаке — не две независимые улики', () => {
    // Ошибки независимы только при известной правде: P = q·sens² + (1−q)·(1−spec)².
    const q: Record<string, number> = { 'cond.arvi': 200, 'cond.bronchitis': 1000, 'cond.pneumonia': 7500, 'cond.copd': 1500 };
    const prior: Record<string, number> = { 'cond.arvi': 45, 'cond.bronchitis': 25, 'cond.pneumonia': 15, 'cond.copd': 15 };
    const joint = Object.fromEntries(candidates.map(id => {
      const pf = 1 - (1 - 0.02) * (1 - q[id] / 10000);
      return [id, prior[id] * (pf * 0.8 ** 2 + (1 - pf) * 0.05 ** 2)];
    }));
    const total = Object.values(joint).reduce((a, b) => a + b, 0);
    const twice = posterior(db, candidates, [crackles(true), crackles(true)], ctx);
    for (const id of candidates) expect(p(twice, id)).toBeCloseTo(joint[id] / total, 9);
    // сильнее одного ответа, но слабее «двух улик»
    expect(p(twice, 'cond.pneumonia')).toBeGreaterThan(0.4885);
    expect(p(twice, 'cond.pneumonia')).toBeLessThan(0.75);
  });

  test('признак, известный без ошибки, повторная проверка не сдвигает', () => {
    const told: Observation = { f: 'sign.crackles', shown: true, exam: 'complaint' };
    const base = posterior(db, candidates, [told], ctx);
    for (const extra of [crackles(true), crackles(false)]) {
      const b = posterior(db, candidates, [told, extra], ctx);
      for (const id of candidates) expect(p(b, id)).toBeCloseTo(p(base, id), 9);
    }
  });

  test('энтропия: уверенность в одном — ноль бит, равные шансы четырёх — два бита', () => {
    expect(entropy([{ id: 'a', p: 1 }])).toBe(0);
    expect(entropy(['a', 'b', 'c', 'd'].map(id => ({ id, p: 0.25 })))).toBeCloseTo(2, 9);
  });
});
