// Номер версии — во всех местах (05-process.md, «Версия»): app.json, package.json,
// package-lock.json и в игре; у версии есть раздел в README.md и «Что нового» в «Об игре» —
// из этого раздела.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { about } from '../../src/i18n/sections/about';
import { VERSION } from '../../src/info';

const ROOT = join(import.meta.dir, '../..');
const json = (f: string) => JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
/** Раздел версии в README.md одной строкой. */
function sectionOf(version: string): string {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const start = readme.indexOf(`### ${version} — `);
  const end = readme.indexOf('\n### ', start + 1);
  return readme.slice(start, end < 0 ? undefined : end).replace(/\s+/g, ' ');
}

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
    const section = sectionOf(VERSION);
    for (const item of about.news) {
      const head = item.split(/\s+/).slice(0, 5).join(' ');
      expect({ head, inReadme: section.includes(head) }).toEqual({ head, inReadme: true });
    }
  });

  // 1.1.7 (просьба владельца 01.11.2026): прежние версии под «Что нового» — новые сверху, до первого выпуска, каждая —
  // из своего раздела в README.md
  test('прежние версии — по убыванию, без этой, до 1.0.0; строки — из их разделов в README.md', () => {
    const versions = about.newsBefore.map(v => v.version);
    const num = (v: string) => v.split('.').reduce((n, x) => n * 1000 + Number(x), 0);
    expect(versions).not.toContain(VERSION);
    expect(num(versions[0])).toBeLessThan(num(VERSION));
    expect(versions).toEqual([...versions].sort((a, b) => num(b) - num(a)));
    expect(versions[versions.length - 1]).toBe('1.0.0');
    for (const v of about.newsBefore) {
      expect(readFileSync(join(ROOT, 'README.md'), 'utf8')).toContain(`### ${v.version} — ${v.title} (`);
      const section = sectionOf(v.version);
      for (const item of v.items) {
        const head = item.split(/\s+/).slice(0, 5).join(' ');
        expect({ v: v.version, head, inReadme: section.includes(head) }).toEqual({ v: v.version, head, inReadme: true });
      }
    }
  });
});
