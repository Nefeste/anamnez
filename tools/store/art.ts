// Иконка и графика магазина — кодом, как всё изображение игры (ADR 0013): SVG здесь,
// растр — Chromium (tools/store/render.ts). Знак — лупа с лентой ЭКГ в линзе: «медицинский
// детектив». Красного креста нет и не будет: это охраняемая эмблема.

export const BRAND = {
  teal: '#1A8A86',
  tealLight: '#26A7A1',
  tealDark: '#0F5F5C',
  lens: '#0A4745',
  trace: '#7CF3C9',
  ink: '#1C2B2D',
  paper: '#F4F7F7',
};

/** Линия ЭКГ в линзе: изолиния, P, QRS, T — в координатах относительно центра линзы. */
const TRACE: [number, number][] = [
  [-300, 42], [-165, 42], [-150, 30], [-128, 18], [-106, 30], [-92, 42], [-66, 42],
  [-52, 70], [-18, -168], [18, 138], [42, 42], [86, 42], [104, 26], [128, 2], [152, 2],
  [176, 26], [194, 42], [300, 42],
];

const LENS = { x: 440, y: 440, r: 262 };
const RING = 68;
const HANDLE = { from: LENS.r + 8, to: LENS.r + 318, width: 116 };

/** Знак в своей системе координат (≈ 136…918 по обеим осям). */
function glyph(mono: boolean): string {
  const d = Math.SQRT1_2;
  const hx1 = LENS.x + HANDLE.from * d;
  const hx2 = LENS.x + HANDLE.to * d;
  const trace = TRACE.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${LENS.x + x} ${LENS.y + y}`).join(' ');
  const white = '#FFFFFF';
  return `
    <defs>
      <clipPath id="lensClip"><circle cx="${LENS.x}" cy="${LENS.y}" r="${LENS.r - RING / 2 + 1}"/></clipPath>
      <radialGradient id="lensFill" cx="0.42" cy="0.38" r="0.7">
        <stop offset="0" stop-color="${BRAND.tealDark}"/>
        <stop offset="1" stop-color="${BRAND.lens}"/>
      </radialGradient>
    </defs>
    ${mono ? '' : `<circle cx="${LENS.x}" cy="${LENS.y}" r="${LENS.r}" fill="url(#lensFill)"/>`}
    <line x1="${hx1}" y1="${hx1}" x2="${hx2}" y2="${hx2}" stroke="${white}" stroke-width="${HANDLE.width}" stroke-linecap="round"/>
    <line x1="${hx1 - 18}" y1="${hx1 - 18}" x2="${hx1 + 40}" y2="${hx1 + 40}" stroke="${white}" stroke-width="${HANDLE.width * 0.62}" stroke-linecap="round"/>
    <g clip-path="url(#lensClip)">
      <path d="${trace}" fill="none" stroke="${mono ? white : BRAND.trace}" stroke-width="34" stroke-linejoin="round" stroke-linecap="round"/>
      ${mono ? '' : `<path d="M ${LENS.x - 170} ${LENS.y - 120} A 210 210 0 0 1 ${LENS.x - 40} ${LENS.y - 205}" fill="none" stroke="#FFFFFF" stroke-opacity="0.22" stroke-width="22" stroke-linecap="round"/>`}
    </g>
    <circle cx="${LENS.x}" cy="${LENS.y}" r="${LENS.r}" fill="none" stroke="${white}" stroke-width="${RING}"/>`;
}

/** Рамка знака: центр и размер — чтобы вписать его в нужный квадрат. */
const GLYPH_BOX = { cx: 527, cy: 527, size: 790 };

function placed(mono: boolean, size: number, share: number): string {
  const k = (size * share) / GLYPH_BOX.size;
  return `<g transform="translate(${size / 2} ${size / 2}) scale(${k}) translate(${-GLYPH_BOX.cx} ${-GLYPH_BOX.cy})">${glyph(mono)}</g>`;
}

function background(size: number): string {
  return `
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${BRAND.tealLight}"/>
        <stop offset="1" stop-color="${BRAND.tealDark}"/>
      </linearGradient>
    </defs>
    <rect width="${size}" height="${size}" fill="url(#bg)"/>`;
}

export type IconVariant = 'full' | 'foreground' | 'background' | 'monochrome';

/**
 * full — иконка магазина и приложения: фон и знак, без прозрачности; foreground,
 * background, monochrome — слои адаптивной иконки Android (знак — в безопасной зоне 66 %).
 */
export function iconSvg(variant: IconVariant, size = 1024): string {
  const body = variant === 'full' ? background(size) + placed(false, size, 0.74)
    : variant === 'background' ? background(size)
      : placed(variant === 'monochrome', size, 0.6);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`;
}

/** Знак отдельно — для графики магазина и сайта. */
export function markSvg(size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${placed(false, size, 1)}</svg>`;
}
