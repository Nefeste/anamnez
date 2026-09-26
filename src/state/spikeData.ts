// Данные для проверки сохранения П6: 60 сгенерированных пациентов с результатами.
import type { ContentDb } from '@/content/types';
import { Rng } from '@/engine/core/rng';
import { runExam } from '@/engine/med/exams';
import { generatePatient } from '@/engine/med/generate';

export function spikePatients(db: ContentDb, n: number) {
  const exams = Object.keys(db.exams);
  return Array.from({ length: n }, (_, i) => {
    const patient = generatePatient(db, 500 + i, { department: 'dept.therapy', season: 'winter' });
    const results = exams.slice(0, 6).flatMap(id => runExam(db, patient, id, Rng.seeded(i).fork(id)));
    return { patient, results };
  });
}
