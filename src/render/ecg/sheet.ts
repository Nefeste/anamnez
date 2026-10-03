// Лист ЭКГ в двенадцати отведениях (spec 2026-10-chapter-3, часть 36): миллиметровка, 25 мм/с,
// 10 мм/мВ. Шесть строк по два отведения — от конечностей слева, грудные справа, по 2,5 с — и полоса
// ритма во II отведении внизу, 5 с: так лист читается на ширине телефона (три ряда по четыре
// отведения при той же ширине мельче вдвое). Рисунок — одна запись в SkPicture; подписи отведений —
// текстом поверх, по `ecgSheetLayout`.
import { PaintStyle, Skia, type SkPicture, StrokeCap, StrokeJoin } from '@shopify/react-native-skia';
import { ECG_HZ, type EcgTrace, type Lead } from './model';

/** Размер листа, мм. */
const PAPER_W = 134;
const PAPER_H = 160;
export const ECG_SHEET_ASPECT = PAPER_H / PAPER_W;

/** Отступ слева под калибровочный импульс, ширина столбца (2,5 с) и промежуток между столбцами, мм. */
const LEFT = 7;
const COLUMN = 62.5;
const GAP = 1;
const ROW = 22;
const FIRST = 14;
/** Полоса ритма: 5 с во всю ширину. */
const STRIP_SECONDS = 5;
const STRIP_Y = FIRST + ROW * 5 + 24;
/** Сколько секунд ленты в столбце. */
export const COLUMN_SECONDS = 2.5;

/** Строки листа: отведения от конечностей слева, грудные — справа. */
const ROWS: [Lead, Lead][] = [
  ['I', 'V1'],
  ['II', 'V2'],
  ['III', 'V3'],
  ['aVR', 'V4'],
  ['aVL', 'V5'],
  ['aVF', 'V6'],
];

export const PAPER = '#FFF8F8';
const FINE = '#F7D4D4';
const BOLD = '#EFA3A3';
export const INK = '#1C2B2D';

export interface EcgSheetLayout {
  /** пикселей в миллиметре */
  mm: number;
  height: number;
  /** подписи отведений: где их поставить, в пикселях от левого верхнего угла */
  labels: { lead: Lead; x: number; y: number; strip?: true }[];
}

export function ecgSheetLayout(width: number): EcgSheetLayout {
  const mm = width / PAPER_W;
  const labels: EcgSheetLayout['labels'] = [];
  ROWS.forEach(([a, b], i) => {
    const y = (FIRST + ROW * i - 9.5) * mm;
    labels.push({ lead: a, x: (LEFT + 1) * mm, y });
    labels.push({ lead: b, x: (LEFT + COLUMN + GAP + 1) * mm, y });
  });
  labels.push({ lead: 'II', x: (LEFT + 1) * mm, y: (STRIP_Y - 9.5) * mm, strip: true });
  return { mm, height: Math.round(PAPER_H * mm), labels };
}

export function recordEcgSheet(width: number, trace: EcgTrace): SkPicture {
  const mm = width / PAPER_W;
  const height = PAPER_H * mm;
  const rec = Skia.PictureRecorder();
  const c = rec.beginRecording(Skia.XYWHRect(0, 0, width, height));

  const fill = Skia.Paint();
  fill.setColor(Skia.Color(PAPER));
  c.drawRect(Skia.XYWHRect(0, 0, width, height), fill);

  // миллиметровка: мелкие линии — каждый миллиметр, если между ними хватает места, крупные — каждые 5
  const line = (color: string, w: number) => {
    const p = Skia.Paint();
    p.setAntiAlias(true);
    p.setStyle(PaintStyle.Stroke);
    p.setColor(Skia.Color(color));
    p.setStrokeWidth(w);
    return p;
  };
  const fine = line(FINE, Math.max(0.5, mm * 0.08));
  const bold = line(BOLD, Math.max(0.8, mm * 0.16));
  for (let k = 0; k <= PAPER_W; k++) {
    if (k % 5 !== 0 && mm < 2) continue;
    c.drawLine(k * mm, 0, k * mm, height, k % 5 === 0 ? bold : fine);
  }
  for (let k = 0; k <= PAPER_H; k++) {
    if (k % 5 !== 0 && mm < 2) continue;
    c.drawLine(0, k * mm, width, k * mm, k % 5 === 0 ? bold : fine);
  }

  const ink = Skia.Paint();
  ink.setAntiAlias(true);
  ink.setStyle(PaintStyle.Stroke);
  ink.setColor(Skia.Color(INK));
  ink.setStrokeWidth(Math.max(1.1, mm * 0.32));
  ink.setStrokeJoin(StrokeJoin.Round);
  ink.setStrokeCap(StrokeCap.Round);

  /** Кусок ленты отведения: от `t0` столько-то секунд, с левого края `x0` (мм) на изолинии `y0` (мм). */
  const trace1 = (lead: Lead, t0: number, seconds: number, x0: number, y0: number) => {
    const s = trace.leads[lead];
    const b = Skia.PathBuilder.Make();
    const i0 = Math.round(t0 * ECG_HZ);
    const i1 = Math.min(s.length - 1, Math.round((t0 + seconds) * ECG_HZ));
    for (let i = i0; i <= i1; i++) {
      const x = (x0 + ((i - i0) / ECG_HZ) * 25) * mm;
      const y = (y0 - s[i] * 10) * mm;
      if (i === i0) b.moveTo(x, y);
      else b.lineTo(x, y);
    }
    c.drawPath(b.detach(), ink);
  };
  /** Калибровочный импульс 1 мВ: 10 мм вверх на 0,2 с. */
  const calibration = (y0: number) => {
    const b = Skia.PathBuilder.Make();
    b.moveTo(1 * mm, y0 * mm);
    b.lineTo(2 * mm, y0 * mm);
    b.lineTo(2 * mm, (y0 - 10) * mm);
    b.lineTo(7 * mm, (y0 - 10) * mm);
    b.lineTo(7 * mm, y0 * mm);
    c.drawPath(b.detach(), ink);
  };

  ROWS.forEach(([a, b], i) => {
    const y0 = FIRST + ROW * i;
    calibration(y0);
    trace1(a, 0, COLUMN_SECONDS, LEFT, y0);
    trace1(b, 0, COLUMN_SECONDS, LEFT + COLUMN + GAP, y0);
    // черта смены отведений между столбцами
    c.drawLine((LEFT + COLUMN + GAP / 2) * mm, (y0 - 3) * mm, (LEFT + COLUMN + GAP / 2) * mm, (y0 + 3) * mm, ink);
  });
  calibration(STRIP_Y);
  trace1('II', 0, Math.min(STRIP_SECONDS, trace.seconds), LEFT, STRIP_Y);
  return rec.finishRecordingAsPicture();
}
