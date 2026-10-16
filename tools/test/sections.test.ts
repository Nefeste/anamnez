// «Назначить» бланком направления (spec 2026-10-patient-card, 0.6.0): у каждого обследования вкладки — раздел бланка,
// снимки — по своему кабинету, без раздела «на всякий случай»; пустых разделов нет; пункции — те, что есть в базе.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { IMAGING_ROOMS, PUNCTURES, SECTIONS, sectionOf } from '../../src/ui/case/sections';

const ordered = Object.values(db.exams).filter(e => ['lab', 'rapid', 'imaging', 'functional'].includes(e.kind));

describe('разделы бланка направления', () => {
  test('у каждого снимка — кабинет из раздела', () => {
    for (const e of ordered.filter(x => x.kind === 'imaging')) expect({ id: e.id, room: !!e.room && e.room in IMAGING_ROOMS }).toEqual({ id: e.id, room: true });
  });

  test('пункции — анализы базы', () => {
    for (const id of PUNCTURES) expect({ id, kind: db.exams[id]?.kind }).toEqual({ id, kind: 'lab' });
  });

  test('каждый раздел не пуст, лишних нет', () => {
    const used = new Set(ordered.map(sectionOf));
    expect([...used].sort()).toEqual([...SECTIONS].sort());
  });

  test('экспресс-тесты и ЭКГ, анализы — по виду', () => {
    for (const e of ordered) {
      const s = sectionOf(e);
      if (PUNCTURES.has(e.id)) continue;
      if (e.kind === 'lab') expect({ id: e.id, s }).toEqual({ id: e.id, s: 'lab' });
      if (e.kind === 'rapid' || e.kind === 'functional') expect({ id: e.id, s }).toEqual({ id: e.id, s: 'rapid' });
    }
  });
});
