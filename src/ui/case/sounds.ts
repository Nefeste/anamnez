// Какой звук у какого обследования (spec 2026-10-premium-polish): по виду обследования из базы и разделу бланка. Звуки
// — приборов и процедур, не результатов: давление меряют манжетой, ЭКГ и приборы у постели пищат монитором, снимок —
// экспозиция рентгена, анализы и экспресс-тесты — пробирки. Расспрос и осмотр руками беззвучны. Только данные, без
// проигрывателей — правило проверяет тест.
import type { DeviceSound } from '@/audio/sounds';
import { db } from '@/content';
import type { Exam } from '@/content/types';
import { sectionOf } from './sections';

/** Осмотр у постели с манжетой: давление и остальные показатели. */
const CUFF: ReadonlySet<string> = new Set(['exam.vitals']);

export function examSoundOf(e: Pick<Exam, 'id' | 'kind' | 'room'>): DeviceSound | undefined {
  if (CUFF.has(e.id)) return 'cuff';
  switch (e.kind) {
    case 'ask':
    case 'physical':
      return undefined;
    case 'bedside':
    case 'functional':
      return 'monitor';
    case 'lab':
    case 'rapid':
      return 'tubes';
    case 'imaging': {
      const s = sectionOf(e);
      return s === 'xray' || s === 'tomo' ? 'xray' : 'monitor';
    }
  }
  return undefined;
}

export function examSound(id: string): DeviceSound | undefined {
  const e = db.exams[id];
  return e ? examSoundOf(e) : undefined;
}
