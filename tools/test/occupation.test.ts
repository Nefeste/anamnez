// Профессия пациента и её вредности (FR-PAT-2, 0.5.10; spec 2026-10-occupation): кем работает — по полу и возрасту, из
// своей ветви зерна; вредности профессии — её факторы риска, и они меняют, с чем приходят; «Образ жизни» отвечает о
// работе; вывод знает профессию, как игрок; карта показывает её в роде пациента.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { ContentDb, Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { chronicChance, generatePatient, presentingWeight } from '../../src/engine/med/generate';
import { contextOf, posterior } from '../../src/engine/med/infer';
import { jobName, riskShare } from '../../src/engine/med/jobs';
import type { Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';
import { type CaseInput, makeCaseView } from '../../src/state/caseView';
import { article } from '../../src/state/encyclopedia';

const OCCUPATIONAL = ['risk.dust_work', 'risk.heavy_labor', 'risk.outdoor_work'];
const people = (n: number, from = 1, base: ContentDb = db) =>
  Array.from({ length: n }, (_, i) => generatePatient(base, from + i, { department: 'dept.therapy', season: 'summer' }));
const share = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter(ok).length / Math.max(1, xs.length);
const crowd = people(6000);

describe('профессии в базе', () => {
  test('двадцать одна профессия; вредности — три новых фактора риска и контакт с больным ОРВИ; новых факторов без профессии нет', () => {
    expect(Object.keys(db.jobs)).toHaveLength(21);
    const named = new Set(Object.values(db.jobs).flatMap(j => j.hazards.map(h => h.id)));
    expect([...named].sort()).toEqual([...OCCUPATIONAL, 'risk.sick_contact'].sort());
    for (const id of OCCUPATIONAL) expect(db.risks[id].p).toEqual({ m: 0, f: 0 });
    // пенсионер — один, только по доле в возрасте
    expect(Object.values(db.jobs).filter(j => j.retired).map(j => j.id)).toEqual(['job.retired']);
    expect(db.jobs['job.retired'].retired).toEqual([{ from: 55, p: 3000 }, { from: 60, p: 6000 }, { from: 65, p: 9000 }, { from: 75, p: 10000 }]);
    expect(db.jobs['job.builder'].hazards).toEqual([{ id: 'risk.heavy_labor', p: 10000 }, { id: 'risk.dust_work', p: 4000 }]);
  });

  test('профессия в роде пациента: учитель и учительница, строитель — один на оба', () => {
    expect([jobName(db, 'job.teacher', 'm'), jobName(db, 'job.teacher', 'f')]).toEqual(['Учитель', 'Учительница']);
    expect([jobName(db, 'job.nurse', 'm'), jobName(db, 'job.nurse', 'f')]).toEqual(['Медбрат', 'Медсестра']);
    expect([jobName(db, 'job.builder', 'm'), jobName(db, 'job.builder', 'f')]).toEqual(['Строитель', 'Строитель']);
    expect(jobName(db, 'job.retired', 'f')).toBe('Пенсионерка');
  });
});

describe('энциклопедия', () => {
  test('у вредности — болезни, которые она учащает, и хронические тоже, и у кого она бывает по работе', () => {
    const dust = article(db, 'risk.dust_work')!;
    expect(dust.blocks.find(b => b.key === 'raises')!.refs!.map(r => r.id)).toEqual(['cond.copd']);
    expect(dust.blocks.find(b => b.key === 'jobs')!.text).toEqual(['Сварщик — у всех', 'Строитель — у 40 из 100', 'Шахтёр — у всех']);
    expect(article(db, 'risk.sick_contact')!.blocks.find(b => b.key === 'jobs')!.text).toEqual(['Врач — у 50 из 100', 'Медбрат, медсестра — у 50 из 100', 'Учитель, учительница — у 50 из 100']);
    // курение — и ХОБЛ (хроническая, с 0.5.10 в статье)
    expect(article(db, 'risk.smoking')!.blocks.find(b => b.key === 'raises')!.refs!.some(r => r.id === 'cond.copd')).toBe(true);
  });
});

describe('кем работает пациент', () => {
  test('у каждого — профессия своего пола и возраста; грузчиков, сварщиков и шахтёров-женщин нет', () => {
    for (const p of crowd) {
      const j = db.jobs[p.job!];
      expect(j).toBeDefined();
      if (j.retired) continue;
      expect({ id: j.id, fits: p.age >= j.age.min && p.age <= j.age.max && j.sex[p.sex] > 0 }).toEqual({ id: j.id, fits: true });
    }
    const women = crowd.filter(p => p.sex === 'f');
    expect(women.some(p => ['job.loader', 'job.welder', 'job.miner', 'job.tractor_driver'].includes(p.job!))).toBe(false);
    expect(crowd.filter(p => p.job === 'job.student').every(p => p.age <= 24)).toBe(true);
  });

  test('пенсионеры — по долям возраста: до 55 никого, 55–59 — 3 из 10, 60–64 — 6, 65–74 — 9, с 75 — все', () => {
    const retired = (lo: number, hi: number) => share(crowd.filter(p => p.age >= lo && p.age <= hi), p => p.job === 'job.retired');
    expect(retired(18, 54)).toBe(0);
    expect(Math.abs(retired(55, 59) - 0.3)).toBeLessThan(0.08);
    expect(Math.abs(retired(60, 64) - 0.6)).toBeLessThan(0.08);
    expect(Math.abs(retired(65, 74) - 0.9)).toBeLessThan(0.05);
    expect(retired(75, 100)).toBe(1);
  });

  test('вредности — с долями профессии: у строителя тяжёлый труд всегда, пыль — у 4 из 10; у остальных новых факторов нет', () => {
    for (const p of crowd) {
      const hazards = new Set(db.jobs[p.job!].hazards.map(h => h.id));
      for (const r of OCCUPATIONAL) if (p.truth.risks.includes(r)) expect({ job: p.job, r, named: hazards.has(r) }).toEqual({ job: p.job, r, named: true });
    }
    const builders = crowd.filter(p => p.job === 'job.builder');
    expect(builders.length).toBeGreaterThan(40);
    expect(builders.every(p => p.truth.risks.includes('risk.heavy_labor'))).toBe(true);
    expect(Math.abs(share(builders, p => p.truth.risks.includes('risk.dust_work')) - 0.4)).toBeLessThan(0.15);
    // контакт с больным ОРВИ: у учителя, медсестры и врача — у половины, у остальных — у 25–30 из 100
    const contact = (ok: (p: Patient) => boolean) => share(crowd.filter(ok), p => p.truth.risks.includes('risk.sick_contact'));
    const teaching = (p: Patient) => ['job.teacher', 'job.nurse', 'job.doctor'].includes(p.job!);
    expect(Math.abs(contact(teaching) - 0.5)).toBeLessThan(0.08);
    expect(Math.abs(contact(p => !teaching(p)) - 0.28)).toBeLessThan(0.04);
  });

  test('профессия — своя ветвь зерна: пол, возраст и факторы риска, которых она не меняет, — те же, что без профессий', () => {
    const none: ContentDb = { ...db, jobs: {} };
    const before = people(400, 1, none);
    const after = crowd.slice(0, 400);
    const plain = (p: Patient) => p.truth.risks.filter(r => !OCCUPATIONAL.includes(r) && r !== 'risk.sick_contact');
    for (let i = 0; i < 400; i++) {
      expect(before[i].job).toBeUndefined();
      expect([after[i].sex, after[i].age, plain(after[i])]).toEqual([before[i].sex, before[i].age, plain(before[i])]);
    }
    // без профессии вредностей нет: их доля в записи — 0
    expect(before.some(p => p.truth.risks.some(r => OCCUPATIONAL.includes(r)))).toBe(false);
    expect(riskShare(db, 'risk.heavy_labor', 'm', undefined)).toBe(0);
    expect(riskShare(db, 'risk.heavy_labor', 'm', 'job.loader')).toBe(10000);
  });
});

describe('вредности меняют, с чем приходят', () => {
  const who = (risks: Id[]) => ({ sex: 'm' as const, age: 50, season: 'summer' as const, risks, chronic: [] });
  const ratio = (c: Id, risk: Id) => presentingWeight(db.conditions[c], who([risk])) / presentingWeight(db.conditions[c], who([]));

  test('тяжёлый труд — радикулопатия и ущемлённая грыжа ×1,5; лес и поле — клещ, энцефалит, Лайм и ГЛПС ×2; пыль — ХОБЛ ×2', () => {
    expect(ratio('cond.radiculopathy', 'risk.heavy_labor')).toBeCloseTo(1.5, 6);
    expect(ratio('cond.strangulated_hernia', 'risk.heavy_labor')).toBeCloseTo(1.5, 6);
    for (const c of ['cond.tick_bite', 'cond.tbe', 'cond.lyme', 'cond.hfrs']) expect({ c, x: ratio(c, 'risk.outdoor_work') }).toEqual({ c, x: 2 });
    const copd = db.conditions['cond.copd'];
    expect(chronicChance(copd, ['risk.dust_work']) / chronicChance(copd, [])).toBeCloseTo(2, 6);
  });
});

describe('врач знает профессию', () => {
  const back = generatePatient(db, 77, { department: 'dept.therapy', season: 'summer', primary: 'cond.radiculopathy' });
  const candidates = candidatesOf(db, ['dept.therapy']);
  const beliefOf = (p: Patient, id: Id) => {
    const obs = complaintObservations(p);
    return posterior(db, candidates, obs, contextOf(db, p, obs)).find(b => b.id === id)?.p ?? 0;
  };

  test('с той же болью в спине радикулопатия у строителя вероятнее, чем у бухгалтера; без профессии — как у бухгалтера', () => {
    const builder = beliefOf({ ...back, sex: 'm', job: 'job.builder' }, 'cond.radiculopathy');
    const accountant = beliefOf({ ...back, sex: 'm', job: 'job.accountant' }, 'cond.radiculopathy');
    const unknown = beliefOf({ ...back, sex: 'm', job: undefined }, 'cond.radiculopathy');
    expect(builder).toBeGreaterThan(accountant * 1.2);
    expect(unknown).toBeCloseTo(accountant, 9);
  });

  test('«Образ жизни» отвечает о работе: у строителя — тяжёлый труд, у бухгалтера — «Тяжёлого не поднимаю»', () => {
    const one = (job: Id, risks: Id[]): Patient => ({ ...back, job, truth: { ...back.truth, risks, findings: [...back.truth.findings.filter(f => !f.f.startsWith('hx.heavy') && !f.f.startsWith('hx.dust') && !f.f.startsWith('hx.outdoor')), ...risks.filter(r => OCCUPATIONAL.includes(r)).map(r => ({ f: db.risks[r].findings[0].f, cause: r }))] } });
    const ask = (p: Patient) => runExam(db, p, 'exam.ask_lifestyle', Rng.seeded(5), undefined, true).find(o => o.f === 'hx.heavy_labor');
    expect(ask(one('job.builder', ['risk.heavy_labor']))?.shown).toBe(true);
    expect(ask(one('job.accountant', []))?.shown).toBe(false);
    expect(db.findings['hx.heavy_labor'].texts.absent?.[0].ru).toBe('Тяжёлого не поднимаю');
  });

  test('карта пациента: под именем — профессия в его роде; у пациента из старого сохранения строки нет', () => {
    const input = (p: Patient): CaseInput => ({ version: 1, patient: p, clock: 600, minutesSpent: 0, money: 0, step: 0, arrived: [], pending: [], meanwhile: [], done: [], draft: { treatments: [], setting: 'home' } });
    const female = generatePatient(db, 5, { department: 'dept.therapy', season: 'summer' });
    expect(makeCaseView(input({ ...female, sex: 'f', job: 'job.teacher' })).job).toBe('Учительница');
    expect(makeCaseView(input({ ...female, sex: 'm', job: 'job.teacher' })).job).toBe('Учитель');
    expect(makeCaseView(input({ ...female, job: undefined })).job).toBeUndefined();
  });
});
