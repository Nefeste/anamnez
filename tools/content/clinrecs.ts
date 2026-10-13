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

// «й» в рубрикаторе бывает записана двумя знаками — «и» и кратка (у 382_2): сравнивают после NFC; точку между частями
// названия список рубрикатора теряет (у 784_1 — «…алкоголя Синдром отмены…», в документе — с точкой): сравнивают без точек
const norm = (s: string) => s.normalize('NFC').replace(/\./g, ' ').replace(/\s+/g, ' ').replace(/ё/g, 'е').trim().toLowerCase();

type Source = { org?: string; title: string; url?: string; year?: number; note?: string };
export type Cited = { title: string; url?: string; year?: number; note?: string; files: string[] };

/** Каждая ссылка на рекомендацию в файлах базы — всех разделов, и тех, что в собранную базу не входят (факторы риска). */
export function minzdravCitations(dir = CONTENT_DIR): (Source & { file: string })[] {
  const walk = (d: string): string[] => readdirSync(d).flatMap(n => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : n.endsWith('.yaml') ? [join(d, n)] : []));
  return walk(dir).flatMap(file => {
    const doc = parse(readFileSync(file, 'utf8')) as { sources?: Source[] } | null;
    return (doc?.sources ?? []).filter(s => s.org === 'Минздрав РФ').map(s => ({ ...s, file: relative(dir, file) }));
  });
}

/** Те же ссылки, по одной на рекомендацию: у повторов — список файлов, текст — из последнего прочитанного. */
export function minzdravSources(dir = CONTENT_DIR): Map<string, Cited> {
  const out = new Map<string, Cited>();
  for (const { file, ...s } of minzdravCitations(dir)) {
    const key = `${s.url ?? ''}|${s.title}`;
    const had = out.get(key);
    out.set(key, { title: s.title, url: s.url, year: s.year, note: s.note, files: [...(had?.files ?? []), file] });
  }
  return out;
}

/** Список рубрикатора — около 0,5 МБ, и ответ бывает оборван на полуслове: тогда запрос повторяют, до трёх раз. */
async function clinrecs(): Promise<Clinrec[]> {
  for (let i = 1; ; i++) {
    const text = await (await fetch(LIST)).text();
    try {
      return JSON.parse(text) as Clinrec[];
    } catch (e) {
      if (i >= 3) throw new Error(`список рубрикатора не разобран за ${i} попытки: ${(e as Error).message}`);
    }
  }
}

if (import.meta.main) {
  const recs = await clinrecs();
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
