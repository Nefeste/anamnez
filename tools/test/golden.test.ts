// Золотые случаи (`docs/09-testing.md` §2): отпечаток тысячи пациентов и результатов их
// обследований. Меняется генератор, модель или база — тест падает, и это заметили.
// Пересоздать сознательно: ANAMNEZ_GOLDEN=write bun test tools/test/golden.test.ts
import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { goldenRun } from '../../src/engine/med/golden';
import { buildDb } from '../content/load';

const FIXTURE = join(import.meta.dir, 'fixtures/golden.json');

describe('золотые случаи', () => {
  test('тысяча пациентов и их обследования дают записанный отпечаток', () => {
    const { db } = buildDb();
    const run = goldenRun(db, 1000);
    if (process.env.ANAMNEZ_GOLDEN === 'write') {
      writeFileSync(FIXTURE, `${JSON.stringify({ contentHash: db.hash, ...run }, null, 2)}\n`);
      console.log(`записано: ${run.hash}`);
    }
    const saved = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    if (saved.contentHash !== db.hash) console.warn(`база изменилась (${saved.contentHash} → ${db.hash}): если это нарочно — пересоздайте отпечаток`);
    expect(run.hash).toBe(saved.hash);
    expect(run.primaries).toEqual(saved.primaries);
  });
});
