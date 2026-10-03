// Состояние проекта — только в STATUS.md (устав студии, docs/04-process.md, «Состояние — только в
// STATUS.md»): не длиннее 30 строк, версия — та же, что в package.json; README.md и AGENTS.md
// ссылаются на него и строку состояния не повторяют.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');

describe('STATUS.md', () => {
  test('не длиннее 30 строк', () => {
    expect(read('STATUS.md').trimEnd().split('\n').length).toBeLessThanOrEqual(30);
  });

  test('версия — из package.json', () => {
    const version: string = JSON.parse(read('package.json')).version;
    const line = read('STATUS.md').match(/^\*\*Версия:\*\* (\d+\.\d+\.\d+)/m);
    expect(line?.[1]).toBe(version);
  });

  test('README.md и AGENTS.md ссылаются на STATUS.md и состояние не повторяют', () => {
    for (const f of ['README.md', 'AGENTS.md']) {
      const text = read(f);
      expect({ f, link: text.includes('STATUS.md') }).toEqual({ f, link: true });
      // прежние строки состояния: «Current stage: …» в AGENTS.md, «**Этап N — …** сделан» в README.md
      expect({ f, stale: /Current stage:|^\*\*Этап \d/m.test(text) }).toEqual({ f, stale: false });
    }
  });
});
