// Кислород через маску по сатурации (spec 2026-10-chapter-3, часть 38б): порог — производный параметр
// по числу (`derived: { f, below }`), у каждой болезни — порог своей рекомендации; при низкой
// сатурации кислород обязателен, когда лечат здесь (`require`), при нормальной у ОКС и остальных —
// «не нужно». Вывод — по измеренному числу; разумный врач назначает кислород, если измерил ниже порога.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id, Setting } from '../../src/content/types';
import { generatePatient } from '../../src/engine/med/generate';
import { paramBeliefs } from '../../src/engine/med/infer';
import { evaluatePlan, tacticsFor, txRole } from '../../src/engine/med/plan';
import { choosePlan } from '../../src/engine/med/policy';
import { scoreCase } from '../../src/engine/med/score';
import type { Observation, Patient } from '../../src/engine/med/types';
import { noteText } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const O2 = 'tx.oxygen_mask';
const SPO2 = 'vital.spo2_low';
const CAP = 'cond.pneumonia_cap';
const ACS = 'cond.acs';
const COPD = 'cond.copd_exacerbation';
const ASTHMA = 'cond.asthma_exacerbation';
const COVID = 'cond.covid19';
const ANA = 'cond.anaphylaxis';

const people = (primary: Id, n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => generatePatient(db, from + i, { department: 'dept.therapy', season: 'winter', primary, params: {} }));
const paramsOf = (p: Patient) => p.truth.conditions.find(c => c.role === 'primary')!.params;
const spo2 = (p: Patient) => p.truth.values[SPO2];
/** Первый пациент с этой болезнью, у кого сатурация подходит. */
const someone = (primary: Id, ok: (value: number) => boolean) => people(primary, 4000).find(p => ok(spo2(p)))!;
const measured = (value: number): Observation => ({ f: SPO2, shown: value < 95, value, exam: 'exam.vitals' });
const scoreOf = (p: Patient, treatments: Id[], setting: Setting) => {
  const ev = evaluatePlan(db, p, { treatments, setting }, []);
  return { ev, score: scoreCase({ verdict: 'correct', confidence: 1, cost: 0, rationalCost: 0, plan: ev, outcome: { kind: 'admitted', day: 0, cured: true } as never, selfLimiting: false, redFlags: [] }) };
};

describe('порог на измерении', () => {
  test('сатурация ниже порога болезни — «yes», иначе «no»: у пневмонии и ОКС — 90, ХОБЛ — 92 и ниже, астмы — 93, COVID-19 — 95', () => {
    const cases: [Id, string, number][] = [[CAP, 'spo2_below90', 90], [ACS, 'spo2_below90', 90], [COPD, 'spo2_le92', 93], [ASTHMA, 'spo2_below93', 93], [COVID, 'spo2_below95', 95]];
    for (const [id, name, below] of cases) {
      expect(db.conditions[id].derived?.[name]).toEqual({ f: SPO2, below });
      const xs = people(id, 600);
      for (const p of xs) expect({ id, value: spo2(p), param: paramsOf(p)[name] }).toEqual({ id, value: spo2(p), param: spo2(p) < below ? 'yes' : 'no' });
      // гипоксемия бывает, но не у всех: доля — та, что в записи для вывода (±4 п. п.)
      const yes = xs.filter(p => paramsOf(p)[name] === 'yes').length / xs.length;
      const dist = db.conditions[id].params![name];
      expect(Math.abs(yes - dist.yes / (dist.yes + dist.no))).toBeLessThan(0.04);
    }
  });

  test('производный параметр не бросается: прочие параметры и признаки пациента — те же, что без него', () => {
    const p = someone(CAP, v => v < 90);
    const again = generatePatient(db, p.seed, { department: 'dept.therapy', season: 'winter', primary: CAP, params: {} });
    expect(again.truth).toEqual(p.truth);
    expect(paramsOf(p).severity).toBeDefined();
  });

  test('вывод: не мерили — доли записи; измерили — ответ по числу, последнее измерение главное', () => {
    const dist = db.conditions[CAP].params!.spo2_below90;
    const before = paramBeliefs(db, CAP, 'spo2_below90', [], 50);
    expect(before.find(b => b.value === 'yes')!.p).toBeCloseTo(dist.yes / (dist.yes + dist.no), 6);
    expect(paramBeliefs(db, CAP, 'spo2_below90', [measured(87)], 50)).toEqual([{ value: 'no', p: 0 }, { value: 'yes', p: 1 }]);
    expect(paramBeliefs(db, CAP, 'spo2_below90', [measured(93)], 50)).toEqual([{ value: 'no', p: 1 }, { value: 'yes', p: 0 }]);
    expect(paramBeliefs(db, CAP, 'spo2_below90', [measured(87), measured(92)], 50).find(b => b.value === 'yes')!.p).toBe(0);
  });
});

describe('тактика и оценка', () => {
  test('ниже порога — кислород обязателен, выше — не нужен; у анафилаксии — всем', () => {
    for (const [id, name] of [[CAP, 'spo2_below90'], [ACS, 'spo2_below90'], [COPD, 'spo2_le92'], [ASTHMA, 'spo2_below93'], [COVID, 'spo2_below95']] as const) {
      const t = db.conditions[id].treatment!;
      expect(tacticsFor(t, { [name]: 'yes' }).require).toEqual([O2]);
      expect(tacticsFor(t, { [name]: 'no' }).notIndicated).toContain(O2);
      expect([txRole(db, id, O2, { [name]: 'yes' }), txRole(db, id, O2, { [name]: 'no' })]).toEqual(['require', 'notIndicated']);
    }
    expect(db.conditions[ANA].treatment!.require).toEqual([O2]);
    expect(txRole(db, ANA, O2, paramsOf(people(ANA, 1)[0]))).toBe('require');
  });

  test('пневмония с сатурацией ниже 90 % в своей палате без кислорода — лечение C, безопасность C, строка разбора с порогом', () => {
    const p = someone(CAP, v => v < 90);
    const without = scoreOf(p, ['tx.amoxicillin'], 'admit');
    expect(without.ev.requireMissing).toEqual([O2]);
    const note = without.score.notes.find(n => n.code === 'tx.requireMissing')!;
    expect(note).toEqual({ code: 'tx.requireMissing', tx: O2, when: { spo2_below90: ['yes'] } });
    expect(noteText(note)).toBe('Не назначено: кислород через маску — обязательно при сатурации ниже 90 %');
    expect([without.score.treatment, without.score.safety]).toEqual(['C', 'C']);
    const withO2 = scoreOf(p, ['tx.amoxicillin', O2], 'admit');
    expect(withO2.ev.requireMissing).toEqual([]);
    expect(withO2.score.treatment).toBe('A');
    // направили в другую больницу — кислород дадут там: замечания нет
    expect(scoreOf(p, ['tx.amoxicillin'], 'ward').ev.requireMissing).toEqual([O2]);
    expect(scoreOf(p, ['tx.amoxicillin'], 'ward').score.notes.some(n => n.code === 'tx.requireMissing')).toBe(false);
  });

  test('ОКС с нормальной сатурацией — кислород «не нужен» (157_5, 154_4: ЕОК IIIB); анафилаксия в ПИТ без кислорода — неполное лечение', () => {
    const acs = someone(ACS, v => v >= 90);
    const given = scoreOf(acs, ['tx.aspirin_acs', 'tx.nitroglycerin', O2], 'ambulance');
    expect(given.score.notes).toContainEqual({ code: 'tx.notIndicated', tx: O2 });
    const shock = people(ANA, 1)[0];
    const plain = scoreOf(shock, ['tx.epinephrine_im', 'tx.iv_fluids', 'tx.steroid_iv'], 'icu');
    const note = plain.score.notes.find(n => n.code === 'tx.requireMissing')!;
    expect(noteText(note)).toBe('Не назначено: кислород через маску — без этого лечение неполное');
    expect(scoreOf(shock, ['tx.epinephrine_im', 'tx.iv_fluids', 'tx.steroid_iv', O2], 'icu').ev.requireMissing).toEqual([]);
  });

  test('разумный врач: измерил ниже порога — назначает кислород, выше — нет', () => {
    const low = choosePlan(db, CAP, [measured(87)], 50, { ward: true });
    const ok = choosePlan(db, CAP, [measured(96)], 50, { ward: true });
    expect([low.treatments.includes(O2), ok.treatments.includes(O2)]).toEqual([true, false]);
  });
});

describe('энциклопедия', () => {
  test('у пневмонии — «Обязательно, при сатурации ниже 90 %» и «Не нужно, при сатурации 90 % и выше»; у кислорода — болезни, при которых он обязателен', () => {
    const rows = article(db, CAP)!.blocks.find(b => b.key === 'treatment')!.rows!;
    expect(rows.find(r => r.label === 'Обязательно, при сатурации ниже 90 %')!.refs!.map(r => r.id)).toEqual([O2]);
    expect(rows.find(r => r.label === 'Не нужно, при сатурации 90 % и выше')!.refs!.map(r => r.id)).toEqual([O2]);
    const o2 = article(db, O2)!;
    const must = o2.blocks.flatMap(b => b.rows ?? []).find(r => r.label === 'Обязательно при')!;
    // и при ТЭЛА (часть 43б; ESC 2019, раздел 6.1.1: кислород при SaO2 < 90 %), и при ОДСН (часть 43в; 156_2, раздел 7.4.1.2)
    expect(must.refs!.map(r => r.id).sort()).toEqual([ACS, 'cond.adhf', ANA, ASTHMA, COPD, COVID, CAP, 'cond.pe', 'cond.status_epilepticus'].sort());
  });
});
