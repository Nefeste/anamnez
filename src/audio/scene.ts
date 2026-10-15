// Где какая музыка (часть 62; 0.5.12 — отзыв на 0.5.11): сцена — по экрану, который на виду. Без проигрывателей —
// чтобы правило проверялось тестом.

/** Где музыка: в меню — спокойная, на смене — своя и тише, под фоном амбулатории (часть 62). */
export type MusicScene = 'menu' | 'shift';

/** Экраны, которые музыку не меняют: справочное открывают и из меню, и с приёма — переключать её туда-обратно резко. */
const REFERENCE = ['/encyclopedia', '/settings', '/sources', '/licenses', '/about', '/report'];

/** Сцена для экрана: приём — на смене и в «Случае дня» (его карта, решение и разбор); справочное — та же, что была. */
export function musicSceneOf(path: string, now: MusicScene): MusicScene {
  if (REFERENCE.some(r => path === r || path.startsWith(`${r}/`))) return now;
  return path.startsWith('/shift') || path.startsWith('/daily/') ? 'shift' : 'menu';
}
