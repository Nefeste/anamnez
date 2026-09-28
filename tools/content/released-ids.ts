// Выпущенные идентификаторы базы (ADR 0011): их не удаляют и не переименовывают — на них
// ссылаются сохранения, архив приёмов и разборы. При каждом выпуске список дополняется
// идентификаторами нынешней базы (`bun tools/content/released-ids.ts`, чек-лист релиза в
// 08-process.md); tools/test/ids.test.ts падает, если какой-то из выпущенных исчез.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentDb } from '../../src/content/types';
import { buildDb } from './load';

export const RELEASED = join(import.meta.dir, '../test/fixtures/released-ids.json');

export interface Released {
  /** последняя версия, чьи идентификаторы вписаны */
  version: string;
  /** её база */
  base: number;
  ids: Record<string, string[]>;
}

const isRow = (x: unknown): x is { id: string } & Record<string, unknown> =>
  typeof x === 'object' && x !== null && typeof (x as { id?: unknown }).id === 'string';

/**
 * Вложенные списки со своими `id`, на которые ссылаются сохранения: стадия болезни — у
 * пациента, размер — у построенного помещения, задания и письма — в ходе кампании. Ссылки на
 * другие записи (факторы риска у болезни, противопоказания у лечения) — не свои id: их правят
 * вместе с записью.
 */
const NESTED: Record<string, readonly string[]> = { conditions: ['stages'], rooms: ['sizes'], chapters: ['missions', 'letters'] };

/**
 * Таблицы базы из записей с собственным `id` — всё, на что может сослаться сохранение, — и
 * вложенные списки из NESTED: они записаны как `родитель/свой id` в таблице `таблица.поле`.
 */
export function idsOf(db: ContentDb): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (table: string, id: string) => (out[table] ??= []).push(id);
  for (const [table, rows] of Object.entries(db)) {
    if (!rows || typeof rows !== 'object' || Array.isArray(rows)) continue;
    for (const [id, row] of Object.entries(rows as Record<string, unknown>)) {
      if (!isRow(row) || row.id !== id) continue;
      add(table, id);
      for (const field of NESTED[table] ?? []) {
        const list = row[field];
        if (Array.isArray(list)) for (const x of list) if (isRow(x)) add(`${table}.${field}`, `${id}/${x.id}`);
      }
    }
  }
  for (const ids of Object.values(out)) ids.sort();
  return out;
}

export const readReleased = (): Released => JSON.parse(readFileSync(RELEASED, 'utf8')) as Released;

if (import.meta.main) {
  const { db } = buildDb();
  const version = (JSON.parse(readFileSync(join(import.meta.dir, '../../package.json'), 'utf8')) as { version: string }).version;
  const was = readReleased();
  const now = idsOf(db);
  const ids: Record<string, string[]> = {};
  for (const table of [...new Set([...Object.keys(was.ids), ...Object.keys(now)])].sort()) {
    ids[table] = [...new Set([...(was.ids[table] ?? []), ...(now[table] ?? [])])].sort();
  }
  const added = Object.entries(ids).reduce((a, [t, v]) => a + v.length - (was.ids[t]?.length ?? 0), 0);
  writeFileSync(RELEASED, `${JSON.stringify({ version, base: db.contentVersion, ids } satisfies Released, null, 2)}\n`);
  console.log(`Выпущенные идентификаторы: версия ${version}, база ${db.contentVersion}, новых ${added}.`);
}
