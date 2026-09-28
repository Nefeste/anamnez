// Номер версии — во всех местах (08-process.md, «Версия»): app.json, package.json,
// package-lock.json и в игре; у версии есть раздел в README.md и «Что нового» в «Об игре» —
// из этого раздела.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { about } from '../../src/i18n/sections/about';
import { VERSION } from '../../src/info';

const ROOT = join(import.meta.dir, '../..');
const json = (f: string) => JSON.parse(readFileSync(join(ROOT, f), 'utf8'));

describe('версия', () => {
  test('одна и та же в app.json, package.json, package-lock.json и в игре', () => {
    const app = json('app.json').expo;
    const lock = json('package-lock.json');
    expect(json('package.json').version).toBe(app.version);
    expect(lock.version).toBe(app.version);
    expect(lock.packages[''].version).toBe(app.version);
    expect(VERSION).toBe(app.version);
    expect(Number.isInteger(app.android.versionCode) && app.android.versionCode > 0).toBe(true);
  });

  test('у версии — раздел в README.md и «Что нового» в «Об игре»', () => {
    expect(readFileSync(join(ROOT, 'README.md'), 'utf8')).toContain(`### ${VERSION} — `);
    expect(about.news.length).toBeGreaterThan(0);
  });

  test('«Что нового» — из раздела этой версии в README.md, а не из прошлой', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const start = readme.indexOf(`### ${VERSION} — `);
    const end = readme.indexOf('\n### ', start + 1);
    const section = readme.slice(start, end < 0 ? undefined : end).replace(/\s+/g, ' ');
    for (const item of about.news) {
      const head = item.split(/\s+/).slice(0, 5).join(' ');
      expect({ head, inReadme: section.includes(head) }).toEqual({ head, inReadme: true });
    }
  });
});
