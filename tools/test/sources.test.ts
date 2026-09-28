// Источники базы (ADR 0008, 05-content.md): клинические рекомендации Минздрава сверены с
// рубрикатором cr.minzdrav.gov.ru — у каждой ссылки ссылка на карточку «код_версия», год
// публикации и отметка о сверке. Сама сверка по сети — tools/content/clinrecs.ts.
import { describe, expect, test } from 'bun:test';
import { minzdravSources } from '../content/clinrecs';

const CARD = /^https:\/\/cr\.minzdrav\.gov\.ru\/view-cr\/(\d+_\d+)$/;

describe('источники: рекомендации Минздрава', () => {
  const cited = [...minzdravSources().values()];

  test('их два десятка с лишним — сверять есть что', () => {
    expect(cited.length).toBeGreaterThanOrEqual(20);
  });

  test('у каждой — карточка рубрикатора, год публикации и отметка о сверке с тем же ID', () => {
    for (const s of cited) {
      const id = CARD.exec(s.url ?? '')?.[1];
      expect({ title: s.title, card: !!id }).toEqual({ title: s.title, card: true });
      expect({ title: s.title, year: Number.isInteger(s.year) && (s.year ?? 0) >= 2015 }).toEqual({ title: s.title, year: true });
      expect({ title: s.title, note: !!s.note?.startsWith(`ID ${id}, опубликованы `) && s.note.includes('сверено с рубрикатором') }).toEqual({ title: s.title, note: true });
    }
  });

  test('одна рекомендация — одно название и один ID во всей базе', () => {
    const byUrl = new Map<string, Set<string>>();
    const byTitle = new Map<string, Set<string>>();
    for (const s of cited) {
      byUrl.set(s.url ?? '', new Set([...(byUrl.get(s.url ?? '') ?? []), s.title]));
      byTitle.set(s.title, new Set([...(byTitle.get(s.title) ?? []), s.url ?? '']));
    }
    for (const [url, titles] of byUrl) expect({ url, titles: [...titles] }).toEqual({ url, titles: [[...titles][0]] });
    for (const [title, urls] of byTitle) expect({ title, urls: [...urls] }).toEqual({ title, urls: [[...urls][0]] });
  });

  test('пометок «сверить название и редакцию» не осталось', () => {
    for (const s of cited) expect({ title: s.title, left: /редакци|сверить (действующ|на cr\.minzdrav)/.test(s.note ?? '') }).toEqual({ title: s.title, left: false });
  });
});
