// Оценка случая по категориям (`docs/10-medical-model.md` §10). Движок отдаёт буквы и коды
// замечаний; слова к ним — в src/i18n (на экране разбора).
import type { Id, Setting } from '../../content/types';
import type { Outcome } from './course';
import { choiceFor, type PlanEval, settingFit, STAYS } from './plan';

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
  /**
   * окно закрылось, пока шло обследование (часть 41а): тромболизис был обязателен при поступлении, а к
   * решению — уже нет; `at` — минут от начала болезни до решения
   */
  | { code: 'tx.windowMissed'; tx: Id; at: number }
  /** `recommended` — что надо было выбрать здесь: в амбулатории «вызвать скорую», со своей палатой — «в палату» */
  | { code: 'setting.under' | 'setting.over'; recommended: Setting }
  /** заразного положили в общую палату (spec 2026-10-chapter-4, часть 49а): соседи по палате — контактные */
  | { code: 'setting.contacts' }
  | { code: 'safety.knownViolation' | 'safety.unaskedViolation'; tx: Id; by: Id }
  /**
   * спросили, а пациент о противопоказании не сказал (0.5.12): о своей аллергии знает не каждый, и расспрос ошибается —
   * врач не виноват, оценка безопасности не снижается
   */
  | { code: 'safety.deniedViolation'; tx: Id; by: Id }
  | { code: 'safety.notAsked'; by: Id }
  /**
   * обследование при противопоказании (spec 2026-10-chapter-4, часть 50а): пункты его правила у больного были; врач о
   * них знал или их не проверил
   */
  | { code: 'safety.examHarmKnown' | 'safety.examHarmUnchecked'; exam: Id; by: Id[] }
  | { code: 'safety.redFlagIgnored' | 'safety.redFlagUnchecked'; f: Id }
  | { code: 'thrift.over'; times: number }
  /** «Практикант» (spec 2026-10-trainee): обоснованность и бережливость не вошли в общую оценку */
  | { code: 'level.lenient' }
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
  | { code: 'op.complicated'; tx: Id; of: Id; hours: number; before: boolean }
  /**
   * первая мера тяжёлого (spec 2026-10-first-measures, часть 95): дана вовремя — до первой ступени; дана, когда стало хуже
   * на `steps` ступеней; не дана — за это время стало хуже на `steps`. `minutes` — от того, как положили в смотровую
   */
  | { code: 'measure.onTime'; tx: Id; minutes: number }
  | { code: 'measure.late'; tx: Id; minutes: number; steps: number }
  | { code: 'measure.missed'; tx: Id; steps: number };

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
  /**
   * острый период проходит в стационаре (часть 41а): у лежащего у нас инсульта без тромболизиса
   * лечение причины не обязательно — его нет, а стабилизирует ПИТ
   */
  settles?: boolean;
  /** красные флаги основного состояния, которые у пациента есть, и какие из них врач видел */
  redFlags: { f: Id; seen: boolean }[];
  /** что выбрать здесь при нужном месте лечения; нет — как в амбулатории (plan.ts, choiceFor) */
  should?: Setting;
  /** оценки сроков приёма (spec 2026-10-chapter-3, часть 37): ЭКГ при боли в груди за 10 минут */
  targets?: Grade[];
  /**
   * первые меры тяжёлого (spec 2026-10-first-measures, часть 95): назначение, через сколько минут дано (первой мерой или в
   * решении; нет — не дано) и на сколько ступеней к тому времени стало хуже
   */
  measures?: { tx: Id; steps: number; given?: number }[];
  /** умер в смотровой до решения (часть 95) */
  ed?: true;
  /**
   * «Практикант» (spec 2026-10-trainee): разбор мягче — обоснованность и бережливость считаются и видны, но в общую
   * оценку не входят: новичок назначает лишнее и ставит диагноз по подсказке, а учится на лечении и безопасности
   */
  lenient?: true;
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
/** Сколько минут нужно на обследование до тромболизиса при инсульте — осмотр, КТ с заключением, глюкоза (часть 41а, игровое правило). */
export const WORKUP_MINUTES = 60;
const worst = (...g: Grade[]): Grade => g.reduce((a, b) => (POINTS[b] < POINTS[a] ? b : a), 'A');
/** Худшая из оценок; пусто — A. */
export const worstGrade = (grades: readonly Grade[]): Grade => worst(...grades);

export function scoreCase(x: CaseInput): CaseScore {
  return scoreThrift(scoreBase(x), x.cost, x.rationalCost);
}

/**
 * Оценка без бережливости (spec 2026-10-engine-speed, ч. 1): всё, для чего не нужен разумный врач разбора. Те же
 * действия в том же порядке, что были в `scoreCase`; замечания — без замечания о бережливости и «мягком разборе», их
 * добавляет `scoreThrift`.
 */
export interface ScoreBase {
  verdict: CaseInput['verdict'];
  accuracy: Grade;
  defensibility: Grade;
  treatment: Grade;
  setting: Grade;
  safety: Grade;
  targets?: Grade;
  lenient: boolean;
  notes: ScoreNote[];
}

export function scoreBase(x: Omit<CaseInput, 'rationalCost'>): ScoreBase {
  const notes: ScoreNote[] = [];
  const accuracy: Grade = x.verdict === 'correct' ? 'A' : x.verdict === 'partly' ? 'B' : 'D';
  // верно при 30 % — «угадал», неверно при 90 % — «не повезло»: мерим рассуждение, а не удачу
  const defensibility: Grade = x.confidence >= 0.75 ? 'A' : x.confidence >= 0.5 ? 'B' : x.confidence >= 0.25 ? 'C' : 'D';

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
  // делают до приезда скорой (ОКС — ацетилсалициловая кислота), — ждут; в своей палате, своей ПИТ
  // (часть 38а), своей реанимации (spec 2026-10-chapter-4, часть 47) и своём боксе (часть 49а) лечат сами
  const referred = x.plan.setting.chosen !== 'home' && !STAYS.includes(x.plan.setting.chosen);
  // острый период проходит в стационаре (часть 41а): у лежащего у нас инсульта без тромболизиса — не
  // ошибка; дома он не пройдёт
  const settled = x.settles === true && x.plan.setting.chosen !== 'home';
  if (!x.plan.effective && !x.selfLimiting && !settled && !referred) { treatment = 'D'; notes.push({ code: 'tx.noCure' }); }
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
    // лечат здесь (часть 41а): обязательное и здесь, и до перевода уже названо выше — тромболизис при инсульте
    if (!referred && x.plan.requireMissing.includes(tx)) continue;
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
  // окно закрылось, пока шло обследование (часть 41а): тромболизис при инсульте — в первые 4,5 часа.
  // Оставалось меньше часа — успеть было нельзя: обследование до тромболизиса занимает около часа
  // (игровое правило), замечание — без оценки
  for (const m of x.plan.windowMissed ?? []) {
    if (m.left >= WORKUP_MINUTES) treatment = worst(treatment, 'C');
    notes.push({ code: 'tx.windowMissed', tx: m.tx, at: m.at });
  }
  if (x.plan.effective && !roles.some(r => r.role === 'firstLine')) {
    // замена препарата выбора оправдана, если о противопоказании к нему врач знал; первой линии у
    // тактики нет (часть 41а: инсульт) — и заменять нечего
    if (!x.plan.firstLineBlocked && !x.plan.noFirstLine) treatment = worst(treatment, 'B');
    for (const r of roles.filter(r => r.role === 'acceptable')) notes.push({ code: 'tx.acceptable', tx: r.tx });
  }

  // место лечения
  const { chosen, recommended, also } = x.plan.setting;
  const fit = settingFit(recommended, chosen, also);
  const should = x.should ?? choiceFor(recommended);
  let setting: Grade = 'A';
  if (fit === 'under') { setting = 'D'; notes.push({ code: 'setting.under', recommended: should }); }
  else if (fit === 'over') { setting = 'C'; notes.push({ code: 'setting.over', recommended: should }); }
  // заразный в общей палате (spec 2026-10-chapter-4, часть 49а): кроме места — и соседи
  if (recommended === 'box' && chosen === 'admit') notes.push({ code: 'setting.contacts' });

  // безопасность
  let safety: Grade = safety0;
  for (const v of x.plan.violations) {
    if (v.known) { safety = 'D'; notes.push({ code: 'safety.knownViolation', tx: v.tx, by: v.by }); }
    else if (v.asked) notes.push({ code: 'safety.deniedViolation', tx: v.tx, by: v.by });
    else { safety = worst(safety, 'C'); notes.push({ code: 'safety.unaskedViolation', tx: v.tx, by: v.by }); }
  }
  if (x.plan.violations.length === 0) {
    for (const by of x.plan.unaskedRisk) { safety = worst(safety, 'B'); notes.push({ code: 'safety.notAsked', by }); }
  }
  // обследование при противопоказании (часть 50а): знал — опасное решение, не проверил — опасная небрежность; случилось ли
  // осложнение, скажет исход
  for (const h of x.plan.examHarms) {
    if (h.known) { safety = 'D'; notes.push({ code: 'safety.examHarmKnown', exam: h.exam, by: h.by }); }
    else { safety = worst(safety, 'C'); notes.push({ code: 'safety.examHarmUnchecked', exam: h.exam, by: h.by }); }
  }
  if (roles.some(r => r.role === 'harmful')) safety = worst(safety, 'C'); // вред — не только плохое лечение
  if (setting === 'D') {
    for (const r of x.redFlags) {
      if (r.seen) { safety = 'D'; notes.push({ code: 'safety.redFlagIgnored', f: r.f }); }
      else { safety = worst(safety, 'C'); notes.push({ code: 'safety.redFlagUnchecked', f: r.f }); }
    }
  }

  // первые меры (часть 95): дана, когда успело стать хуже, — безопасность не выше B, с третьей ступени — C; не дана, а стало
  // хуже, — замечание (оценку снижает обязательное лечение, которого нет); умер в смотровой — D
  for (const m of x.measures ?? []) {
    if (m.given === undefined) {
      if (m.steps > 0) notes.push({ code: 'measure.missed', tx: m.tx, steps: m.steps });
    } else if (m.steps === 0) notes.push({ code: 'measure.onTime', tx: m.tx, minutes: m.given });
    else {
      safety = worst(safety, m.steps >= 3 ? 'C' : 'B');
      notes.push({ code: 'measure.late', tx: m.tx, minutes: m.given, steps: m.steps });
    }
  }
  if (x.ed) safety = 'D';

  // сроки (часть 37) — десятая доля общей; у приёма без срока общая — как прежде
  const targets = x.targets && x.targets.length > 0 ? worst(...x.targets) : undefined;
  const lenient = x.lenient === true;
  return { verdict: x.verdict, accuracy, defensibility, treatment, setting, safety, ...(targets ? { targets } : {}), lenient, notes };
}

/**
 * Бережливость и общая оценка (spec 2026-10-engine-speed, ч. 1): по цене обследований врача и разумного врача разбора.
 * Замечание о бережливости — первым, «мягкий разбор» — последним, как было в `scoreCase`.
 */
export function scoreThrift(b: ScoreBase, cost: number, rationalCost: number): CaseScore {
  const { verdict, accuracy, defensibility, treatment, setting, safety, targets, lenient } = b;
  const notes: ScoreNote[] = [];
  const floor = Math.max(rationalCost, 10);
  const ratio = cost / floor;
  const thrift: Grade = ratio <= 1.25 ? 'A' : ratio <= 2 ? 'B' : ratio <= 3 ? 'C' : 'D';
  if (thrift !== 'A') notes.push({ code: 'thrift.over', times: Math.round(ratio * 10) / 10 });
  notes.push(...b.notes);
  const reasoning = lenient ? 0 : POINTS[defensibility] + POINTS[thrift];
  const weighted = 2 * POINTS[accuracy] + 2 * POINTS[treatment] + 2 * POINTS[safety] + POINTS[setting] + reasoning + (targets ? POINTS[targets] : 0);
  const mean = weighted / ((lenient ? 7 : 9) + (targets ? 1 : 0));
  let overall: Grade = mean >= 2.5 ? 'A' : mean >= 1.75 ? 'B' : mean >= 1 ? 'C' : 'D';
  if (safety === 'D') overall = worst(overall, 'C'); // опасное решение не бывает хорошим случаем
  // неверный диагноз — тоже (решение владельца 15.10.2026, вопрос 13): «B · неверно» читалось похвалой за ошибку;
  // у «Практиканта» итог — среднее: он учится на лечении и безопасности
  if (verdict === 'wrong' && !lenient) overall = worst(overall, 'C');
  if (lenient && (defensibility !== 'A' || thrift !== 'A')) notes.push({ code: 'level.lenient' });
  return { accuracy, defensibility, thrift, treatment, setting, safety, ...(targets ? { targets } : {}), overall, notes };
}
