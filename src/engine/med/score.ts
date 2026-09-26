// Оценка случая по категориям (`docs/04-medical-model.md` §10). Движок отдаёт буквы и коды
// замечаний; слова к ним — в src/i18n (на экране разбора).
import type { Id, Setting } from '../../content/types';
import type { Outcome } from './course';
import { type PlanEval, SETTING_ORDER } from './plan';

export type Grade = 'A' | 'B' | 'C' | 'D';

export type ScoreNote =
  | { code: 'tx.harmful' | 'tx.notIndicated' | 'tx.acceptable'; tx: Id }
  | { code: 'tx.noCure' | 'tx.none' }
  | { code: 'tx.preHospitalMissing'; tx: Id }
  | { code: 'setting.under' | 'setting.over'; recommended: Setting }
  | { code: 'safety.knownViolation' | 'safety.unaskedViolation'; tx: Id; by: Id }
  | { code: 'safety.notAsked'; by: Id }
  | { code: 'safety.redFlagIgnored' | 'safety.redFlagUnchecked'; f: Id }
  | { code: 'thrift.over'; times: number };

export interface CaseInput {
  verdict: 'correct' | 'partly' | 'wrong';
  /** уверенность идеального врача в поставленном диагнозе в момент решения, 0–1 */
  confidence: number;
  /** цена обследований игрока и разумного врача на этом пациенте (условные единицы) */
  cost: number;
  rationalCost: number;
  plan: PlanEval;
  outcome: Outcome;
  selfLimiting: boolean;
  /** красные флаги основного состояния, которые у пациента есть, и какие из них врач видел */
  redFlags: { f: Id; seen: boolean }[];
}

export interface CaseScore {
  accuracy: Grade;
  defensibility: Grade;
  thrift: Grade;
  treatment: Grade;
  setting: Grade;
  safety: Grade;
  overall: Grade;
  notes: ScoreNote[];
}

const POINTS: Record<Grade, number> = { A: 3, B: 2, C: 1, D: 0 };
const worst = (...g: Grade[]): Grade => g.reduce((a, b) => (POINTS[b] < POINTS[a] ? b : a), 'A');

export function scoreCase(x: CaseInput): CaseScore {
  const notes: ScoreNote[] = [];
  const accuracy: Grade = x.verdict === 'correct' ? 'A' : x.verdict === 'partly' ? 'B' : 'D';
  // верно при 30 % — «угадал», неверно при 90 % — «не повезло»: мерим рассуждение, а не удачу
  const defensibility: Grade = x.confidence >= 0.75 ? 'A' : x.confidence >= 0.5 ? 'B' : x.confidence >= 0.25 ? 'C' : 'D';

  const floor = Math.max(x.rationalCost, 10);
  const ratio = x.cost / floor;
  const thrift: Grade = ratio <= 1.25 ? 'A' : ratio <= 2 ? 'B' : ratio <= 3 ? 'C' : 'D';
  if (thrift !== 'A') notes.push({ code: 'thrift.over', times: Math.round(ratio * 10) / 10 });

  // лечение
  const roles = x.plan.roles;
  let treatment: Grade = 'A';
  for (const r of roles) {
    if (r.role === 'harmful') { treatment = 'D'; notes.push({ code: 'tx.harmful', tx: r.tx }); }
    if (r.role === 'notIndicated') { treatment = worst(treatment, x.plan.effective ? 'B' : 'C'); notes.push({ code: 'tx.notIndicated', tx: r.tx }); }
  }
  if (x.plan.violations.length > 0) treatment = 'D';
  // направленного лечат дальше в стационаре: лечения причины здесь не ждут, а то, что
  // делают до приезда скорой (ОКС — ацетилсалициловая кислота), — ждут
  const referred = SETTING_ORDER[x.plan.setting.chosen] > SETTING_ORDER.home;
  if (!x.plan.effective && !x.selfLimiting && !referred) { treatment = 'D'; notes.push({ code: 'tx.noCure' }); }
  if (referred && x.plan.preHospital.length > 0 && !roles.some(r => x.plan.preHospital.includes(r.tx))) {
    treatment = worst(treatment, 'B');
    notes.push({ code: 'tx.preHospitalMissing', tx: x.plan.preHospital[0] });
  }
  if (roles.length === 0 && x.selfLimiting) { treatment = worst(treatment, 'B'); notes.push({ code: 'tx.none' }); }
  if (x.plan.effective && !roles.some(r => r.role === 'firstLine')) {
    // замена препарата выбора оправдана, если о противопоказании к нему врач знал
    if (!x.plan.firstLineBlocked) treatment = worst(treatment, 'B');
    for (const r of roles.filter(r => r.role === 'acceptable')) notes.push({ code: 'tx.acceptable', tx: r.tx });
  }

  // место лечения
  const { chosen, recommended } = x.plan.setting;
  let setting: Grade = 'A';
  if (SETTING_ORDER[chosen] < SETTING_ORDER[recommended]) { setting = 'D'; notes.push({ code: 'setting.under', recommended }); }
  else if (SETTING_ORDER[chosen] > SETTING_ORDER[recommended]) { setting = 'C'; notes.push({ code: 'setting.over', recommended }); }

  // безопасность
  let safety: Grade = 'A';
  for (const v of x.plan.violations) {
    if (v.known) { safety = 'D'; notes.push({ code: 'safety.knownViolation', tx: v.tx, by: v.by }); }
    else { safety = worst(safety, 'C'); notes.push({ code: 'safety.unaskedViolation', tx: v.tx, by: v.by }); }
  }
  if (x.plan.violations.length === 0) {
    for (const by of x.plan.unaskedRisk) { safety = worst(safety, 'B'); notes.push({ code: 'safety.notAsked', by }); }
  }
  if (roles.some(r => r.role === 'harmful')) safety = worst(safety, 'C'); // вред — не только плохое лечение
  if (setting === 'D') {
    for (const r of x.redFlags) {
      if (r.seen) { safety = 'D'; notes.push({ code: 'safety.redFlagIgnored', f: r.f }); }
      else { safety = worst(safety, 'C'); notes.push({ code: 'safety.redFlagUnchecked', f: r.f }); }
    }
  }

  const weighted = 2 * POINTS[accuracy] + 2 * POINTS[treatment] + 2 * POINTS[safety] + POINTS[setting] + POINTS[defensibility] + POINTS[thrift];
  const mean = weighted / 9;
  let overall: Grade = mean >= 2.5 ? 'A' : mean >= 1.75 ? 'B' : mean >= 1 ? 'C' : 'D';
  if (safety === 'D') overall = worst(overall, 'C'); // опасное решение не бывает хорошим случаем
  return { accuracy, defensibility, thrift, treatment, setting, safety, overall, notes };
}
