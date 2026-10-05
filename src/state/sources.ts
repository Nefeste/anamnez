// Источники медицинской базы для «Об игре» (11-publishing.md §3): без повторов, по видам.
// Служебная пометка источника (`note`: что сверить, что черновик) — для авторов базы, не
// для игрока, и сюда не попадает.
import type { ContentDb, Source } from '@/content/types';

export interface SourceGroup {
  kind: Source['kind'];
  items: string[];
}

/** Порядок разделов: сначала рекомендации, на которых база стоит. */
const ORDER: Source['kind'][] = ['guideline', 'textbook', 'review', 'paper', 'score', 'dataset'];

/**
 * «Минздрав РФ. Название, 2024» — год, если его нет в самом названии. Название с точкой в конце, как
 * в рубрикаторе (`687_3`), — перед годом без неё: не «… путей., 2025».
 */
export function sourceLine(s: Source): string {
  const year = s.year !== undefined && !s.title.includes(String(s.year)) ? `, ${s.year}` : '';
  const title = year && s.title.endsWith('.') ? s.title.slice(0, -1) : s.title;
  return `${s.org ? `${s.org}. ` : ''}${title}${year}`;
}

export function sourceGroups(db: ContentDb): SourceGroup[] {
  const byKind = new Map<Source['kind'], Set<string>>();
  // источники есть у болезней, обследований, лечения, факторов риска, шкал и правил; у признаков — через их болезни
  const tables: Record<string, { sources: Source[] }>[] = [db.conditions, db.exams, db.treatments, db.risks, db.scores, db.rules];
  for (const table of tables) {
    for (const entry of Object.values(table)) {
      for (const s of entry.sources) {
        const set = byKind.get(s.kind) ?? new Set<string>();
        set.add(sourceLine(s));
        byKind.set(s.kind, set);
      }
    }
  }
  return ORDER.filter(k => byKind.has(k)).map(kind => ({ kind, items: [...(byKind.get(kind) ?? [])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) }));
}
