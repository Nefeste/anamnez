// Инварианты пациента (`docs/04-medical-model.md` §1, ADR 0009) на тысячах сгенерированных
// пациентов из настоящей базы.
import { describe, expect, test } from 'bun:test';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { observationText } from '../../src/engine/med/text';
import type { Patient } from '../../src/engine/med/types';
import { buildDb } from '../content/load';

const { db, errors } = buildDb();
const N = 10_000; // критерий 3 spec 2026-09-spikes: «у каждого признака есть причина» на 10 000 пациентов
const patients: Patient[] = Array.from({ length: N }, (_, i) =>
  generatePatient(db, 1000 + i, { department: 'dept.therapy', season: (['winter', 'spring', 'summer', 'autumn'] as const)[i % 4] }));

describe('база собирается', () => {
  test('без ошибок валидатора', () => {
    expect(errors).toEqual([]);
  });
});

describe('у каждого признака есть причина', () => {
  test('причина — активное состояние, фактор риска пациента или фон, и эта причина правда может его вызвать', () => {
    const bad: string[] = [];
    for (const p of patients) {
      const conds = new Set(p.truth.conditions.map(c => c.id));
      const risks = new Set(p.truth.risks);
      for (const f of p.truth.findings) {
        // признак-последователь (часть 39а) — от того же, от чего его ведущий
        const leaders = db.findings[f.f].follows;
        if (leaders && p.truth.findings.some(x => leaders.includes(x.f) && x.cause === f.cause)) continue;
        if (f.cause === 'leak') {
          if (!(db.findings[f.f].leak > 0)) bad.push(`${p.seed}: ${f.f} от фона, а фон у признака нулевой`);
          continue;
        }
        const source = conds.has(f.cause) ? db.conditions[f.cause].findings : risks.has(f.cause) ? db.risks[f.cause].findings : undefined;
        if (!source) bad.push(`${p.seed}: ${f.f} вызван ${f.cause}, которого у пациента нет`);
        else if (!source.some(l => l.f === f.f && l.p > 0)) bad.push(`${p.seed}: ${f.cause} не может вызвать ${f.f}`);
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  test('связь с частотой «никогда» не срабатывает: у пневмонии нет «против»-признаков от неё самой', () => {
    for (const p of patients) for (const f of p.truth.findings) {
      const c = db.conditions[f.cause];
      // последователь (часть 39а) — по своему ведущему с той же причиной
      const leaders = db.findings[f.f].follows;
      const lead = leaders ? p.truth.findings.find(x => leaders.includes(x.f) && x.cause === f.cause) : undefined;
      if (c) expect(c.findings.filter(l => l.f === (lead?.f ?? f.f)).some(l => l.p > 0)).toBe(true);
    }
  });
});

describe('случай согласован', () => {
  test('сторона крепитации, притупления и инфильтрата у пневмонии — одна', () => {
    let checked = 0;
    for (const p of patients) {
      const pn = p.truth.conditions.find(c => c.id === 'cond.pneumonia_cap');
      if (!pn) continue;
      for (const f of p.truth.findings) {
        if (f.cause !== 'cond.pneumonia_cap' || !f.attrs?.side) continue;
        expect(f.attrs.side).toBe(pn.params.side);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  test('обострение ХОБЛ бывает только у тех, у кого есть ХОБЛ; возраст и пол в пределах', () => {
    for (const p of patients) {
      const ids = p.truth.conditions.map(c => c.id);
      if (ids.includes('cond.copd_exacerbation')) expect(ids).toContain('cond.copd');
      expect(p.age).toBeGreaterThanOrEqual(18);
      expect(p.age).toBeLessThanOrEqual(90);
      expect(['m', 'f']).toContain(p.sex);
      expect(p.truth.conditions[0].role).toBe('primary');
    }
  });

  test('у числовых показателей есть значение, и оно в своём диапазоне', () => {
    // порог на чужом измерении (часть 33б): число одно — у низкого давления то же, что у тонометра;
    // есть низкое давление — число из его диапазона «есть»
    const shared = Object.values(db.findings).filter(f => f.value?.of);
    for (const p of patients.slice(0, 500)) {
      const present = new Set(p.truth.findings.map(f => f.f));
      for (const [id, v] of Object.entries(p.truth.values)) {
        const spec = db.findings[id].value!;
        if (spec.of) {
          expect(v).toBe(p.truth.values[spec.of]);
          continue;
        }
        const low = shared.find(f => f.value!.of === id && present.has(f.id));
        const [lo, hi] = present.has(id) ? spec.present : low ? low.value!.present : spec.absent;
        expect(v).toBeGreaterThanOrEqual(lo);
        expect(v).toBeLessThanOrEqual(hi);
      }
    }
  });

  test('жалобы — заметные имеющиеся симптомы, не больше трёх', () => {
    for (const p of patients) {
      expect(p.complaints.length).toBeLessThanOrEqual(3);
      for (const c of p.complaints) expect(p.truth.findings.some(f => f.f === c)).toBe(true);
    }
    const obs = complaintObservations(patients[0]);
    expect(obs.every(o => o.shown && o.exam === 'complaint')).toBe(true);
  });

  test('с чем пришёл, на то и жалуется; без жалоб приходят только с тем, что находят на профосмотре', () => {
    let checkups = 0;
    for (const p of patients) {
      const primary = db.conditions[p.truth.conditions[0].id];
      const cause = (f: string) => p.truth.findings.find(x => x.f === f)?.cause;
      if (primary.checkup) {
        if (p.complaints.length === 0) checkups++;
        continue;
      }
      // первая жалоба — от болезней пациента, а не фоновая
      expect(`${p.seed} ${primary.id} ${p.complaints[0]} ${cause(p.complaints[0])}`).not.toMatch(/ (undefined|leak)$/);
      expect(p.complaints.some(f => cause(f) === primary.id)).toBe(true);
    }
    expect(checkups).toBeGreaterThan(10); // гипертонию и диабет находят и у тех, кто ни на что не жалуется
  });

  test('беременность — только у женщин 18–44 лет; «впервые выявленное» — только у тех, у кого этого ещё нет', () => {
    let pregnant = 0;
    for (const p of patients) {
      const ids = p.truth.conditions.map(c => c.id);
      if (p.truth.risks.includes('risk.pregnancy')) {
        pregnant++;
        expect(p.sex).toBe('f');
        expect(p.age).toBeLessThanOrEqual(44);
      }
      if (p.truth.risks.includes('risk.heavy_periods')) expect(p.sex === 'f' && p.age <= 50).toBe(true);
      if (ids[0] === 'cond.hypertension_new') expect(ids).not.toContain('cond.hypertension');
      if (ids[0] === 'cond.diabetes2_new') expect(ids).not.toContain('cond.diabetes2');
    }
    expect(pregnant).toBeGreaterThan(20);
  });

  test('давление показывается двумя числами: нижнее — из верхнего', () => {
    const p = patients.find(x => x.truth.findings.some(f => f.f === 'vital.bp_high'))!;
    const o = runExam(db, p, 'exam.vitals', Rng.seeded(1)).find(x => x.f === 'vital.bp_high')!;
    const text = observationText(db, o, p.sex, p.seed);
    expect(text).toMatch(/^Давление \d{2,3}\/\d{2,3} мм рт\. ст\.$/);
    const [sys, dia] = text.match(/\d+/g)!.map(Number);
    expect(dia).toBe(Math.round(sys * 0.62));
  });

  test('зимой грипп встречается чаще, чем летом', () => {
    const share = (season: string) => {
      const group = patients.filter(p => p.season === season);
      return group.filter(p => p.truth.conditions[0].id === 'cond.influenza').length / group.length;
    };
    expect(share('winter')).toBeGreaterThan(share('summer') * 5);
  });
});

describe('обследования ошибаются с заданной частотой', () => {
  test('экспресс-тест на грипп: чувствительность 62 %, специфичность 98 % (±3σ)', () => {
    let tp = 0, pos = 0, fp = 0, neg = 0;
    patients.forEach((p, i) => {
      const hasFlu = p.truth.findings.some(f => f.f === 'lab.flu_ag');
      const [o] = runExam(db, p, 'exam.flu_rapid', Rng.seeded(i).fork('test'));
      if (hasFlu) { pos++; if (o.shown) tp++; } else { neg++; if (o.shown) fp++; }
    });
    const sens = tp / pos, fpr = fp / neg;
    expect(Math.abs(sens - 0.62)).toBeLessThan(3 * Math.sqrt((0.62 * 0.38) / pos));
    expect(Math.abs(fpr - 0.02)).toBeLessThan(3 * Math.sqrt((0.02 * 0.98) / neg) + 0.001);
  });

  test('ложный числовой результат показывает значение из «чужого» диапазона', () => {
    const shared = Object.values(db.findings).filter(f => f.value?.of);
    for (const [i, p] of patients.slice(0, 2000).entries()) {
      const present = new Set(p.truth.findings.map(f => f.f));
      const obs = runExam(db, p, 'exam.vitals', Rng.seeded(i).fork('v'));
      for (const o of obs) {
        // не число (часть 42а: ритмичный ли пульс) — диапазонов нет
        const spec = db.findings[o.f].value;
        if (!spec) continue;
        // порог на чужом измерении (часть 33б): число — то, что показал тонометр, «есть» — если оно в
        // диапазоне порога
        if (spec.of) {
          const base = obs.find(x => x.f === spec.of)!;
          expect(o.value).toBe(base.value);
          expect(o.shown).toBe(o.value! >= spec.present[0] && o.value! <= spec.present[1]);
          continue;
        }
        const low = shared.find(f => f.value!.of === o.f && present.has(f.id));
        const [lo, hi] = o.shown ? spec.present : low && !present.has(o.f) ? low.value!.present : spec.absent;
        expect(o.value!).toBeGreaterThanOrEqual(lo);
        expect(o.value!).toBeLessThanOrEqual(hi);
      }
    }
  });

  test('о жалобах не переспрашивают: расспрос не спорит с тем, что пациент сказал сам', () => {
    let asked = 0;
    for (const [i, p] of patients.slice(0, 2000).entries()) {
      for (const o of runExam(db, p, 'exam.ask_complaints', Rng.seeded(i).fork('ask'))) {
        expect(p.complaints).not.toContain(o.f);
        asked++;
      }
    }
    expect(asked).toBeGreaterThan(0);
  });

  test('повторное обследование с другой ветвью бросает новые монеты, правда не меняется', () => {
    const p = patients.find(x => x.truth.findings.some(f => f.f === 'lab.flu_ag'))!;
    const results = Array.from({ length: 50 }, (_, i) => runExam(db, p, 'exam.flu_rapid', Rng.seeded(i))[0].shown);
    expect(results.some(Boolean)).toBe(true);
    expect(results.some(x => !x)).toBe(true);
  });
});
