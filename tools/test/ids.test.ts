// Идентификаторы базы вечные (ADR 0011): ни один выпущенный не исчез — на них ссылаются
// сохранения, архив приёмов и разборы. Список выпущенных — tools/test/fixtures/released-ids.json.
// Каждое слияние в main — выпуск (08-process.md), поэтому в списке и всё, что есть в базе сейчас:
// появилась запись — `bun tools/content/released-ids.ts`.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { idsOf, readReleased } from '../content/released-ids';

const released = readReleased();
const now = idsOf(db);

describe('вечные идентификаторы', () => {
  test('ни один выпущенный не исчез', () => {
    const gone = Object.entries(released.ids).flatMap(([table, ids]) => ids.filter(id => !now[table]?.includes(id)).map(id => `${table}: ${id}`));
    expect(gone).toEqual([]);
  });

  test('список дописан по нынешней базе: новые записи — в нём (bun tools/content/released-ids.ts)', () => {
    const fresh = Object.entries(now).flatMap(([table, ids]) => ids.filter(id => !released.ids[table]?.includes(id)).map(id => `${table}: ${id}`));
    expect(fresh).toEqual([]);
    expect(released.base).toBe(db.contentVersion);
  });

  test('в списке — болезни, признаки, обследования, лечение, больница и кампания; вложенные — с родителем', () => {
    for (const table of ['conditions', 'findings', 'exams', 'treatments', 'risks', 'rooms', 'equipment', 'roles', 'presets', 'chapters', 'tips', 'achievements']) {
      expect(released.ids[table]?.length ?? 0).toBeGreaterThan(0);
    }
    expect(released.ids['rooms.sizes']).toContain('room.lab/M');
    expect(released.ids['conditions.stages']).toContain('cond.arvi/onset');
  });
});
