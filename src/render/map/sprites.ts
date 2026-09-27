// Текстура спрайтов карты собирается кодом при запуске (ADR 0013, 06-architecture.md §6):
// предметы и фигурки — простые формы сверху, одна текстура на все, одно обращение к GPU.
import { PaintStyle, Skia, type SkImage, type SkRect } from '@shopify/react-native-skia';
import type { ObjectKind } from '@/engine/hospital/grid';

export const SPRITE = 32;
export const OBJECT_KINDS: ObjectKind[] = ['bed', 'chair', 'desk', 'couch', 'cabinet', 'machine', 'plant', 'sink', 'bench', 'xray', 'table'];
/** Фигурки: 0 — врач, 1 — медсестра, 2–4 — пациенты, 5 — прочий персонал, 6–8 и 9–11 —
 * пациенты с жёлтой и красной срочностью: толще обод — срочность видна не только цветом. */
export const PEOPLE: { body: string; edge: string; ring?: number }[] = [
  { body: '#FFFFFF', edge: '#1A8A86' }, // врач
  { body: '#6FA8DC', edge: '#3D6E99' }, // медсестра
  { body: '#C9824F', edge: '#8A5634' }, // пациенты
  { body: '#8E7AA6', edge: '#5E4E73' },
  { body: '#7A9E7E', edge: '#4E6E52' },
  { body: '#E6E0F0', edge: '#6E5E96' }, // регистратор, лаборант, рентгенолаборант, рентгенолог
  { body: '#C9824F', edge: '#D9A21B', ring: 3.5 },
  { body: '#8E7AA6', edge: '#D9A21B', ring: 3.5 },
  { body: '#7A9E7E', edge: '#D9A21B', ring: 3.5 },
  { body: '#C9824F', edge: '#C8453C', ring: 5 },
  { body: '#8E7AA6', edge: '#C8453C', ring: 5 },
  { body: '#7A9E7E', edge: '#C8453C', ring: 5 },
];

export interface SpriteAtlas {
  image: SkImage;
  objectRect: (k: ObjectKind) => SkRect;
  personRect: (i: number) => SkRect;
}

export function buildAtlas(): SpriteAtlas {
  const cols = OBJECT_KINDS.length + PEOPLE.length;
  const surface = Skia.Surface.Make(SPRITE * cols, SPRITE);
  if (!surface) throw new Error('Skia surface unavailable');
  const c = surface.getCanvas();
  const paint = (color: string, stroke = 0) => {
    const p = Skia.Paint();
    p.setColor(Skia.Color(color));
    p.setAntiAlias(true);
    if (stroke) {
      p.setStyle(PaintStyle.Stroke);
      p.setStrokeWidth(stroke);
    }
    return p;
  };
  const rr = (i: number, x: number, y: number, w: number, h: number, r: number, color: string) =>
    c.drawRRect(Skia.RRectXY(Skia.XYWHRect(i * SPRITE + x, y, w, h), r, r), paint(color));
  const circle = (i: number, x: number, y: number, r: number, color: string) => c.drawCircle(i * SPRITE + x, y, r, paint(color));

  OBJECT_KINDS.forEach((k, i) => {
    switch (k) {
      case 'bed': rr(i, 7, 2, 18, 28, 4, '#FFFFFF'); rr(i, 7, 12, 18, 18, 3, '#9CC3E6'); rr(i, 9, 4, 14, 6, 3, '#E9EEF2'); break;
      case 'chair': rr(i, 9, 9, 14, 14, 3, '#8C6A4A'); rr(i, 9, 9, 14, 4, 2, '#6E513A'); break;
      case 'desk': rr(i, 3, 6, 26, 20, 3, '#A07850'); rr(i, 6, 9, 10, 7, 2, '#E8E2D6'); break;
      case 'couch': rr(i, 4, 8, 24, 16, 5, '#5F8F7A'); rr(i, 6, 10, 20, 8, 3, '#7FAF97'); break;
      case 'cabinet': rr(i, 5, 5, 22, 22, 2, '#9AA5A8'); c.drawLine(i * SPRITE + 16, 6, i * SPRITE + 16, 26, paint('#6E7A7D', 1.5)); break;
      case 'machine': rr(i, 5, 5, 22, 22, 4, '#4B5A5E'); rr(i, 9, 9, 14, 8, 2, '#8FD6B0'); break;
      case 'plant': circle(i, 16, 16, 11, '#4E8A55'); circle(i, 16, 16, 5, '#2F6B3A'); break;
      case 'sink': rr(i, 7, 8, 18, 16, 5, '#F4F7F8'); circle(i, 16, 16, 4, '#AEB9BC'); break;
      case 'bench': rr(i, 2, 10, 28, 12, 3, '#B08D63'); break;
      case 'xray': rr(i, 2, 4, 28, 24, 4, '#7E8C90'); rr(i, 6, 8, 20, 16, 3, '#CFD8DA'); break;
      case 'table': rr(i, 4, 4, 24, 24, 3, '#D8DDDF'); break;
    }
  });
  PEOPLE.forEach((p, j) => {
    const i = OBJECT_KINDS.length + j;
    circle(i, 16, 16, 10 + (p.ring ?? 2), p.edge);
    circle(i, 16, 16, 10, p.body);
    circle(i, 16, 15, 5.5, '#E8BE9A');
  });
  surface.flush();
  const image = surface.makeImageSnapshot();
  const rect = (i: number) => Skia.XYWHRect(i * SPRITE, 0, SPRITE, SPRITE);
  return {
    image,
    objectRect: k => rect(OBJECT_KINDS.indexOf(k)),
    personRect: i => rect(OBJECT_KINDS.length + (i % PEOPLE.length)),
  };
}
