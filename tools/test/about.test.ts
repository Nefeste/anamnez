// «Об игре» (src/state/sources.ts): источники медицинской базы — по видам, без повторов и
// без служебных пометок авторов базы (11-publishing.md §3).
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { sourceGroups, sourceLine } from '../../src/state/sources';

describe('об игре: источники базы', () => {
  test('по видам, рекомендации первыми, без повторов; служебных пометок нет', () => {
    const groups = sourceGroups(db);
    expect(groups[0].kind).toBe('guideline');
    const all = groups.flatMap(g => g.items);
    expect(all.length).toBeGreaterThan(50);
    expect(new Set(all).size).toBe(all.length);
    // источники факторов риска — тоже: доли людей с ними взяты оттуда
    expect(all).toContain('Минздрав РФ. Ожирение, 2024');
    const notes = [...Object.values(db.conditions), ...Object.values(db.exams), ...Object.values(db.treatments), ...Object.values(db.risks)]
      .flatMap(x => x.sources)
      .flatMap(s => (s.note ? [s.note] : []));
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) expect(all.some(line => line.includes(n))).toBe(false);
  });

  test('строка: организация, название, год — если его нет в названии', () => {
    expect(sourceLine({ kind: 'guideline', org: 'Минздрав РФ', title: 'Острый бронхит', year: 2021 })).toBe('Минздрав РФ. Острый бронхит, 2021');
    // название с точкой в конце, как в рубрикаторе, — перед годом без неё
    expect(sourceLine({ kind: 'guideline', org: 'Минздрав РФ', title: 'Ожоги термические и химические. Ожоги солнечные. Ожоги дыхательных путей.', year: 2025 }))
      .toBe('Минздрав РФ. Ожоги термические и химические. Ожоги солнечные. Ожоги дыхательных путей, 2025');
    expect(sourceLine({ kind: 'paper', title: 'Call SA et al. Does this patient have influenza? JAMA 2005;293(8):987–997', year: 2005 }))
      .toBe('Call SA et al. Does this patient have influenza? JAMA 2005;293(8):987–997');
  });
});
