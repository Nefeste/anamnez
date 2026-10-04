// Размеры и цвета плана без Skia: клетка в точках рисунка, толщина стен, цвета пола — общие
// для пола (floor.ts), подписей (labels.ts) и проверок в Bun.
import type { RoomType } from '@/engine/hospital/grid';

/** Сторона клетки в точках рисунка карты; на экране её масштабирует карта. */
export const CELL_PX = 16;
/** Толщина полосы стены — доля клетки: внутренней и наружной (spec 2026-09-living-map). */
export const WALL_IN = 0.24;
export const WALL_OUT = 0.36;

/** Пол помещений — светлые оттенки по назначению; снаружи и коридор — свои. */
export const ROOM_TINT: Record<RoomType, string> = {
  reception: '#FAF1E4', waiting: '#FAF6E8', office: '#E7F3F2', triage: '#F8ECEC', procedure: '#F8ECEC',
  lab: '#F1ECF8', ecg: '#EEF5E6', xray: '#E9ECED', ultrasound: '#EEF5E6', ward: '#ECEFF9',
  surgery: '#E4F3EA', staff: '#F3F0EA', toilet: '#E8EFF5',
  // смотровая приёмного — прежний пол по умолчанию (часть 27), операционная — как хирургия (часть 28)
  emergency: '#F3F0EA', or: '#E4F3EA',
  // палата интенсивной терапии — холоднее палаты (spec 2026-10-chapter-3, часть 38а); кабинет КТ —
  // как рентген (часть 40)
  icu: '#E6EEF6', ct: '#E9ECED',
};
export const OUTSIDE = '#DDE4E3';
export const CORRIDOR = '#F6F3ED';

/**
 * Надписи и значки поверх плана — цвета плана, а не темы: план — чертёж на светлой бумаге в
 * обеих темах (spec 2026-09-own-look). Выделенное и призрак стройки — цвет темы `mark`:
 * тёмный, чтобы на светлом плане был заметен и в тёмной теме.
 */
export const PLAN_INK = '#1C2B2D';
export const PLAN_MUTED = '#5E6F72';
export const PLAN_CARD = '#FFFFFF';
export const PLAN_LINE = '#DCE5E6';
export const PLAN_RED = '#C8453C';
