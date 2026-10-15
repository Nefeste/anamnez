// Золотые случаи (`docs/06-testing.md` §2): отпечаток тысячи пациентов и результатов их
// обследований. Меняется генератор, модель или база — тест падает, и это заметили.
// Пересоздать сознательно: ANAMNEZ_GOLDEN=write bun test tools/test/golden.test.ts
import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { goldenRun, inferenceRun } from '../../src/engine/med/golden';
import { buildDb } from '../content/load';

const FIXTURE = join(import.meta.dir, 'fixtures/golden.json');
/** пациентов в отпечатке вывода */
const INFERENCE = 40;

describe('золотые случаи', () => {
  test('тысяча пациентов и их обследования дают записанный отпечаток', () => {
    const { db } = buildDb();
    const run = goldenRun(db, 1000);
    if (process.env.ANAMNEZ_GOLDEN === 'write') {
      // и отпечаток вывода (0.5.11) — он пересоздаётся вместе с золотыми случаями
      writeFileSync(FIXTURE, `${JSON.stringify({ contentHash: db.hash, ...run, inference: inferenceRun(db, INFERENCE) }, null, 2)}\n`);
      console.log(`записано: ${run.hash}`);
    }
    const saved = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    if (saved.contentHash !== db.hash) console.warn(`база изменилась (${saved.contentHash} → ${db.hash}): если это нарочно — пересоздайте отпечаток`);
    expect(run.hash).toBe(saved.hash);
    expect(run.primaries).toEqual(saved.primaries);
  }, 30_000);

  test('вывод разумного врача: уверенность на каждом шаге и польза каждого обследования дают записанный отпечаток (0.5.11)', () => {
    const { db } = buildDb();
    expect(inferenceRun(db, INFERENCE)).toBe(JSON.parse(readFileSync(FIXTURE, 'utf8')).inference);
  }, 60_000);
});
