// «Осмотреть» фигурой (0.6.0, ответ владельца на вопрос 44): где на теле делают осмотр. Это раскладка интерфейса, а не
// медицинские сведения, поэтому — здесь, а не в базе: база не меняется. Осмотр всего больного и то, что меряют приборами
// у постели, — полками над фигурой. Только данные: их проверяют тесты в Bun.
import type { BodyPlace } from '@/ui/bodyShape';

export type Shelf = 'whole' | 'bedside';
export type ExamPlace = BodyPlace | Shelf;

/** Места на фигуре — в этом порядке их читает экранный диктор; полки — после. */
export const BODY_PLACES: readonly BodyPlace[] = ['head', 'neck', 'chest', 'back', 'belly', 'arms', 'legs'];
export const SHELVES: readonly Shelf[] = ['whole', 'bedside'];

/** Каждый осмотр руками (`physical`) и у постели (`bedside`) базы — на своём месте; тест сверяет с базой. */
export const EXAM_PLACES: Readonly<Record<string, ExamPlace>> = {
  'exam.fundoscopy': 'head',
  'exam.nose_exam': 'head',
  'exam.ice_test': 'head',
  'exam.tetany_signs': 'head',
  'exam.throat': 'neck',
  'exam.thyroid_palpation': 'neck',
  'exam.lung_auscultation': 'chest',
  'exam.heart_auscultation': 'chest',
  'exam.lung_percussion': 'chest',
  'exam.chest_exam': 'chest',
  'exam.clavicle_exam': 'chest',
  'exam.spine_exam': 'back',
  'exam.cva_percussion': 'back',
  'exam.abdomen_palpation': 'belly',
  'exam.peritoneal_signs': 'belly',
  'exam.hernia_check': 'belly',
  'exam.rectal_exam': 'belly',
  'exam.wrist_exam': 'arms',
  'exam.hand_function': 'arms',
  'exam.hip_exam': 'legs',
  'exam.knee_exam': 'legs',
  'exam.knee_ligament_tests': 'legs',
  'exam.ankle_exam': 'legs',
  'exam.foot_exam': 'legs',
  'exam.leg_exam': 'legs',
  // весь больной: общий и неврологический осмотр, шкалы, кожа — раны и ожоги бывают где угодно
  'exam.general_exam': 'whole',
  'exam.neuro_exam': 'whole',
  'exam.ciwa': 'whole',
  'exam.wound_exam': 'whole',
  'exam.burn_exam': 'whole',
  'exam.burn_depth_tests': 'whole',
  // у постели — приборами
  'exam.vitals': 'bedside',
  'exam.bp_both_arms': 'bedside',
  'exam.pulsus_paradoxus': 'bedside',
  'exam.glucometer': 'bedside',
  'exam.peak_flow': 'bedside',
  'exam.swallow_test': 'bedside',
};

/** Место осмотра; новый осмотр без места — к «Весь больной», пока его не разложили (тест напомнит). */
export const placeOf = (exam: string): ExamPlace => EXAM_PLACES[exam] ?? 'whole';
