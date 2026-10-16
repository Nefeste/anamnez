// «Назначить» бланком направления (0.6.0, ответ владельца на вопрос 45): разделы бланка. Это раскладка интерфейса, а не
// медицинские сведения, поэтому — здесь, а не в базе: база не меняется. Раздел — по виду обследования и кабинету базы;
// пункции в базе — анализы лаборатории, но их делает врач, поэтому — своим разделом. Только данные: их проверяют тесты
// в Bun.
import type { Exam } from '@/content/types';

export type Section = 'rapid' | 'lab' | 'xray' | 'us' | 'tomo' | 'endo' | 'puncture';

/** Разделы — в этом порядке на бланке. */
export const SECTIONS: readonly Section[] = ['rapid', 'lab', 'xray', 'us', 'tomo', 'endo', 'puncture'];

/** Пункции: материал берёт врач, а не процедурный кабинет. */
export const PUNCTURES: ReadonlySet<string> = new Set(['exam.lumbar_puncture', 'exam.paracentesis']);

/** Кабинеты снимков — по разделам; тест сверяет, что у каждого снимка базы кабинет есть здесь. */
export const IMAGING_ROOMS: Readonly<Record<string, Section>> = {
  'room.xray': 'xray',
  'room.ultrasound': 'us',
  'room.ct': 'tomo',
  'room.mri': 'tomo',
  'room.endoscopy': 'endo',
};

/** Раздел бланка: экспресс-тесты и ЭКГ, анализы, рентген, УЗИ, КТ и МРТ, эндоскопия, пункции. */
export function sectionOf(e: Pick<Exam, 'id' | 'kind' | 'room'>): Section {
  if (PUNCTURES.has(e.id)) return 'puncture';
  if (e.kind === 'rapid' || e.kind === 'functional') return 'rapid';
  if (e.kind === 'lab') return 'lab';
  return (e.room && IMAGING_ROOMS[e.room]) || 'tomo';
}
