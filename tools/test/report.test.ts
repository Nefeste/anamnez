// «Сообщить об ошибке» (src/state/report.ts, errors.ts): в тексте — версия игры и базы,
// телефон, практика с зерном, последние сбои и журнал дня, по которому день переигрывается.
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { apply, newShift } from '../../src/engine/shift/engine';
import { forgetErrors, installErrorLog, recentErrors, recordError } from '../../src/state/errors';
import { buildReport } from '../../src/state/report';
import { memoryStore } from '../../src/state/saves';

beforeEach(() => forgetErrors());

describe('отчёт об ошибке', () => {
  test('версия, база, телефон, практика с зерном, журнал дня — одной строкой JSON', () => {
    const s = newShift(db, { seed: 42, season: 'winter', difficulty: 'student' });
    apply(db, s, { kind: 'advance', seconds: 30 * 60 });
    const text = buildReport({ description: 'Карта не открылась', version: '0.0.17', build: 17, device: 'Pixel 7, Android 14', db, shift: s, clock: '08:30', errors: [] });
    const lines = text.split('\n');
    expect(lines[0]).toBe('Карта не открылась');
    expect(text).toContain('Анамнез 0.0.17, сборка 17');
    expect(text).toContain(`Медицинская база: версия ${db.contentVersion} (${db.hash})`);
    expect(text).toContain('Телефон: Pixel 7, Android 14');
    expect(text).toContain('Практика: день 1, 08:30, «Студент»; зерно 42, схема');
    expect(text).toContain('Сбоев не было');
    expect(JSON.parse(lines[lines.length - 1])).toEqual(s.journal);
  });

  test('без описания и без практики — так и сказано', () => {
    const text = buildReport({ description: '  ', version: '0.0.17', build: 17, device: 'web', db, errors: [] });
    expect(text.startsWith('(описания нет)')).toBe(true);
    expect(text).toContain('Практики нет');
    expect(text).not.toContain('Журнал дня');
  });
});

describe('журнал сбоев', () => {
  test('последние пять, новые первыми; переживают перезапуск', async () => {
    const store = memoryStore();
    await installErrorLog(store);
    for (let i = 1; i <= 7; i++) recordError(new Error(`сбой ${i}`), i === 7, new Date(Date.UTC(2026, 8, 27, 12, i)));
    expect(recentErrors().map(e => e.message.split(' — ')[0])).toEqual(['Error: сбой 7', 'Error: сбой 6', 'Error: сбой 5', 'Error: сбой 4', 'Error: сбой 3']);
    expect(recentErrors()[0].fatal).toBe(true);
    await new Promise(r => setTimeout(r, 10));
    forgetErrors();
    await installErrorLog(store);
    expect(recentErrors().length).toBe(5);
    const text = buildReport({ description: '', version: '0.0.17', build: 17, device: 'web', db, errors: recentErrors() });
    expect(text).toContain('Последние сбои:');
    expect(text).toContain('(игра закрылась): Error: сбой 7');
  });
});
