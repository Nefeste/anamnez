// Ссылки в документах живые (ответ владельца на вопрос 10, Nefeste/anamnez#77: «проверь чтобы не было сломанных
// ссылок после правки»): относительная ссылка из .md ведёт на файл или папку репозитория, а якорь — на заголовок того
// файла. Прежних имён документов — до нумерации по уставу 15.10.2026 — нет нигде, кроме текста журнала: журнал не
// переписывается, у него правятся только адреса ссылок.
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const SKIP = new Set(['node_modules', '.git', '.expo', 'dist', 'dist-web', 'android', 'ios', 'generated']);

function walk(dir: string, keep: (file: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, keep, out);
    else if (keep(path)) out.push(path);
  }
  return out;
}

/** Текст без блоков кода: в них ссылки и заголовки — не настоящие. */
const prose = (md: string) => md.replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm, '');

/** Якорь заголовка, как его делает GitHub: текст ссылок, строчные, без знаков, пробел — дефис; повтор — с номером. */
function anchors(md: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const [, heading] of prose(md).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = heading.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '').replace(/ /g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

const docs = walk(ROOT, f => f.endsWith('.md'));
const cache = new Map<string, Set<string>>();
const anchorsOf = (file: string) => {
  if (!cache.has(file)) cache.set(file, anchors(readFileSync(file, 'utf8')));
  return cache.get(file)!;
};

describe('ссылки в документах', () => {
  test('документов много — обход нашёл их', () => {
    expect(docs.length).toBeGreaterThan(60);
  });

  test('относительная ссылка ведёт на файл, якорь — на заголовок', () => {
    const broken: string[] = [];
    for (const file of docs) {
      for (const [, target] of prose(readFileSync(file, 'utf8')).matchAll(/\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)) {
        if (/^[a-z][a-z+.-]*:/i.test(target)) continue; // https:, mailto: и другие адреса вне репозитория
        const [path, hash] = target.split('#');
        const dest = path === '' ? file : join(dirname(file), decodeURIComponent(path));
        const where = `${relative(ROOT, file)} → ${target}`;
        if (!existsSync(dest)) { broken.push(where); continue; }
        if (hash !== undefined && dest.endsWith('.md') && !anchorsOf(dest).has(decodeURIComponent(hash).toLowerCase())) {
          broken.push(`${where} (нет такого заголовка)`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});

describe('прежние имена документов', () => {
  const OLD = ['02-requirements', '03-game-design', '04-medical-model', '05-content', '06-architecture', '07-data-model',
    '08-process', '09-testing', '10-roadmap', '11-publishing'];
  const old = new RegExp(`\\b(${OLD.join('|')})\\b`);
  const TEXT = /\.(md|ts|tsx|js|mjs|cjs|json|ya?ml)$/;

  test('нет нигде, кроме журнала', () => {
    const files = walk(ROOT, f => TEXT.test(f) && !f.endsWith('package-lock.json') && f !== import.meta.path);
    const left = files
      .filter(f => !relative(ROOT, f).startsWith(join('docs', 'journal')))
      .flatMap(f => readFileSync(f, 'utf8').split('\n').flatMap((line, i) =>
        old.test(line) ? [`${relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 100)}`] : []));
    expect(left).toEqual([]);
  });
});
