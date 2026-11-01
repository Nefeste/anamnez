// Иконка и графика магазина — кодом, как всё изображение игры (ADR 0013): SVG здесь,
// растр — Chromium (tools/store/render.ts). Знак — лупа с лентой ЭКГ в линзе: «медицинский
// детектив». Красного креста нет и не будет: это охраняемая эмблема. По брендбуку студии
// (иконка — плоский рисунок, ADR 0017): заливки ровные, без градиентов и бликов.
// С 1.1.11 (spec 2026-11-faq-icon): плавные зубцы P и T, сетка монитора в линзе, ручка — шейка и
// «пилюля» без наплыва на стыке; в слоях адаптивной иконки знак целиком в безопасном круге Android.

export const BRAND = {
  teal: '#1A8A86',
  lens: '#0A4745',
  grid: '#0E5552',
  trace: '#7CF3C9',
  ink: '#1C2B2D',
  paper: '#F4F7F7',
};

/** Линза: центр, радиус до середины кольца, толщина кольца. */
const LENS = { x: 430, y: 430, r: 246, ring: 62 };
/** Ручка вдоль оси лупы, от внешнего края кольца: шейка уже ручки, ручка — со скруглёнными концами. */
const NECK = { from: -10, length: 80, width: 72 };
const GRIP = { from: 50, length: 300, width: 120 };

/** Линия ЭКГ в линзе: изолиния, P, QRS, T — относительно центра линзы. */
function trace(): string {
  const p = (x: number, y: number) => `${LENS.x + x} ${LENS.y + y}`;
  return [
    `M${p(-300, 40)}`, `L${p(-178, 40)}`, `Q${p(-140, -24)} ${p(-102, 40)}`, `L${p(-66, 40)}`,
    `L${p(-50, 72)}`, `L${p(-14, -180)}`, `L${p(22, 150)}`, `L${p(46, 40)}`, `L${p(78, 40)}`,
    `Q${p(138, -64)} ${p(198, 40)}`, `L${p(300, 40)}`,
  ].join(' ');
}

/** Знак в своей системе координат: рамка — GLYPH_BOX, описанный круг — GLYPH_CIRCLE. */
function glyph(mono: boolean): string {
  const white = '#FFFFFF';
  const inner = LENS.r - LENS.ring / 2;
  const outer = LENS.r + LENS.ring / 2;
  const grid = mono ? '' : [-150, -50, 50, 150].map(v => `
      <line x1="${LENS.x + v}" y1="${LENS.y - inner}" x2="${LENS.x + v}" y2="${LENS.y + inner}" stroke="${BRAND.grid}" stroke-width="8"/>
      <line x1="${LENS.x - inner}" y1="${LENS.y + v}" x2="${LENS.x + inner}" y2="${LENS.y + v}" stroke="${BRAND.grid}" stroke-width="8"/>`).join('');
  return `
    <defs>
      <clipPath id="lensClip"><circle cx="${LENS.x}" cy="${LENS.y}" r="${inner + 1}"/></clipPath>
    </defs>
    <g transform="translate(${LENS.x} ${LENS.y}) rotate(45)">
      <rect x="${outer + NECK.from}" y="${-NECK.width / 2}" width="${NECK.length}" height="${NECK.width}" fill="${white}"/>
      <rect x="${outer + GRIP.from}" y="${-GRIP.width / 2}" width="${GRIP.length}" height="${GRIP.width}" rx="${GRIP.width / 2}" fill="${white}"/>
    </g>
    ${mono ? '' : `<circle cx="${LENS.x}" cy="${LENS.y}" r="${inner + 2}" fill="${BRAND.lens}"/>`}
    <g clip-path="url(#lensClip)">${grid}
      <path d="${trace()}" fill="none" stroke="${mono ? white : BRAND.trace}" stroke-width="40" stroke-linejoin="round" stroke-linecap="round"/>
    </g>
    <circle cx="${LENS.x}" cy="${LENS.y}" r="${LENS.r}" fill="none" stroke="${white}" stroke-width="${LENS.ring}"/>`;
}

/**
 * Рамка знака: от верхнего левого края кольца (430 − 277) до конца ручки. Конец ручки — скругление
 * радиусом 60 с центром на оси в 277 + 350 − 60 = 567 от центра линзы: 430 + 567 · 0,707 + 60 ≈ 891.
 */
const GLYPH_BOX = { cx: 522, cy: 522, size: 740 };
/**
 * Описанный круг знака — для слоёв адаптивной иконки: по оси лупы от края кольца (608 − 277 = 331)
 * до конца ручки (608 + 567 + 60 = 1235): центр — 783 по оси (554 по x и y), радиус — 452.
 */
const GLYPH_CIRCLE = { cx: 554, cy: 554, r: 452 };

function placed(mono: boolean, size: number, cx: number, cy: number, k: number): string {
  return `<g transform="translate(${size / 2} ${size / 2}) scale(${k}) translate(${-cx} ${-cy})">${glyph(mono)}</g>`;
}

/** Знак в рамке: доля стороны квадрата. */
function inBox(mono: boolean, size: number, share: number): string {
  return placed(mono, size, GLYPH_BOX.cx, GLYPH_BOX.cy, (size * share) / GLYPH_BOX.size);
}

/**
 * Знак в круге: радиус — доля стороны. Безопасная зона адаптивной иконки Android — круг 66 из 108 dp,
 * радиус 0,306 стороны: знак в ней не срежет маска лаунчера, даже круглая.
 */
function inCircle(mono: boolean, size: number, radius: number): string {
  return placed(mono, size, GLYPH_CIRCLE.cx, GLYPH_CIRCLE.cy, (size * radius) / GLYPH_CIRCLE.r);
}

function background(size: number): string {
  return `<rect width="${size}" height="${size}" fill="${BRAND.teal}"/>`;
}

export type IconVariant = 'full' | 'foreground' | 'background' | 'monochrome';

/**
 * full — иконка магазина и приложения: фон и знак, без прозрачности; foreground,
 * background, monochrome — слои адаптивной иконки Android (знак — в безопасной зоне 66 dp).
 */
export function iconSvg(variant: IconVariant, size = 1024): string {
  const body = variant === 'full' ? background(size) + inBox(false, size, 0.74)
    : variant === 'background' ? background(size)
      : inCircle(variant === 'monochrome', size, 0.3);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`;
}

/** Знак отдельно — для графики магазина и сайта. */
export function markSvg(size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${inBox(false, size, 1)}</svg>`;
}
