// Страница игры на gornitsa.games — store/site/page.ru.md и page.en.md (устав студии
// Nefeste/gornitsa: docs/08-publishing.md, раздел «Сайт»; ADR студии 0015). Те же правила
// проверяет сайт (tools/games.py в Nefeste/gornitsagames): папку, которая здесь не проходит,
// он пропустит и напишет причину в свой PR.
// Файл одинаковый во всех играх студии (ADR студии 0002 — копия с пометкой источника):
// правило меняется сначала в уставе, потом в сайте и здесь, во всех играх сразу.
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parse } from 'yaml';

const STORE = resolve(import.meta.dir, '../../store');

const LIMITS: Record<string, number> = {
  name: 40, title: 60, description: 220, kind: 40, lead: 160, caption: 30, alt: 160,
  'card.text': 240, 'card.points': 80, 'links.text': 40, note: 200,
};
const STATUS = ['dev', 'test', 'live'];

/** Ширина и высота PNG или WebP — из заголовка файла, без библиотек. */
export function imageSize(file: string): { w: number; h: number } | null {
  const b = readFileSync(file);
  if (b.subarray(1, 4).toString('latin1') === 'PNG') return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.subarray(0, 4).toString('latin1') !== 'RIFF' || b.subarray(8, 12).toString('latin1') !== 'WEBP') return null;
  const chunk = b.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const [b0, b1, b2, b3] = [b[21], b[22], b[23], b[24]];
    return { w: 1 + (((b1 & 0x3f) << 8) | b0), h: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
  }
  if (chunk === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  return null;
}

const near = (a: number, b: number) => Math.abs(a - b) <= 0.02 * b;
const urlOk = (u: string) => u.startsWith('https://') || u.startsWith('mailto:');
const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

type Page = { meta: Record<string, any>; body: string; line: number };

function readPage(file: string): Page {
  const text = readFileSync(file, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${file}: нет полей между строками --- в начале файла`);
  const meta = parse(m[1]) ?? {};
  return { meta, body: m[2], line: text.slice(0, text.length - m[2].length).split('\n').length };
}

/** Все нарушения формата — списком, как их пишет сайт. */
export function check(page: Page, store = STORE): string[] {
  const { meta, body } = page;
  const errs: string[] = [];
  const text = (key: string, v: unknown, need = true) => {
    if (v === undefined || v === null || v === '') {
      if (need) errs.push(`нет поля ${key}`);
      return;
    }
    if (typeof v !== 'string') errs.push(`${key} — не строка`);
    else if (v.length > LIMITS[key]) errs.push(`${key}: ${v.length} знаков, можно до ${LIMITS[key]}`);
    else if (/<[A-Za-z/!]/.test(v)) errs.push(`${key}: HTML не пропускается`);
  };
  const links = (key: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (!Array.isArray(v)) return void errs.push(`${key} — не список`);
    v.forEach((l, i) => {
      if (!l || typeof l !== 'object' || !l.text || !l.url) return void errs.push(`${key} ${i + 1}: нужны text и url`);
      text('links.text', l.text);
      if (!urlOk(String(l.url))) errs.push(`${key} ${i + 1}: ссылка ${l.url} — только https:// или mailto:`);
    });
  };
  const image = (key: string, rel: unknown, ok: (w: number, h: number) => string | null) => {
    if (!rel || typeof rel !== 'string') return void errs.push(`нет поля ${key}`);
    const p = resolve(store, rel);
    if (relative(store, p).startsWith('..') || !existsSync(p) || !statSync(p).isFile())
      return void errs.push(`${key}: нет файла store/${rel}`);
    const size = /\.(png|webp)$/i.test(p) ? imageSize(p) : null;
    if (!size) return void errs.push(`${key}: store/${rel} — нужен PNG или WebP`);
    const msg = ok(size.w, size.h);
    if (msg) errs.push(`${key}: store/${rel} ${size.w} × ${size.h} — ${msg}`);
  };

  for (const key of ['name', 'title', 'description', 'kind', 'lead']) text(key, meta[key]);
  text('note', meta.note, false);
  if (!STATUS.includes(meta.status)) errs.push(`status: ${JSON.stringify(meta.status)} — нужно dev, test или live`);
  links('links', meta.links);
  image('icon', meta.icon, (w, h) => (w === h && w >= 192 ? null : 'нужен квадрат от 192 × 192'));
  image('feature', meta.feature, (w, h) => (near(w / h, 1024 / 500) && w >= 1024 ? null : 'нужно 1024 × 500'));
  if (meta.og) image('og', meta.og, (w, h) => (w >= 1200 && h >= 630 ? null : 'нужно не меньше 1200 × 630'));

  const shots = Array.isArray(meta.shots) ? meta.shots : [];
  if (shots.length < 3 || shots.length > 8) errs.push('shots: нужно от 3 до 8 снимков');
  const forms = new Set<string>();
  shots.forEach((s: any, i: number) => {
    if (!s || typeof s !== 'object') return void errs.push(`снимок ${i + 1}: нужны file, caption и alt`);
    text('caption', s.caption);
    text('alt', s.alt);
    image(`снимок ${i + 1}`, s.file, (w, h) => {
      if (near(w / h, 9 / 16) && w >= 540) forms.add('portrait');
      else if (near(w / h, 16 / 9) && h >= 540) forms.add('landscape');
      else return 'нужно 9 : 16 от 540 × 960 или 16 : 9 от 960 × 540';
      return null;
    });
  });
  if (forms.size > 1) errs.push('shots: снимки разной формы — нужны все 9 : 16 или все 16 : 9');

  const card = meta.card;
  if (!card || typeof card !== 'object') errs.push('нет поля card');
  else {
    text('card.text', card.text);
    if (!Array.isArray(card.points) || card.points.length < 2 || card.points.length > 4)
      errs.push('card.points: нужно от 2 до 4 пунктов');
    else for (const p of card.points) text('card.points', p);
    links('card.links', card.links);
  }

  body.split('\n').forEach((l, i) => {
    const n = page.line + i;
    if (/<[A-Za-z/!]/.test(l)) errs.push(`строка ${n}: HTML не пропускается`);
    if (l.includes('![')) errs.push(`строка ${n}: картинок в тексте нет — снимки идут в shots`);
    if (l.trimStart().startsWith('|')) errs.push(`строка ${n}: таблиц нет`);
    if (/^#(?!##? )|^####/.test(l)) errs.push(`строка ${n}: заголовки — только ## и ###`);
    for (const m of l.matchAll(LINK)) if (!urlOk(m[2])) errs.push(`строка ${n}: ссылка ${m[2]} — только https:// или mailto:`);
  });
  if (!body.trim()) errs.push('нет текста страницы');
  return errs;
}

describe('store/site/ — страница игры на сайте', () => {
  for (const lang of ['ru', 'en']) {
    const file = join(STORE, 'site', `page.${lang}.md`);
    if (lang === 'en' && !existsSync(file)) continue;
    test(`page.${lang}.md по формату устава`, () => {
      expect(existsSync(file)).toBe(true);
      expect(check(readPage(file))).toEqual([]);
    });
  }

  test('проверка ловит нарушения', () => {
    const bad = check({ meta: { status: 'beta', shots: [{ file: 'nope.png' }] }, body: '<b>x</b>\n# Заголовок\n[a](http://x)', line: 1 });
    for (const part of ['нет поля name', 'status', 'снимок 1: нет файла', 'HTML', 'заголовки', 'http://x', 'нет поля card'])
      expect(bad.some((e) => e.includes(part))).toBe(true);
  });
});
