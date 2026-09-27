// Обследование открывает признаки — и ошибается так, как ошибаются в жизни
// (`docs/04-medical-model.md` §5): у каждой пары «обследование — признак» своя
// чувствительность и специфичность, поправленные навыком и оборудованием.
import type { ContentDb, Id } from '../../content/types';
import { P_ONE, Rng } from '../core/rng';
import { sampleRange } from './generate';
import type { Observation, Patient } from './types';

/** Поправки точности: множители к чувствительности и специфичности (1 — как в базе). */
export interface ExamSkill {
  sens: number;
  spec: number;
}

export const NORMAL_SKILL: ExamSkill = { sens: 1, spec: 1 };

/** Навык и аппарат не делают из аускультации КТ: поправленная точность — в [0,5; 0,995]. */
const clampP = (p: number) => Math.max(5000, Math.min(9950, Math.round(p)));

export function effectiveCheck(sens: number, spec: number, skill: ExamSkill): { sens: number; spec: number } {
  return {
    sens: skill.sens === 1 ? sens : clampP(sens * skill.sens),
    spec: skill.spec === 1 ? spec : clampP(spec * skill.spec),
  };
}

/**
 * Проводит обследование. `rng` — ветвь именно этого назначения (например,
 * `root.fork('order:12')`): повторное обследование бросает новые монеты. `exact` — без
 * ошибок: показывает правду (сложность «Студент», 03-game-design.md §14).
 */
export function runExam(db: ContentDb, patient: Patient, examId: Id, rng: Rng, skill: ExamSkill = NORMAL_SKILL, exact = false): Observation[] {
  const exam = db.exams[examId];
  if (!exam) throw new Error(`runExam: unknown exam ${examId}`);
  const present = new Map(patient.truth.findings.map(x => [x.f, x]));
  // О том, на что пациент пожаловался сам, не переспрашивают: ответ уже известен без ошибки.
  const told = new Set(patient.complaints);
  return exam.checks.filter(check => !told.has(check.f)).map(check => {
    const r = rng.fork(check.f);
    const truth = present.get(check.f);
    const { sens, spec } = exact ? { sens: P_ONE, spec: P_ONE } : effectiveCheck(check.sens, check.spec, skill);
    const shown = truth ? r.chance(sens) : r.chance(P_ONE - spec);
    const finding = db.findings[check.f];
    const obs: Observation = { f: check.f, shown, exam: examId };
    if (finding.value) {
      // Верный результат показывает истинное значение, ложный — значение из «чужого» диапазона.
      obs.value = shown === Boolean(truth)
        ? patient.truth.values[check.f]
        : sampleRange(r.fork('value'), shown ? finding.value.present : finding.value.absent, finding.value.decimals);
    }
    if (shown && finding.attrs) {
      obs.attrs = truth?.attrs ?? Object.fromEntries(Object.keys(finding.attrs).sort().map(a => [a, r.fork(a).pick(Object.keys(finding.attrs![a]).sort())]));
    }
    return obs;
  });
}

/** Жалобы, которые пациент называет сам, — наблюдения без ошибок. */
export function complaintObservations(patient: Patient): Observation[] {
  const present = new Map(patient.truth.findings.map(x => [x.f, x]));
  return patient.complaints.map(f => {
    const attrs = present.get(f)?.attrs;
    return attrs ? { f, shown: true, attrs, exam: 'complaint' } : { f, shown: true, exam: 'complaint' };
  });
}
