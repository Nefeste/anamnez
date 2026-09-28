// bun tools/content/clinrecs.ts — сверка источников базы с рубрикатором клинических
// рекомендаций Минздрава (cr.minzdrav.gov.ru): у каждой ссылки на рекомендацию — действует ли
// она, для взрослых ли, совпадает ли название, не вышла ли новая версия. Нужна сеть; в тестах
// не запускается — перед выпуском с изменённой базой (08-process.md, чек-лист).
//
// Список действующих — apicr.minzdrav.gov.ru, api.ashx?op=GetJsonClinrecs (его же читает сам
// рубрикатор); ID — «код_версия», карточка — https://cr.minzdrav.gov.ru/view-cr/<ID>.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { CONTENT_DIR } from './load';

const LIST = 'https://apicr.minzdrav.gov.ru/api.ashx?op=GetJsonClinrecs';
const CARD = /^https:\/\/cr\.minzdrav\.gov\.ru\/view-cr\/(\d+)_(\d+)$/;

interface Clinrec {
  id: string;
  code: number;
  version: number;
  name: string;
  apply_status: string;
  /** 1 — взрослые, 2 — дети, 3 — и те и другие */
  age: number;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/ё/g, 'е').trim().toLowerCase();

type Source = { org?: string; title: string; url?: string; year?: number; note?: string };
export type Cited = { title: string; url?: string; year?: number; note?: string; files: string[] };

/** Источники из файлов базы — всех разделов, и тех, что в собранную базу не входят (факторы риска). */
export function minzdravSources(dir = CONTENT_DIR): Map<string, Cited> {
  const out = new Map<string, Cited>();
  const walk = (d: string): string[] => readdirSync(d).flatMap(n => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : n.endsWith('.yaml') ? [join(d, n)] : []));
  for (const file of walk(dir)) {
    const doc = parse(readFileSync(file, 'utf8')) as { sources?: Source[] } | null;
    for (const s of doc?.sources ?? []) {
      if (s.org !== 'Минздрав РФ') continue;
      const key = `${s.url ?? ''}|${s.title}`;
      const had = out.get(key);
      out.set(key, { title: s.title, url: s.url, year: s.year, note: s.note, files: [...(had?.files ?? []), relative(dir, file)] });
    }
  }
  return out;
}

if (import.meta.main) {
  const recs = (await (await fetch(LIST)).json()) as Clinrec[];
  const byId = new Map(recs.map(r => [r.id, r]));
  const seen = minzdravSources();
  let problems = 0;
  for (const { title, url = '', files } of seen.values()) {
    const m = CARD.exec(url);
    const rec = m ? byId.get(`${m[1]}_${m[2]}`) : undefined;
    const newer = m ? recs.filter(r => r.code === Number(m[1]) && r.version > Number(m[2])) : [];
    const issues = [
      !m && 'нет ссылки на карточку рубрикатора',
      m && !rec && 'в действующих такого ID нет — архив или отозвана',
      rec && rec.apply_status !== 'Применяется' && `статус: ${rec.apply_status}`,
      rec && rec.age === 2 && 'рекомендация для детей, а пациенты игры — взрослые',
      rec && norm(rec.name) !== norm(title) && `название в рубрикаторе: «${rec.name.trim()}»`,
      newer.length > 0 && `новая версия: ${newer.map(r => r.id).join(', ')}`,
    ].filter(Boolean);
    if (issues.length > 0) problems++;
    console.log(`${issues.length ? 'НЕТ' : 'да '} ${title} — ${url || '(без ссылки)'}${issues.length ? `: ${issues.join('; ')}` : ''} (${files.length})`);
  }
  console.log(problems ? `Расходится: ${problems}` : `Всё сходится: ${seen.size}`);
  if (problems) process.exit(1);
}
