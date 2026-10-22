// Рисунок значка строки карты пациента (0.6.8, вопрос 49) — без React: рисунок строки в кружке на фоне карточки, цвет —
// что о строке известно. Есть у пациента — красными чернилами, нет — синими, ещё неизвестно — серым пунктиром и «?»;
// назначено — цветом выбора, не назначено — серым; болезнь — чернилами. Без заливки и без перечёркивания — ответ
// владельца: «на белом фоне иконка выглядит значительно лучше», «цвета, пунктира и знака вопроса достаточно».
// Для веба — картинка SVG, для телефона — PNG, нарисованная Skia в растровой поверхности, как атлас плана больницы
// (sprites.ts): холст Skia на каждый значок — своя поверхность GPU, а строк в бланке и листе назначений десятки. Тест —
// rowIcon.test.ts, в CanvasKit.
import { PaintStyle, Skia, type SkPaint, StrokeCap, StrokeJoin } from '@shopify/react-native-skia';
import type { IconShape } from './iconShapes';
import type { Palette } from './palette';
import { pathOf } from './skPath';

/** Что о строке известно: признак у пациента, обследование по его результату; лечение — назначено ли; болезнь — без цвета. */
export type RowState = 'present' | 'absent' | 'unknown' | 'chosen' | 'off' | 'neutral';

export const ROW_GRID = 24;
/** кружок — в сетке значка: радиус, линия, пунктир «неизвестно» */
export const RING = { r: 10.9, line: 1.4, dash: [2.4, 1.9] };
/** рисунок строки — в кружке, на шесть десятых сетки, линией чуть толще: на 20 точках тонкая теряется */
export const INNER = { scale: 0.6, shift: 4.8, line: 2.2 };
/** «?» у неизвестного — кружком внизу справа, знак — из значка вкладки «Спросить» */
export const BADGE = { x: 18.8, y: 18.8, r: 4.9, edge: 1.2, line: 2.4, tx: 9.16, ty: 10.6, scale: 0.8 };
const QUESTION = ['M10.1 8.4C10.3 7.4 11.1 6.8 12.1 6.8C13.2 6.8 14 7.6 14 8.6C14 10 12.1 10.2 12.1 11.6', 'M12.1 13.6V13.7'];

export function colorsOf(state: RowState, c: Palette): { ring: string; ink: string } {
  switch (state) {
    case 'present': return { ring: c.present, ink: c.present };
    case 'absent': return { ring: c.absent, ink: c.absent };
    case 'unknown': return { ring: c.unknown, ink: c.unknown };
    case 'chosen': return { ring: c.accent, ink: c.accent };
    case 'off': return { ring: c.muted, ink: c.muted };
    default: return { ring: c.muted, ink: c.ink };
  }
}

/** Значок картинкой SVG — для веба. */
export function rowIconSvg(shape: IconShape, state: RowState, c: Palette): string {
  const { ring, ink } = colorsOf(state, c);
  const dash = state === 'unknown' ? ` stroke-dasharray="${RING.dash.join(' ')}"` : '';
  const inner = `translate(${INNER.shift} ${INNER.shift}) scale(${INNER.scale})`;
  const stroke = shape.stroke.map(d => `<path d="${d}"/>`).join('');
  const fill = (shape.fill ?? []).map(d => `<path d="${d}"/>`).join('');
  const badge = state === 'unknown'
    ? `<circle cx="${BADGE.x}" cy="${BADGE.y}" r="${BADGE.r}" fill="${ring}" stroke="${c.card}" stroke-width="${BADGE.edge}"/>`
      + `<g transform="translate(${BADGE.tx} ${BADGE.ty}) scale(${BADGE.scale})" fill="none" stroke="${c.card}" stroke-width="${BADGE.line}" stroke-linecap="round">${QUESTION.map(d => `<path d="${d}"/>`).join('')}</g>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ROW_GRID} ${ROW_GRID}">`
    + `<circle cx="12" cy="12" r="${RING.r}" fill="${c.card}" stroke="${ring}" stroke-width="${RING.line}"${dash}/>`
    + `<g transform="${inner}" fill="none" stroke="${ink}" stroke-width="${INNER.line}" stroke-linecap="round" stroke-linejoin="round">${stroke}</g>`
    + (fill ? `<g transform="${inner}" fill="${ink}">${fill}</g>` : '')
    + badge + '</svg>';
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function paint(color: string, line?: number, round?: boolean): SkPaint {
  const p = Skia.Paint();
  p.setAntiAlias(true);
  p.setColor(Skia.Color(color));
  if (line !== undefined) {
    p.setStyle(PaintStyle.Stroke);
    p.setStrokeWidth(line);
    if (round) {
      p.setStrokeCap(StrokeCap.Round);
      p.setStrokeJoin(StrokeJoin.Round);
    }
  }
  return p;
}

/** Тот же значок картинкой PNG стороной `px` точек экрана — для телефона; то же, что SVG, кистями Skia. */
export function rowIconPng(shape: IconShape, state: RowState, c: Palette, px: number): string {
  const surface = Skia.Surface.Make(px, px);
  if (!surface) throw new Error('Skia surface unavailable');
  const canvas = surface.getCanvas();
  const { ring, ink } = colorsOf(state, c);
  canvas.scale(px / ROW_GRID, px / ROW_GRID);
  canvas.drawCircle(12, 12, RING.r, paint(c.card));
  const edge = paint(ring, RING.line);
  if (state === 'unknown') edge.setPathEffect(Skia.PathEffect.MakeDash(RING.dash, 0));
  canvas.drawCircle(12, 12, RING.r, edge);
  canvas.save();
  canvas.translate(INNER.shift, INNER.shift);
  canvas.scale(INNER.scale, INNER.scale);
  for (const d of shape.stroke) canvas.drawPath(pathOf(d), paint(ink, INNER.line, true));
  for (const d of shape.fill ?? []) canvas.drawPath(pathOf(d), paint(ink));
  canvas.restore();
  if (state === 'unknown') {
    canvas.drawCircle(BADGE.x, BADGE.y, BADGE.r, paint(ring));
    canvas.drawCircle(BADGE.x, BADGE.y, BADGE.r, paint(c.card, BADGE.edge));
    canvas.save();
    canvas.translate(BADGE.tx, BADGE.ty);
    canvas.scale(BADGE.scale, BADGE.scale);
    const q = paint(c.card, BADGE.line);
    q.setStrokeCap(StrokeCap.Round);
    for (const d of QUESTION) canvas.drawPath(pathOf(d), q);
    canvas.restore();
  }
  surface.flush();
  const image = surface.makeImageSnapshot();
  const uri = `data:image/png;base64,${image.encodeToBase64()}`;
  image.dispose();
  surface.dispose();
  return uri;
}
