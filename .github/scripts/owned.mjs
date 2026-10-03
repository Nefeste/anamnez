// из votchina: .github/scripts/owned.mjs @ 0605847
// Какие файлы PR задевают пути владельца из .github/CODEOWNERS (automerge.yml).
// Понимает то подмножество синтаксиса CODEOWNERS, которое в файле используется: путь от корня
// («/»), папка («/» в конце), «*» внутри имени, «**» через папки. Строка, которую разобрать
// нельзя, — ошибка: лучше не слить PR, чем слить его мимо владельца.
//
//   node .github/scripts/owned.mjs .github/CODEOWNERS < files.txt   → печатает задетые пути
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Шаблоны из текста CODEOWNERS: первое слово каждой непустой строки без комментария. */
export function ownedPatterns(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!owners.length) throw new Error(`CODEOWNERS: у «${pattern}» нет владельца`);
    if (/[?[\]!\\]/.test(pattern)) throw new Error(`CODEOWNERS: шаблон «${pattern}» не поддерживается`);
    out.push(pattern);
  }
  return out;
}

const escape = s => s.replace(/[.+^${}()|]/g, '\\$&');

/** Шаблон CODEOWNERS → регулярное выражение для пути от корня репозитория (без «/» в начале). */
export function patternRegex(pattern) {
  const anchored = pattern.startsWith('/') || pattern.slice(0, -1).includes('/');
  let p = pattern.replace(/^\//, '');
  const dir = p.endsWith('/');
  if (dir) p = p.slice(0, -1);
  const body = p.split('/').map(seg => seg === '**' ? '(?:.*)' : escape(seg).replace(/\*/g, '[^/]*')).join('/')
    .replace(/\/\(\?:\.\*\)\//g, '(?:/.*)?/');
  // папка — всё внутри; файл или шаблон без «/» в конце — сам путь и всё под ним, как у GitHub
  return new RegExp(`${anchored ? '^' : '(?:^|/)'}${body}${dir ? '/' : '(?:$|/)'}`);
}

/** Файлы из списка, которые задевают пути владельца. */
export function ownedFiles(files, patterns) {
  const res = patterns.map(patternRegex);
  return files.filter(f => f && res.some(r => r.test(f.replace(/^\//, ''))));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const patterns = ownedPatterns(readFileSync(process.argv[2] ?? '.github/CODEOWNERS', 'utf8'));
  const files = readFileSync(0, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  for (const f of ownedFiles(files, patterns)) console.log(f);
}
