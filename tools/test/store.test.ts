// Материалы магазина и сайта (store/, docs/11-publishing.md §2–§3, §8): длины текстов,
// ни чужих игр, ни брендов лекарств, ни обещаний медицинского приложения; оговорка на
// месте; иконка и снимки нужных размеров, иконка магазина без прозрачности.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRIVACY_URL, SUPPORT_EMAIL } from '../../src/info';
import { CAPTIONS } from '../store/captions';

const STORE = join(import.meta.dir, '../../store');
const ASSETS = join(import.meta.dir, '../../assets');
const read = (f: string) => readFileSync(join(STORE, f), 'utf8');

/** Текст в рамке ``` сразу после заголовка «## …» — то, что вставляется в поле консоли. */
function field(md: string, heading: string): string {
  const at = md.indexOf(`## ${heading}\n`);
  expect(at).toBeGreaterThanOrEqual(0);
  const open = md.indexOf('```\n', at);
  const close = md.indexOf('\n```', open + 4);
  return md.slice(open + 4, close);
}

/** Размер и тип цвета PNG — из заголовка IHDR (тип 2 — RGB, 6 — RGBA). */
function png(file: string): { w: number; h: number; alpha: boolean } {
  const b = readFileSync(file);
  expect(b.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), alpha: b[25] === 6 || b[25] === 4 };
}

const TEXTS = ['listing.ru.md', 'forms.md', 'privacy.ru.md', 'privacy.en.md', 'site/anamnez.ru.md', 'site/press.ru.md'];

// чужие игры, сериалы и прошлые прототипы (11-publishing.md §2), бренды лекарств (ADR 0012)
const FORBIDDEN = [
  /project hospital/i, /two point/i, /theme hospital/i, /prognosis/i, /\bAda\b/, /clinicsim/i,
  /доктор хаус/i, /интерны/i, /склифосовск/i, /земский доктор/i,
  /аспирин/i, /нурофен/i, /амоксиклав/i, /сумамед/i, /арбидол/i, /кагоцел/i, /но-?шп/i, /терафлю/i, /колдрекс/i,
];
// обещания медицинского приложения (11-publishing.md §3)
const CLAIMS = [/научит ставить диагноз/i, /тренаж[её]р для врач/i, /провер\S* свои симптом/i, /справочник болезней/i, /поставит диагноз/i];
const DISCLAIMER = 'Игра. Не является медицинским изделием и не заменяет консультацию врача.';

describe('store: тексты', () => {
  const listing = read('listing.ru.md');

  test('длины полей карточки: название ≤ 30, краткое ≤ 80, полное ≤ 4000, «Что нового» ≤ 500', () => {
    expect(field(listing, 'Название').length).toBeLessThanOrEqual(30);
    const short = field(listing, 'Краткое описание');
    expect(short.length).toBeGreaterThan(20);
    expect(short.length).toBeLessThanOrEqual(80);
    expect(field(listing, 'Полное описание').length).toBeLessThanOrEqual(4000);
    expect(field(listing, 'Что нового').length).toBeLessThanOrEqual(500);
  });

  test('оговорка — в полном описании и на странице сайта', () => {
    expect(field(listing, 'Полное описание').trimEnd().endsWith(DISCLAIMER)).toBe(true);
    expect(read('site/anamnez.ru.md')).toContain(DISCLAIMER);
    expect(read('site/press.ru.md')).toContain(DISCLAIMER);
  });

  test('ни чужих игр и брендов, ни обещаний медицинского приложения', () => {
    for (const f of TEXTS) {
      const text = read(f);
      for (const re of [...FORBIDDEN, ...CLAIMS]) expect({ file: f, found: re.test(text) ? re.source : null }).toEqual({ file: f, found: null });
    }
  });

  test('почта поддержки — везде та же, что в игре; в карточке и политике нет заглушек «⟨…⟩»', () => {
    for (const f of TEXTS) expect({ file: f, has: read(f).includes(SUPPORT_EMAIL) }).toEqual({ file: f, has: true });
    expect(listing).toContain(PRIVACY_URL);
    // карточка и политика уходят в магазин и на сайт как есть; на страницах сайта ждёт
    // ссылка на карточку RuStore — её вписывают, когда карточка появится
    for (const f of ['listing.ru.md', 'privacy.ru.md', 'privacy.en.md']) {
      expect({ file: f, placeholder: read(f).match(/⟨[^⟩]*⟩/)?.[0] ?? null }).toEqual({ file: f, placeholder: null });
    }
  });

  test('подписи снимков в карточке — те же, что на картинках', () => {
    for (const { file, caption } of CAPTIONS) expect(listing).toContain(`\`${file}\` — «${caption.replace('\n', ' ')}»`);
  });
});

describe('store: картинки', () => {
  test('иконка магазина — 512 × 512 без прозрачности', () => {
    expect(png(join(STORE, 'icon/icon-512.png'))).toEqual({ w: 512, h: 512, alpha: false });
  });

  test('снимки экрана — все по списку, 1080 × 1920, от 4 до 8', () => {
    const files = readdirSync(join(STORE, 'screenshots/phone')).filter(f => f.endsWith('.png')).sort();
    expect(files).toEqual(CAPTIONS.map(c => c.file));
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files.length).toBeLessThanOrEqual(8);
    for (const f of files) expect(png(join(STORE, 'screenshots/phone', f))).toMatchObject({ w: 1080, h: 1920 });
  });

  test('графика: 1024 × 500 и обложка 1920 × 1080', () => {
    expect(png(join(STORE, 'graphics/feature-1024x500.png'))).toMatchObject({ w: 1024, h: 500 });
    expect(png(join(STORE, 'graphics/cover-1920x1080.png'))).toMatchObject({ w: 1920, h: 1080 });
  });

  test('иконки приложения: 1024 без прозрачности; слои адаптивной — знак прозрачный', () => {
    expect(png(join(ASSETS, 'icon.png'))).toEqual({ w: 1024, h: 1024, alpha: false });
    expect(png(join(ASSETS, 'adaptive-icon.png'))).toEqual({ w: 1024, h: 1024, alpha: true });
    expect(png(join(ASSETS, 'adaptive-icon-monochrome.png'))).toEqual({ w: 1024, h: 1024, alpha: true });
    expect(png(join(ASSETS, 'adaptive-icon-background.png'))).toEqual({ w: 1024, h: 1024, alpha: false });
    const app = JSON.parse(readFileSync(join(import.meta.dir, '../../app.json'), 'utf8')).expo;
    expect(app.icon).toBe('./assets/icon.png');
    expect(app.android.adaptiveIcon.foregroundImage).toBe('./assets/adaptive-icon.png');
    expect(app.android.adaptiveIcon.monochromeImage).toBe('./assets/adaptive-icon-monochrome.png');
  });
});
