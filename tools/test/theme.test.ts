// Вид игры (spec 2026-09-own-look, часть 24): контраст пар цветов обеих тем — текст не меньше
// 4,5 к 1, крупное, кнопки и украшения — не меньше 3 к 1; выделенное на плане заметно на любом
// полу; в экранах (src/app, src/ui) нет цветов мимо темы; тема — по выбору или по телефону;
// шрифты тем — в сборке и с лицензией.
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CORRIDOR, OUTSIDE, ROOM_TINT } from '../../src/render/map/metrics';
import { DARK, LIGHT, type Palette, type Theme, THEMES, themeOf } from '../../src/ui/palette';

const ROOT = join(import.meta.dir, '..', '..');

/** Относительная яркость по WCAG 2.x. */
function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5]
    .map(i => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

type Key = keyof Palette;

/** Обычный текст на фоне — не меньше 4,5 к 1. */
const TEXT: [Key, Key[]][] = [
  ['ink', ['bg', 'card', 'chip', 'fresh', 'accentSoft']],
  ['muted', ['bg', 'card', 'chip']],
  ['onAccent', ['accent']],
  ['onAccentHint', ['accent']],
  ['accent', ['bg', 'card']],
  ['info', ['bg', 'card']],
  // срочность контуром: слово цветом срочности на листе и на строке очереди
  ['red', ['bg', 'card']],
  ['green', ['bg', 'card']],
  ['yellowText', ['bg', 'card']],
  ['danger', ['bg', 'card']],
  ['onRed', ['red']],
  ['onYellow', ['yellow']],
  ['onGreen', ['green']],
];

/**
 * Крупное — буквы оценок — и то, что не текст: кнопка на фоне, поле тетради. Не меньше 3 к 1.
 * Лампа у «Пригласить» — в рамке цвета надписи (onAccent): её видно и там, где жёлтое на
 * зелёном «Монитора» сливается.
 */
const LARGE: [Key, Key[]][] = [
  ['green', ['bg', 'card', 'accentSoft']],
  ['info', ['bg', 'card', 'accentSoft']],
  ['yellowText', ['bg', 'card', 'accentSoft']],
  ['red', ['bg', 'card', 'accentSoft']],
  ['accent', ['bg', 'card']],
];

const opaque = (c: string) => /^#[0-9A-F]{6}$/i.test(c);

describe('вид: две темы', () => {
  const both: Theme[] = [LIGHT, DARK];

  test('цвета тем — непрозрачные #RRGGBB, кроме затемнения под листом', () => {
    for (const t of both) {
      for (const [k, c] of Object.entries(t.colors)) {
        if (k === 'backdrop') expect(c).toMatch(/^rgba\(/);
        else expect({ theme: t.name, key: k, ok: opaque(c) }).toEqual({ theme: t.name, key: k, ok: true });
      }
    }
  });

  test.each(both.map(t => [t.name, t] as const))('%s: текст к фону — не меньше 4,5 к 1', (_, t) => {
    for (const [fg, bgs] of TEXT) {
      for (const bg of bgs) {
        const r = contrast(t.colors[fg], t.colors[bg]);
        expect({ fg, bg, ok: r >= 4.5 }).toEqual({ fg, bg, ok: true });
      }
    }
  });

  test.each(both.map(t => [t.name, t] as const))('%s: крупное и не текст — не меньше 3 к 1', (_, t) => {
    // поле тетради — только там, где у документов линовка
    const pairs: [Key, Key[]][] = t.shape.ruled ? [...LARGE, ['margin', ['card']]] : LARGE;
    for (const [fg, bgs] of pairs) {
      for (const bg of bgs) {
        const r = contrast(t.colors[fg], t.colors[bg]);
        expect({ fg, bg, ok: r >= 3 }).toEqual({ fg, bg, ok: true });
      }
    }
  });

  test.each(both.map(t => [t.name, t] as const))('%s: выделенное на плане заметно на любом полу — не меньше 3 к 1', (_, t) => {
    // план светлый в обеих темах: рамка помещения, кольцо и призрак — цветом mark
    const floors = [...Object.values(ROOM_TINT), CORRIDOR, OUTSIDE, t.colors.markSoft];
    for (const f of floors) expect({ floor: f, ok: contrast(t.colors.mark, f) >= 3 }).toEqual({ floor: f, ok: true });
  });

  test('«Медкарта» — светлая, «Монитор» — тёмный; у каждой свои шрифты', () => {
    expect(luminance(LIGHT.colors.bg)).toBeGreaterThan(0.7);
    expect(luminance(DARK.colors.bg)).toBeLessThan(0.05);
    expect(LIGHT.fonts).toEqual({ title: 'PT Serif', body: 'PT Sans', mono: 'PT Mono' });
    expect(DARK.fonts).toEqual({ title: 'Golos Text', body: 'Golos Text', mono: 'JetBrains Mono' });
  });

  test('тема: выбор в настройках; «как в телефоне» — по теме телефона, нет её — светлая', () => {
    expect(themeOf('system', 'dark')).toBe(DARK);
    expect(themeOf('system', 'light')).toBe(LIGHT);
    expect(themeOf('system', null)).toBe(LIGHT);
    expect(themeOf('system', undefined)).toBe(LIGHT);
    expect(themeOf('dark', 'light')).toBe(DARK);
    expect(themeOf('light', 'dark')).toBe(LIGHT);
    expect(Object.keys(THEMES).sort()).toEqual(['dark', 'light']);
  });
});

/** Все .ts и .tsx в папке и глубже. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(name) ? [p] : [];
  });
}

describe('вид: цвета экранов — только из темы', () => {
  // план, снимки и портреты (src/render) — рисунок со своими цветами, он в обеих темах один
  const files = [...sources(join(ROOT, 'src', 'app')), ...sources(join(ROOT, 'src', 'ui'))]
    .filter(p => !p.endsWith(join('src', 'ui', 'palette.ts')));

  test('в src/app и src/ui нет #цветов, rgb(), hsl() и названий цветов мимо palette.ts', () => {
    expect(files.length).toBeGreaterThan(20);
    const stray: string[] = [];
    for (const p of files) {
      readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        if (/#[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{3})?(?:[0-9A-Fa-f]{2})?\b|\b(?:rgba?|hsla?)\(|[cC]olor\s*[:=]\s*['"](?:white|black|red|green|blue|yellow|gray|grey)['"]/.test(line)) {
          stray.push(`${p.slice(ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(stray).toEqual([]);
  });

  test('стили — через makeStyles, тема — через useTheme: сменили тему — экраны перерисованы', () => {
    // лист стилей на уровне модуля или тема, взятая напрямую, застыли бы на теме первого запуска
    const theme = join('src', 'ui', 'theme.ts');
    const frozen = files.filter(p => !p.endsWith(theme)).flatMap(p => {
      const text = readFileSync(p, 'utf8');
      const rel = p.slice(ROOT.length + 1);
      return [
        ...(/StyleSheet\.create\(/.test(text) ? [`${rel}: StyleSheet.create`] : []),
        ...(/import\s*\{[^}]*\b(?:colors|LIGHT|DARK|THEMES)\b[^}]*\}\s*from\s*'[^']*(?:theme|palette)'/.test(text) ? [`${rel}: тема напрямую`] : []),
      ];
    });
    expect(frozen).toEqual([]);
  });
});

describe('вид: шрифты — в сборке, с лицензией', () => {
  const app = JSON.parse(readFileSync(join(ROOT, 'app.json'), 'utf8'));
  const plugin = app.expo.plugins.find((p: unknown) => Array.isArray(p) && p[0] === 'expo-font')?.[1] as {
    android: { fonts: { fontFamily: string; fontDefinitions: { path: string; weight: number; style?: string }[] }[] };
    ios: { fonts: string[] };
  };
  const web = readFileSync(join(ROOT, 'src', 'ui', 'fonts.web.ts'), 'utf8');
  const licenses = readFileSync(join(ROOT, 'assets', 'fonts', 'LICENSES.md'), 'utf8');
  const families = [...new Set([LIGHT, DARK].flatMap(t => Object.values(t.fonts)))];

  test('каждое семейство тем собрано для Android и веба', () => {
    expect(plugin).toBeDefined();
    const android = plugin.android.fonts.map(f => f.fontFamily);
    for (const f of families) {
      expect(android).toContain(f);
      expect(web).toContain(`family: '${f}'`);
    }
    // у каждого семейства — обычное начертание; у заголовков и текста — и полужирное: кнопки, имена
    for (const f of plugin.android.fonts) expect(f.fontDefinitions.some(d => d.weight <= 500 && d.style !== 'italic')).toBe(true);
    const bold = [LIGHT, DARK].flatMap(t => [t.fonts.title, t.fonts.body]);
    for (const f of plugin.android.fonts.filter(x => bold.includes(x.fontFamily))) expect(f.fontDefinitions.some(d => d.weight === 700)).toBe(true);
  });

  test('файлы шрифтов на месте, у каждого — лицензия OFL рядом', () => {
    const paths = plugin.android.fonts.flatMap(f => f.fontDefinitions.map(d => d.path));
    expect(new Set(plugin.ios.fonts)).toEqual(new Set(paths));
    for (const p of paths) {
      expect(existsSync(join(ROOT, p))).toBe(true);
      const file = p.split('/').pop() as string;
      expect(web).toContain(`assets/fonts/${file}`);
      expect(licenses).toContain(`\`${file}\``);
    }
    const ttf = readdirSync(join(ROOT, 'assets', 'fonts')).filter(n => n.endsWith('.ttf'));
    expect(ttf.sort()).toEqual(paths.map(p => p.split('/').pop() as string).sort());
    for (const ofl of licenses.match(/OFL-[A-Za-z]+\.txt/g) ?? []) {
      const text = readFileSync(join(ROOT, 'assets', 'fonts', ofl), 'utf8');
      expect(text).toContain('SIL OPEN FONT LICENSE');
    }
  });
});
