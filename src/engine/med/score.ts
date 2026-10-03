// Оценка случая по категориям (`docs/04-medical-model.md` §10). Движок отдаёт буквы и коды
// замечаний; слова к ним — в src/i18n (на экране разбора).
import type { Id, Setting } from '../../content/types';
import type { Outcome } from './course';
import { choiceFor, type PlanEval, settingFit } from './plan';

export type Grade = 'A' | 'B' | 'C' | 'D';

export type ScoreNote =
  | { code: 'tx.harmful' | 'tx.notIndicated' | 'tx.acceptable'; tx: Id }
  | { code: 'tx.noCure' | 'tx.none' }
  | { code: 'tx.preHospitalMissing'; tx: Id }
  /** не назначена обязательная профилактика (часть 32г-2): анатоксин столбнячный, вакцина от бешенства */
  | { code: 'tx.preventMissing'; tx: Id }
  /** не назначено обязательное при лечении здесь (часть 38б): кислород при низкой сатурации; `when` — при каких значениях */
  | { code: 'tx.requireMissing'; tx: Id; when?: Record<string, string[]> }
  /** не сделано обязательное и при переводе (часть 39а): тромболизис при инфаркте в окне; `when` — при каких значениях */
  | { code: 'tx.beforeTransferMissing'; tx: Id; when?: Record<string, string[]> }
  /** назначено без своего спутника (часть 39а): тромболизис без клопидогрела */
  | { code: 'tx.companionMissing'; tx: Id; of: Id }
  /** `recommended` — что надо было выбрать здесь: в амбулатории «вызвать скорую», со своей палатой — «в палату» */
  | { code: 'setting.under' | 'setting.over'; recommended: Setting }
  | { code: 'safety.knownViolation' | 'safety.unaskedViolation'; tx: Id; by: Id }
  | { code: 'safety.notAsked'; by: Id }
  | { code: 'safety.redFlagIgnored' | 'safety.redFlagUnchecked'; f: Id }
  | { code: 'thrift.over'; times: number }
  /**
   * скорая (spec 2026-09-chapter-2, часть 27): врач отсортировал срочнее или спокойнее, чем шкала
   * NEWS2 с красными флагами; `flag` — признак, что поднял цвет выше баллов
   */
  | { code: 'triage.under' | 'triage.over'; triage: 'red' | 'yellow' | 'green'; news2: number; flag?: Id }
  /** операция (часть 28): через сколько часов от решения, в срок `window` болезни или позже; осложнение после неё */
  | { code: 'op.onTime' | 'op.late'; tx: Id; hours: number; window: number; onset?: true; observed?: true }
  | { code: 'op.complication'; tx: Id }
  /**
   * на момент разреза — осложнённая стадия болезни `of` (перфорация, часть 28б): часов от начала
   * болезни до операции; `before` — была уже при поступлении
   */
  | { code: 'op.complicated'; tx: Id; of: Id; hours: number; before: boolean };

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
  /** что выбрать здесь при нужном месте лечения; нет — как в амбулатории (plan.ts, choiceFor) */
  should?: Setting;
  /** оценки сроков приёма (spec 2026-10-chapter-3, часть 37): ЭКГ при боли в груди за 10 минут */
  targets?: Grade[];
}

export interface CaseScore {
  accuracy: Grade;
  defensibility: Grade;
  thrift: Grade;
  treatment: Grade;
  setting: Grade;
  safety: Grade;
  /** сроки (часть 37): худшая из оценок сроков приёма; нет — сроков у приёма не было */
  targets?: Grade;
  overall: Grade;
  notes: ScoreNote[];
}

const POINTS: Record<Grade, number> = { A: 3, B: 2, C: 1, D: 0 };
const worst = (...g: Grade[]): Grade => g.reduce((a, b) => (POINTS[b] < POINTS[a] ? b : a), 'A');
/** Худшая из оценок; пусто — A. */
export const worstGrade = (grades: readonly Grade[]): Grade => worst(...grades);

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
  // безопасность, которую решает уже лечение: пропущенная профилактика (часть 32г-2)
  let safety0: Grade = 'A';
  for (const r of roles) {
    if (r.role === 'harmful') { treatment = 'D'; notes.push({ code: 'tx.harmful', tx: r.tx }); }
    if (r.role === 'notIndicated') { treatment = worst(treatment, x.plan.effective ? 'B' : 'C'); notes.push({ code: 'tx.notIndicated', tx: r.tx }); }
  }
  if (x.plan.violations.length > 0) treatment = 'D';
  // направленного лечат дальше в другом стационаре: лечения причины здесь не ждут, а то, что
  // делают до приезда скорой (ОКС — ацетилсалициловая кислота), — ждут; в своей палате и своей ПИТ
  // (часть 38а) лечат сами
  const referred = !['home', 'admit', 'surgery', 'icu'].includes(x.plan.setting.chosen);
  if (!x.plan.effective && !x.selfLimiting && !referred) { treatment = 'D'; notes.push({ code: 'tx.noCure' }); }
  if (referred && x.plan.preHospital.length > 0 && !roles.some(r => x.plan.preHospital.includes(r.tx))) {
    treatment = worst(treatment, 'B');
    notes.push({ code: 'tx.preHospitalMissing', tx: x.plan.preHospital[0] });
  }
  if (roles.length === 0 && x.selfLimiting) { treatment = worst(treatment, 'B'); notes.push({ code: 'tx.none' }); }
  // обязательная профилактика (часть 32г-2): рана заживёт и без неё, но столбняк и бешенство не
  // предупреждены — лечение неполное и опасное; переведённого прививают там, куда перевели
  if (!referred) {
    for (const tx of x.plan.preventMissing) {
      treatment = worst(treatment, 'C');
      safety0 = worst(safety0, 'C');
      notes.push({ code: 'tx.preventMissing', tx });
    }
    // обязательное при лечении здесь (часть 38б): гипоксемия без кислорода — лечение неполное и
    // опасное; переведённому кислород дают в дороге и там, куда везут
    for (const tx of x.plan.requireMissing) {
      treatment = worst(treatment, 'C');
      safety0 = worst(safety0, 'C');
      const when = x.plan.requireWhen[tx];
      notes.push({ code: 'tx.requireMissing', tx, ...(when ? { when } : {}) });
    }
  }
  // обязательное и при переводе (часть 39а): тромболизис в окне, если больной лежал под монитором, —
  // без него лечение неполное и опасное, куда бы больного ни везли
  for (const tx of x.plan.beforeTransferMissing) {
    treatment = worst(treatment, 'C');
    safety0 = worst(safety0, 'C');
    const when = x.plan.beforeTransferWhen[tx];
    notes.push({ code: 'tx.beforeTransferMissing', tx, ...(when ? { when } : {}) });
  }
  // спутники (часть 39а): тромболизис сопровождают АСК, клопидогрел и эноксапарин (157_5, раздел 3.2.3.1)
  for (const m of x.plan.companionsMissing) {
    treatment = worst(treatment, 'C');
    notes.push({ code: 'tx.companionMissing', tx: m.tx, of: m.of });
  }
  if (x.plan.effective && !roles.some(r => r.role === 'firstLine')) {
    // замена препарата выбора оправдана, если о противопоказании к нему врач знал
    if (!x.plan.firstLineBlocked) treatment = worst(treatment, 'B');
    for (const r of roles.filter(r => r.role === 'acceptable')) notes.push({ code: 'tx.acceptable', tx: r.tx });
  }

  // место лечения
  const { chosen, recommended, also } = x.plan.setting;
  const fit = settingFit(recommended, chosen, also);
  const should = x.should ?? choiceFor(recommended);
  let setting: Grade = 'A';
  if (fit === 'under') { setting = 'D'; notes.push({ code: 'setting.under', recommended: should }); }
  else if (fit === 'over') { setting = 'C'; notes.push({ code: 'setting.over', recommended: should }); }

  // безопасность
  let safety: Grade = safety0;
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

  // сроки (часть 37) — десятая доля общей; у приёма без срока общая — как прежде
  const targets = x.targets && x.targets.length > 0 ? worst(...x.targets) : undefined;
  const weighted = 2 * POINTS[accuracy] + 2 * POINTS[treatment] + 2 * POINTS[safety] + POINTS[setting] + POINTS[defensibility] + POINTS[thrift] + (targets ? POINTS[targets] : 0);
  const mean = weighted / (targets ? 10 : 9);
  let overall: Grade = mean >= 2.5 ? 'A' : mean >= 1.75 ? 'B' : mean >= 1 ? 'C' : 'D';
  if (safety === 'D') overall = worst(overall, 'C'); // опасное решение не бывает хорошим случаем
  return { accuracy, defensibility, thrift, treatment, setting, safety, ...(targets ? { targets } : {}), overall, notes };
}
