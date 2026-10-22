// Значок строки карты на телефоне (0.6.8, вопрос 49): PNG, нарисованная Skia (rowIconArt.ts), — здесь та же Skia через
// CanvasKit (tools/imaging/headless.ts). Кружок — цветом состояния, у «неизвестно» — пунктиром и с «?» внизу справа;
// внутри — фон карточки, рисунок — цветом состояния; вне кружка — прозрачно. Каждый контур значков разбирается Skia.
import { beforeAll, describe, expect, test } from 'bun:test';
import { ICON_GRID } from '../../src/ui/iconShapes';
import { ITEM_SHAPES } from '../../src/ui/itemIconShapes';
import { DARK, LIGHT, type Palette } from '../../src/ui/palette';
import { loadSkia } from '../imaging/headless';

type Art = typeof import('../../src/ui/rowIconArt');
let ck: Awaited<ReturnType<typeof loadSkia>>;
let art: Art;

const PX = 96;
const K = PX / ICON_GRID;
/** рисунок для проверки точек: черта посередине и квадрат заливкой слева вверху */
const PROBE = { stroke: ['M12 7V17'], fill: ['M5 5H8V8H5Z'] };
const STATES = ['present', 'absent', 'unknown', 'chosen', 'off', 'neutral'] as const;

const rgb = (hex: string) => [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16));

function pixels(uri: string): { w: number; h: number; rgba: Uint8Array } {
  const image = ck.MakeImageFromEncoded(Buffer.from(uri.replace(/^data:image\/png;base64,/, ''), 'base64'));
  const w = image.width(), h = image.height();
  const rgba = image.readPixels(0, 0, { width: w, height: h, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB }) as Uint8Array;
  image.delete();
  return { w, h, rgba };
}

/** Цвет в точке сетки 24 × 24: `[r, g, b, a]`. */
function at(p: { w: number; rgba: Uint8Array }, x: number, y: number): number[] {
  const i = (Math.floor(y * K) * p.w + Math.floor(x * K)) * 4;
  return [p.rgba[i], p.rgba[i + 1], p.rgba[i + 2], p.rgba[i + 3]];
}

const near = (got: number[], hex: string) => got[3] > 230 && rgb(hex).every((v, i) => Math.abs(v - got[i]) <= 24);

/** Доля точек кружка цвета `hex`; четверть внизу справа — у «неизвестно» там «?», её не считаем. */
function ringShare(p: { w: number; rgba: Uint8Array }, hex: string): number {
  let hit = 0, all = 0;
  for (let deg = 90; deg < 360; deg += 2) {
    const a = (deg * Math.PI) / 180;
    all++;
    if (near(at(p, 12 + art.RING.r * Math.cos(a), 12 + art.RING.r * Math.sin(a)), hex)) hit++;
  }
  return hit / all;
}

describe('значок строки карты на телефоне', () => {
  beforeAll(async () => {
    ck = await loadSkia();
    art = await import('../../src/ui/rowIconArt');
  });

  test('каждый контур значков строк разбирается Skia', async () => {
    const { Skia } = await import('@shopify/react-native-skia');
    const bad: string[] = [];
    for (const [k, shape] of Object.entries(ITEM_SHAPES)) {
      for (const d of [...shape.stroke, ...('fill' in shape ? shape.fill : [])]) if (!Skia.Path.MakeFromSVGString(d)) bad.push(k);
    }
    expect(bad).toEqual([]);
  });

  for (const [theme, c] of [['«Медкарта»', LIGHT.colors], ['«Монитор»', DARK.colors]] as [string, Palette][]) {
    test(`${theme}: кружок цветом состояния, внутри — фон карточки, рисунок — цветом состояния, вне кружка — прозрачно`, () => {
      for (const state of STATES) {
        const p = pixels(art.rowIconPng(PROBE, state, c, PX));
        const { ring, ink } = art.colorsOf(state, c);
        expect({ state, w: p.w, h: p.h }).toEqual({ state, w: PX, h: PX });
        expect({ state, corner: at(p, 0.5, 0.5)[3] }).toEqual({ state, corner: 0 });
        expect({ state, inside: near(at(p, 12, 3), c.card), off: near(at(p, 9, 13), c.card) }).toEqual({ state, inside: true, off: true });
        expect({ state, line: near(at(p, 12, 12), ink), fill: near(at(p, 8.7, 8.7), ink) }).toEqual({ state, line: true, fill: true });
        const share = ringShare(p, ring);
        if (state === 'unknown') expect({ state, dashed: share > 0.35 && share < 0.8 }).toEqual({ state, dashed: true });
        else expect({ state, share }).toEqual({ state, share: 1 });
      }
    });

    test(`${theme}: «?» — только у «неизвестно»: кружок цветом состояния, знак — цветом карточки`, () => {
      for (const state of STATES) {
        const p = pixels(art.rowIconPng(PROBE, state, c, PX));
        const { ring } = art.colorsOf(state, c);
        const unknown = state === 'unknown';
        expect({ state, badge: near(at(p, 16, 20.2), unknown ? ring : c.card) }).toEqual({ state, badge: true });
        if (unknown) expect({ state, mark: near(at(p, 18.84, 19.3), c.card) }).toEqual({ state, mark: true });
      }
    });
  }

  test('SVG для веба — те же размеры и цвета', () => {
    const svg = decodeURIComponent(art.rowIconSvg(PROBE, 'unknown', LIGHT.colors).replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));
    expect(svg).toContain(`r="${art.RING.r}" fill="${LIGHT.colors.card}" stroke="${LIGHT.colors.unknown}"`);
    expect(svg).toContain(`stroke-dasharray="${art.RING.dash.join(' ')}"`);
    expect(svg).toContain(`<circle cx="${art.BADGE.x}" cy="${art.BADGE.y}" r="${art.BADGE.r}" fill="${LIGHT.colors.unknown}"`);
    expect(decodeURIComponent(art.rowIconSvg(PROBE, 'present', LIGHT.colors))).not.toContain('stroke-dasharray');
  });
});
