// Пол и возраст в частотах признаков (FR-MED-1, 0.5.10; spec 2026-10-age-sex): у связи болезни с признаком — множители
// возраста и пола; генератор и вывод берут их одной функцией. У пожилых с пневмонией типичные жалобы реже, а спутанность
// чаще (654_2, раздел 1.6); при ОКС у пожилых и у женщин давящая боль реже (154_4, раздел 2.1).
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { type Link, linkP } from '../../src/content/types';
import { generatePatient } from '../../src/engine/med/generate';
import { findingProbability } from '../../src/engine/med/infer';
import type { Patient } from '../../src/engine/med/types';

const PNEUMONIA = 'cond.pneumonia_cap';
const ACS = 'cond.acs';
const sick = (primary: string, n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => generatePatient(db, from + i, { department: 'dept.therapy', season: 'winter', primary }));
const has = (p: Patient, f: string) => p.truth.findings.some(x => x.f === f);
const share = (xs: Patient[], f: string) => xs.filter(p => has(p, f)).length / Math.max(1, xs.length);

describe('множители связи', () => {
  const link: Link = { f: 'sym.x', p: 5000, older: { from: 60, x: 0.5 }, sex: { f: 1.5 } };

  test('с возраста `from` — в `x` раз, у пола — в свои; без множителей и без человека — как записано', () => {
    expect(linkP(link, { sex: 'm', age: 59 })).toBe(5000);
    expect(linkP(link, { sex: 'm', age: 60 })).toBe(2500);
    expect(linkP(link, { sex: 'f', age: 30 })).toBe(7500);
    expect(linkP(link, { sex: 'f', age: 70 })).toBe(3750);
    expect(linkP(link)).toBe(5000);
    expect(linkP({ f: 'sym.x', p: 5000 }, { sex: 'f', age: 80 })).toBe(5000);
  });

  test('чаще — не выше «почти всегда»: множитель не делает признак обязательным; записанное выше — не ниже записанного', () => {
    expect(linkP({ f: 'sym.x', p: 7500, sex: { m: 2 } }, { sex: 'm', age: 40 })).toBe(9500);
    expect(linkP({ f: 'sym.x', p: 10000, sex: { m: 2 } }, { sex: 'm', age: 40 })).toBe(10000);
    expect(linkP({ f: 'sym.x', p: 200, older: { from: 60, x: 6 } }, { sex: 'm', age: 80 })).toBe(1200);
  });

  test('в базе: у пневмонии и ОКС множители записаны; связи с множителями — только у них', () => {
    const withWho = Object.values(db.conditions).filter(c => c.findings.some(l => l.older || l.sex)).map(c => c.id).sort();
    expect(withWho).toEqual([ACS, PNEUMONIA]);
    const pn = db.conditions[PNEUMONIA].findings;
    expect(pn.find(l => l.f === 'sym.confusion')).toMatchObject({ p: 200, older: { from: 60, x: 6 } });
    expect(pn.find(l => l.f === 'sym.cough')).toMatchObject({ older: { from: 60, x: 0.8 } });
    expect(db.conditions[ACS].findings.filter(l => l.f === 'sym.chest_pain_pressing').every(l => l.sex?.f === 0.85 && l.older?.x === 0.85)).toBe(true);
  });
});

describe('генератор', () => {
  test('пневмония: у пожилых кашель и озноб реже, спутанность и тошнота чаще', () => {
    const all = sick(PNEUMONIA, 3000);
    const old = all.filter(p => p.age >= 60);
    const young = all.filter(p => p.age < 60);
    expect(old.length).toBeGreaterThan(600);
    expect(share(old, 'sym.cough')).toBeLessThan(share(young, 'sym.cough') - 0.07);
    expect(share(old, 'sym.chills')).toBeLessThan(share(young, 'sym.chills') - 0.1);
    expect(share(old, 'sym.confusion')).toBeGreaterThan(share(young, 'sym.confusion') + 0.05);
  });

  test('ОКС: у женщин давящая боль за грудиной реже, одышка и тошнота чаще', () => {
    const all = sick(ACS, 3000);
    const women = all.filter(p => p.sex === 'f');
    const men = all.filter(p => p.sex === 'm');
    expect(women.length).toBeGreaterThan(300);
    expect(share(women, 'sym.chest_pain_pressing')).toBeLessThan(share(men, 'sym.chest_pain_pressing'));
    expect(share(women, 'sym.nausea')).toBeGreaterThan(share(men, 'sym.nausea'));
  });
});

describe('вывод', () => {
  test('P(признак | болезнь) — по полу и возрасту: спутанность при пневмонии у 80-летнего вероятнее, чем у 30-летнего', () => {
    const at = (f: string, sex: 'm' | 'f', age: number) => findingProbability(db, f, [PNEUMONIA], [], 1, { sex, age });
    expect(at('sym.confusion', 'm', 80)).toBeGreaterThan(at('sym.confusion', 'm', 30) * 4);
    expect(at('sym.cough', 'm', 80)).toBeLessThan(at('sym.cough', 'm', 30));
    // без человека — как записано: у связи без множителей разницы нет
    expect(findingProbability(db, 'sym.dyspnea', [PNEUMONIA], [])).toBeCloseTo(at('sym.dyspnea', 'f', 80), 12);
    const acs = (sex: 'm' | 'f') => findingProbability(db, 'sym.nausea', [ACS], [], 1, { sex, age: 50 });
    expect(acs('f')).toBeGreaterThan(acs('m'));
  });
});
