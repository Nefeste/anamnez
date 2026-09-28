// «Виртуальный врач» (`docs/05-content.md` §6, `docs/09-testing.md` §3): три стратегии,
// которыми проверяется база. Шаг разумного врача (`nextStep`) — и нанятый врач своей больницы
// (spec 2026-09-hired-doctors): тот делает шаги по одному, с порогами своего навыка.
import type { ContentDb, Id, Setting } from '../../content/types';
import { Rng } from '../core/rng';
import { complaintObservations, examFits, runExam } from './exams';
import { type Belief, expectedGain, knownFacts, posterior } from './infer';
import { choiceFor, type Plan, possibleFor, SETTING_ORDER, type Venue } from './plan';
import type { Observation, Patient } from './types';

export type Strategy = 'rational' | 'lazy' | 'shotgun';

export interface DoctorResult {
  diagnosis: Id;
  correct: boolean;
  /** верно с точностью до группы с одинаковой тактикой */
  correctGroup: boolean;
  /** уверенность в поставленном диагнозе в момент решения */
  confidence: number;
  exams: Id[];
  money: number;
  minutes: number;
  /** план лечения, который врач выбрал бы для своего диагноза */
  plan: Plan;
  /** всё, что врач узнал: жалобы и результаты */
  observations: Observation[];
}

export interface DoctorOptions {
  candidates: Id[];
  exams: Id[];
  /** при какой уверенности разумный врач ставит диагноз; 0,9 — по прогону прототипа (spec 2026-09-spikes) */
  threshold?: number;
  /** польза ниже этой (биты) — обследование не назначается; по умолчанию `MIN_GAIN` */
  minGain?: number;
  /** пропустить вопрос перед лечением — нанятый врач невысокого навыка (spec 2026-09-hired-doctors) */
  skipAsk?: (exam: Id) => boolean;
}

/** Польза ниже этой (биты) — обследование не показано: мерка разумного врача и экспертизы страховой. */
export const MIN_GAIN = 0.02;

/** Цена обследования в условных единицах: минуты, деньги, неприятность, облучение. */
export function examCost(db: ContentDb, id: Id): number {
  const e = db.exams[id];
  const minutes = e.time.procedure + (e.time.report ?? 0) + (e.time.turnaround ?? 0) * 0.25;
  const radiation = e.radiation === 'high' ? 40 : e.radiation === 'medium' ? 20 : e.radiation === 'low' ? 8 : 0;
  return minutes + e.cost / 100 + e.discomfort * 5 + radiation;
}

/**
 * Пользу сравниваем после округления: в ней логарифм, а его последний бит в Hermes, V8 и
 * JSC может разниться. Разница порядка 1e-16 не должна менять выбор врача (ADR 0004).
 */
const quantize = (x: number) => Math.round(x * 1e9);

/** Обследования, которые открывают противопоказание (вопрос об аллергиях), — самое дешёвое. */
function askingExam(db: ContentDb, contraindication: Id): Id | undefined {
  const telling = (db.risks[contraindication]?.findings ?? db.conditions[contraindication]?.findings ?? [])
    .map(l => l.f).filter(f => f.startsWith('hx.'));
  const exams = [...new Set(telling.flatMap(f => db.revealedBy[f] ?? []))];
  return exams.sort((a, b) => examCost(db, a) - examCost(db, b) || (a < b ? -1 : 1))[0];
}

/**
 * План для своего диагноза: препарат выбора без известных противопоказаний (иначе
 * первая допустимая замена) и место лечения — по умолчанию или выше, если врач видел
 * красный флаг этого состояния.
 */
/**
 * Типичное назначение и место лечения: что нужно пациенту по тому, что известно, — и что это
 * значит здесь (`venue`: своя палата со свободной койкой; нет — амбулатория).
 */
export function choosePlan(db: ContentDb, diagnosis: Id, observations: readonly Observation[], venue: Venue = {}): Plan {
  const t = db.conditions[diagnosis]?.treatment;
  if (!t) return { treatments: [], setting: 'home' };
  const known = knownFacts(db, observations);
  const blocked = new Set([...known.risks, ...known.conditions]);
  const ok = (tx: Id) => !db.treatments[tx].contraindications.some(k => blocked.has(k.id));
  const cures = (tx: Id) => db.treatments[tx].effects.some(e => e.on === diagnosis && e.kind === 'cure');
  // типичное назначение; если противопоказание убрало лечение причины — замена из первой линии и допустимых
  const treatments = (t.plan ?? t.firstLine).filter(ok);
  if (!treatments.some(cures)) {
    const alt = [...t.firstLine, ...t.acceptable].filter(ok).find(cures);
    if (alt && (t.plan ?? t.firstLine).some(cures)) treatments.push(alt);
  }
  const seen = new Set(observations.filter(o => o.shown).map(o => o.f));
  let setting = t.setting.default;
  const raise = (s: Setting) => {
    if (SETTING_ORDER[s] > SETTING_ORDER[setting]) setting = s;
  };
  if (t.setting.redFlag && (db.conditions[diagnosis].redFlags ?? []).some(f => seen.has(f))) raise(t.setting.redFlag);
  for (const r of t.setting.risks ?? []) if (known.risks.includes(r.id)) raise(r.setting);
  return { treatments: [...new Set(treatments)].sort(), setting: choiceFor(setting, venue) };
}

/**
 * Показано ли обследование сейчас: польза по тому, что уже известно, не ниже `MIN_GAIN` — так
 * решает разумный врач, так проверяет назначение страховая (spec 2026-09-own-hospital, часть 9).
 */
export function indicated(db: ContentDb, patient: Patient, obs: readonly Observation[], candidates: Id[], examId: Id): boolean {
  const known = knownFacts(db, obs);
  const ctx = { sex: patient.sex, age: patient.age, season: patient.season, knownRisks: known.risks, knownConditions: known.conditions };
  const beliefs = posterior(db, candidates, obs, ctx);
  return quantize(expectedGain(db, examId, beliefs, ctx, new Set(obs.map(o => o.f)))) >= quantize(MIN_GAIN);
}

/** Где разумный врач в приёме: ищет диагноз или, уже решив, спрашивает о противопоказаниях. */
export interface DoctorPhase {
  /** поставленный диагноз — дальше только вопросы перед лечением */
  diagnosis?: Id;
  /** уверенность в нём в момент решения */
  confidence?: number;
  /** вопросы перед лечением, которые осталось задать */
  ask?: Id[];
}

export type DoctorStep = { kind: 'exam'; exam: Id } | { kind: 'decide'; diagnosis: Id; confidence: number; plan: Plan };

export interface StepOptions {
  candidates: Id[];
  exams: Id[];
  /** при какой уверенности ставит диагноз */
  threshold: number;
  /** польза ниже этой (биты) — обследование не назначается */
  minGain: number;
  /** пропустить вопрос перед лечением — так забывает нанятый врач невысокого навыка */
  skipAsk?: (exam: Id) => boolean;
  /** что есть в больнице: своя палата со свободной койкой — стационар в ней (часть 26) */
  venue?: Venue;
}

/** Самое полезное на единицу цены из несделанных; польза ниже `minGain` — не назначается. */
function bestExam(db: ContentDb, beliefs: Belief[], ctx: Parameters<typeof expectedGain>[3], obs: readonly Observation[], done: readonly Id[], opt: StepOptions): Id | undefined {
  const observed = new Set(obs.map(o => o.f));
  let best: Id | undefined;
  let bestScore = 0;
  for (const id of opt.exams) {
    if (done.includes(id)) continue;
    const gain = expectedGain(db, id, beliefs, ctx, observed);
    if (quantize(gain) < quantize(opt.minGain)) continue;
    const score = quantize(gain / examCost(db, id));
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

/**
 * Шаг разумного врача по тому, что уже известно: следующее обследование или решение. Сначала —
 * вопросы, которые задают всем: польза вопроса о хронических болезнях в модели не видна
 * (сопутствующие считаются известными), а без него обострение ХОБЛ не узнать. Потом, пока
 * уверенность ниже порога, — самое полезное на единицу цены. Решив, — вопросы о
 * противопоказаниях к лечению (об аллергиях — перед антибиотиком; о беременности не
 * спрашивают мужчину и женщину 64 лет), и план.
 */
export function nextStep(db: ContentDb, patient: Patient, obs: readonly Observation[], done: readonly Id[], phase: DoctorPhase, options: StepOptions): { step: DoctorStep; phase: DoctorPhase } {
  // о месячных и беременности мужчину не спрашивают: только то, что пациенту подходит
  const opt = { ...options, exams: options.exams.filter(id => examFits(db.exams[id], patient)) };
  let now = phase;
  if (now.diagnosis === undefined) {
    const routine = opt.exams.find(id => db.exams[id].routine && !done.includes(id));
    if (routine) return { step: { kind: 'exam', exam: routine }, phase: now };
    const known = knownFacts(db, obs);
    const ctx = { sex: patient.sex, age: patient.age, season: patient.season, knownRisks: known.risks, knownConditions: known.conditions };
    const beliefs = posterior(db, opt.candidates, obs, ctx);
    if (beliefs[0].p < opt.threshold) {
      const best = bestExam(db, beliefs, ctx, obs, done, opt);
      if (best) return { step: { kind: 'exam', exam: best }, phase: now };
    }
    const top = beliefs[0];
    const plan = choosePlan(db, top.id, obs);
    const risks = [...new Set(plan.treatments.flatMap(tx => db.treatments[tx].contraindications.map(k => k.id)))].sort();
    const ask: Id[] = [];
    for (const k of risks) {
      if (!possibleFor(db, k, patient)) continue;
      const q = askingExam(db, k);
      if (q && !ask.includes(q) && opt.exams.includes(q) && !opt.skipAsk?.(q)) ask.push(q);
    }
    now = { diagnosis: top.id, confidence: top.p, ask };
  }
  const ask = (now.ask ?? []).filter(id => !done.includes(id));
  if (ask.length > 0) return { step: { kind: 'exam', exam: ask[0] }, phase: { ...now, ask: ask.slice(1) } };
  const diagnosis = now.diagnosis!;
  return { step: { kind: 'decide', diagnosis, confidence: now.confidence ?? 0, plan: choosePlan(db, diagnosis, obs, opt.venue) }, phase: { ...now, ask: [] } };
}

export function runDoctor(db: ContentDb, patient: Patient, strategy: Strategy, rng: Rng, opt: DoctorOptions): DoctorResult {
  const threshold = opt.threshold ?? 0.9;
  const minGain = opt.minGain ?? MIN_GAIN;
  const obs: Observation[] = complaintObservations(patient);
  const done: Id[] = [];
  const ctxOf = () => {
    const known = knownFacts(db, obs);
    return { sex: patient.sex, age: patient.age, season: patient.season, knownRisks: known.risks, knownConditions: known.conditions };
  };
  const doExam = (id: Id) => {
    obs.push(...runExam(db, patient, id, rng.fork(`exam:${done.length}:${id}`)));
    done.push(id);
  };

  let decision: { diagnosis: Id; confidence: number; plan: Plan };
  if (strategy === 'rational') {
    // шаги подряд — те же, что у нанятого врача по одному
    let phase: DoctorPhase = {};
    for (;;) {
      const r = nextStep(db, patient, obs, done, phase, { candidates: opt.candidates, exams: opt.exams, threshold, minGain, ...(opt.skipAsk ? { skipAsk: opt.skipAsk } : {}) });
      phase = r.phase;
      if (r.step.kind === 'decide') {
        decision = r.step;
        break;
      }
      doExam(r.step.exam);
    }
  } else {
    // «всё подряд» спрашивает и назначает всё; ленивый решает по жалобам
    if (strategy === 'shotgun') for (const id of opt.exams) if (examFits(db.exams[id], patient)) doExam(id);
    const top = posterior(db, opt.candidates, obs, ctxOf())[0];
    decision = { diagnosis: top.id, confidence: top.p, plan: choosePlan(db, top.id, obs) };
  }

  const primary = patient.truth.conditions.find(c => c.role === 'primary')!.id;
  const money = done.reduce((a, id) => a + db.exams[id].cost, 0);
  const minutes = done.reduce((a, id) => a + db.exams[id].time.procedure + (db.exams[id].time.report ?? 0) + (db.exams[id].time.turnaround ?? 0), 0);
  const group = (id: Id) => db.conditions[id]?.group ?? id;
  const { diagnosis, confidence, plan } = decision;
  return { diagnosis, correct: diagnosis === primary, correctGroup: group(diagnosis) === group(primary), confidence, exams: done, money, minutes, plan, observations: obs };
}
