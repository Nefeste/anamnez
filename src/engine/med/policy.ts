// «Виртуальный врач» (`docs/05-content.md` §6, `docs/09-testing.md` §3): три стратегии,
// которыми проверяется база. Шаг разумного врача (`nextStep`) — и нанятый врач своей больницы
// (spec 2026-09-hired-doctors): тот делает шаги по одному, с порогами своего навыка.
import type { ContentDb, Id, Setting } from '../../content/types';
import { Rng } from '../core/rng';
import { complaintObservations, examFits, runExam } from './exams';
import { type Belief, contextOf, expectedGain, knownFacts, likelyParams, paramBeliefs, paramGain, posterior } from './infer';
import { choiceFor, type Plan, possibleFor, SETTING_ORDER, tacticsFor, txAvailable, type Venue, whenHolds } from './plan';
import { openRuleExams, ruleExams } from './rules';
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
 * Типичное назначение и место лечения для своего диагноза: что нужно пациенту по тому, что
 * известно, — и что это значит здесь (`venue`: своя палата со свободной койкой; нет —
 * амбулатория). Препарат выбора без известных противопоказаний (иначе первая допустимая
 * замена); место — по умолчанию или выше, если врач видел красный флаг этого состояния. Скрытый
 * параметр болезни — по тому, что видно (часть 32): смещение на снимке — репозиция, нестабильный
 * перелом — операция; производный — по правилу решения и возрасту `age` (часть 32г): показана КТ
 * при сотрясении — перевод. Операцию выбирают местом «В операционную», не в назначении.
 */
export function choosePlan(db: ContentDb, diagnosis: Id, observations: readonly Observation[], age: number, venue: Venue = {}): Plan {
  const base = db.conditions[diagnosis]?.treatment;
  if (!base) return { treatments: [], setting: 'home' };
  const params = likelyParams(db, diagnosis, observations, age);
  const t = tacticsFor(base, params);
  const known = knownFacts(db, observations);
  const blocked = new Set([...known.risks, ...known.conditions]);
  // и только то, что здесь можно (часть 39а): тромболизис — у постели под монитором
  const ok = (tx: Id) => !db.treatments[tx].contraindications.some(k => blocked.has(k.id)) && db.treatments[tx].kind !== 'surgery' && txAvailable(db, tx, venue);
  const cures = (tx: Id) => db.treatments[tx].effects.some(e => e.on === diagnosis && e.kind === 'cure' && whenHolds(e.when, params));
  // типичное назначение; если противопоказание убрало лечение причины — замена из первой линии и допустимых
  const treatments = (t.plan ?? t.firstLine).filter(ok);
  if (!treatments.some(cures)) {
    const alt = [...t.firstLine, ...t.acceptable].filter(ok).find(cures);
    if (alt && (t.plan ?? t.firstLine).some(cures)) treatments.push(alt);
  }
  // обязательная профилактика по вероятным значениям (часть 32г-2): о прививках спрашивает, пока не уверен
  treatments.push(...(t.prevent ?? []).filter(ok));
  // обязательное по вероятным значениям (часть 38б): кислород, если измеренная сатурация ниже порога
  treatments.push(...(t.require ?? []).filter(ok).filter(tx => !treatments.includes(tx)));
  // обязательное и при переводе (часть 39а): тромболизис в окне, если здесь его можно сделать
  treatments.push(...(t.beforeTransfer ?? []).filter(ok).filter(tx => !treatments.includes(tx)));
  // спутники назначенного (часть 39а): тромболизис — с клопидогрелом и антикоагулянтом; из группы — первое,
  // что можно
  for (const tx of [...treatments]) {
    for (const g of db.treatments[tx].companions ?? []) {
      const group = typeof g === 'string' ? [g] : g;
      const pick = group.find(ok);
      if (pick && !group.some(c => treatments.includes(c))) treatments.push(pick);
    }
  }
  const seen = new Set(observations.filter(o => o.shown).map(o => o.f));
  let setting = t.setting.default;
  const raise = (s: Setting) => {
    if (SETTING_ORDER[s] > SETTING_ORDER[setting]) setting = s;
  };
  if (t.setting.param) {
    const s = t.setting.param.map[params[t.setting.param.name]];
    if (s) raise(s);
  }
  if (t.setting.redFlag && (db.conditions[diagnosis].redFlags ?? []).some(f => seen.has(f))) raise(t.setting.redFlag);
  for (const r of t.setting.risks ?? []) if (known.risks.includes(r.id)) raise(r.setting);
  return { treatments: [...new Set(treatments)].sort(), setting: choiceFor(setting, venue) };
}

/**
 * Обследования сроков по жалобам пациента (spec 2026-10-chapter-3, часть 37): ЭКГ при давящей боли
 * в груди — в первые 10 минут от первого контакта с медиком, где бы он ни был (`157_5`, раздел 2.4).
 * Срок оценивается только у лежащих в смотровой приёмного (`shift/targets.ts`), а делают первым везде.
 */
export function targetExams(db: ContentDb, patient: Patient): Id[] {
  return [...new Set(Object.values(db.targets).filter(t => t.complaints.some(f => patient.complaints.includes(f))).flatMap(t => t.exams))].sort();
}

/**
 * Показано ли обследование сейчас: польза по тому, что уже известно, не ниже `MIN_GAIN` — так
 * решает разумный врач, так проверяет назначение страховая (spec 2026-09-own-hospital, часть 9).
 * Велит его положительное правило решения — показано всегда (часть 32д); отрицательное не
 * запрещает: «снимок можно не делать» — не «нельзя». Правило ещё не решено, и обследование узнает
 * то, что для него осталось, — тоже показано (часть 33а: шкала Уэллса меньше двух — D-димер).
 */
export function indicated(db: ContentDb, patient: Patient, obs: readonly Observation[], candidates: Id[], examId: Id): boolean {
  // рекомендация велит его каждому с такой жалобой (часть 33а: снимок груди при травме груди, таза и
  // бедра — при боли в бедре) — показано
  const e = db.exams[examId];
  if (e?.routine || e?.routineFor?.some(f => patient.complaints.includes(f))) return true;
  // срок по жалобе (часть 37): ЭКГ при давящей боли в груди — показана всегда
  if (targetExams(db, patient).includes(examId)) return true;
  // велит положительное правило решения — показано, какой бы малой ни была польза (часть 32д)
  if (ruleExams(db, patient, obs).includes(examId)) return true;
  // правило ещё не решено — узнать, что осталось (часть 33а)
  if (openRuleExams(db, patient, obs).includes(examId)) return true;
  const ctx = contextOf(db, patient, obs);
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
 * Скрытые параметры болезни, от которых зависит лечение (часть 32): место по параметру, тактика
 * по параметру и операция по параметру (часть 32б) — смещение отломков, стабильность перелома.
 */
export function tacticParams(db: ContentDb, condId: Id): string[] {
  const t = db.conditions[condId]?.treatment;
  if (!t) return [];
  const byOp = (db.conditions[condId]?.surgery?.byParam ?? []).flatMap(b => Object.keys(b.when));
  return [...new Set([...(t.setting.param ? [t.setting.param.name] : []), ...(t.byParam ?? []).flatMap(b => Object.keys(b.when)), ...byOp])].sort();
}

/**
 * Обследование, которое уточнит то, от чего зависит лечение при этом диагнозе (часть 32): пока
 * значение параметра не достигло порога уверенности — самое полезное для него на единицу цены;
 * польза ниже `minGain` — не назначается. Перелом со штыкообразной деформацией — ещё снимок:
 * смещён он или нестабилен, решает он.
 */
function tacticExam(db: ContentDb, diagnosis: Id, obs: readonly Observation[], age: number, done: readonly Id[], opt: StepOptions): Id | undefined {
  let best: Id | undefined;
  let bestScore = 0;
  for (const name of tacticParams(db, diagnosis)) {
    const top = paramBeliefs(db, diagnosis, name, obs, age).reduce((a, b) => Math.max(a, b.p), 0);
    if (top >= opt.threshold) continue;
    for (const id of opt.exams) {
      if (done.includes(id)) continue;
      const gain = paramGain(db, diagnosis, name, id, obs, age);
      if (quantize(gain) < quantize(opt.minGain)) continue;
      const score = quantize(gain / examCost(db, id));
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }
  }
  return best;
}

/** Пункция и дренаж (часть 32в): их, как и операцию, не делают без подтверждающего снимка. */
const invasive = (db: ContentDb, tx: Id) => db.treatments[tx]?.class?.startsWith('drainage.') === true;

/**
 * Нужна операция, пункция или дренаж, а подтверждающего обследования из рекомендации ещё нет —
 * самое дешёвое из доступных (часть 32; пункцию и дренирование не выполняют, не убедившись в
 * характере содержимого плевральной полости, — 728_2, раздел 2.4). Без них его не требуем: грипп
 * лечат и без экспресс-теста.
 */
function confirmBeforeInvasive(db: ContentDb, diagnosis: Id, obs: readonly Observation[], age: number, done: readonly Id[], exams: readonly Id[]): Id | undefined {
  const c = db.conditions[diagnosis];
  if (!c || c.confirm === 'clinical' || c.confirm.some(id => done.includes(id))) return undefined;
  const plan = choosePlan(db, diagnosis, obs, age, { ward: true, or: true });
  if (plan.setting !== 'surgery' && !plan.treatments.some(tx => invasive(db, tx))) return undefined;
  return c.confirm.filter(id => exams.includes(id)).sort((a, b) => examCost(db, a) - examCost(db, b) || (a < b ? -1 : 1))[0];
}

/**
 * Шаг разумного врача по тому, что уже известно: следующее обследование или решение. Сначала —
 * вопросы, которые задают всем: польза вопроса о хронических болезнях в модели не видна
 * (сопутствующие считаются известными), а без него обострение ХОБЛ не узнать. Затем — что велят
 * правила решения и что нужно, чтобы они решились (часть 33а). Потом, пока уверенность ниже
 * порога, — самое полезное на единицу цены. Решив, — вопросы о
 * противопоказаниях к лечению (об аллергиях — перед антибиотиком; о беременности не
 * спрашивают мужчину и женщину 64 лет), и план.
 */
export function nextStep(db: ContentDb, patient: Patient, obs: readonly Observation[], done: readonly Id[], phase: DoctorPhase, options: StepOptions): { step: DoctorStep; phase: DoctorPhase } {
  // о месячных и беременности мужчину не спрашивают: только то, что пациенту подходит
  const opt = { ...options, exams: options.exams.filter(id => examFits(db.exams[id], patient)) };
  let now = phase;
  if (now.diagnosis === undefined) {
    // срок по жалобе (часть 37) — первым делом: при давящей боли в груди ЭКГ, ещё до расспроса
    const urgent = targetExams(db, patient).find(id => opt.exams.includes(id) && !done.includes(id));
    if (urgent) return { step: { kind: 'exam', exam: urgent }, phase: now };
    // вопросы всем и то, что делают каждому с такой жалобой (часть 32г-2: неврологический осмотр при ране головы)
    const routine = opt.exams.find(id => (db.exams[id].routine || db.exams[id].routineFor?.some(f => patient.complaints.includes(f))) && !done.includes(id));
    if (routine) return { step: { kind: 'exam', exam: routine }, phase: now };
    // положительное правило решения велит обследование — его делают (часть 32д): оттавские правила
    // сказали «снимок нужен», и снимок делают, даже почти уверившись в ушибе
    const ruled = ruleExams(db, patient, obs).find(id => opt.exams.includes(id) && !done.includes(id));
    if (ruled) return { step: { kind: 'exam', exam: ruled }, phase: now };
    // правило к жалобе ещё не решено — узнать, что осталось (часть 33а): то, что проверит больше
    // оставшихся признаков, поровну — дешевле; при шкале Уэллса меньше двух — D-димер, и только
    // повышенный ведёт на УЗИ
    const open = openRuleExams(db, patient, obs, id => examCost(db, id)).find(id => opt.exams.includes(id) && !done.includes(id));
    if (open) return { step: { kind: 'exam', exam: open }, phase: now };
    const ctx = contextOf(db, patient, obs);
    const beliefs = posterior(db, opt.candidates, obs, ctx);
    if (beliefs[0].p < opt.threshold) {
      const best = bestExam(db, beliefs, ctx, obs, done, opt);
      if (best) return { step: { kind: 'exam', exam: best }, phase: now };
    }
    const top = beliefs[0];
    // диагноз ясен — уточняет то, от чего зависит лечение (часть 32): смещение отломков видно на снимке
    const tactic = tacticExam(db, top.id, obs, patient.age, done, opt);
    if (tactic) return { step: { kind: 'exam', exam: tactic }, phase: now };
    // перед операцией, пункцией и дренажом — подтверждающее обследование из рекомендации (части
    // 32 и 32в): нестабильный перелом с деформацией не оперируют, пневмоторакс не дренируют без снимка
    const confirm = confirmBeforeInvasive(db, top.id, obs, patient.age, done, opt.exams);
    if (confirm) return { step: { kind: 'exam', exam: confirm }, phase: now };
    // что здесь можно (часть 39а): о противопоказаниях тромболизиса спрашивают там, где его делают
    const plan = choosePlan(db, top.id, obs, patient.age, opt.venue);
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
  return { step: { kind: 'decide', diagnosis, confidence: now.confidence ?? 0, plan: choosePlan(db, diagnosis, obs, patient.age, opt.venue) }, phase: { ...now, ask: [] } };
}

export function runDoctor(db: ContentDb, patient: Patient, strategy: Strategy, rng: Rng, opt: DoctorOptions): DoctorResult {
  const threshold = opt.threshold ?? 0.9;
  const minGain = opt.minGain ?? MIN_GAIN;
  const obs: Observation[] = complaintObservations(patient);
  const done: Id[] = [];
  const ctxOf = () => contextOf(db, patient, obs);
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
    decision = { diagnosis: top.id, confidence: top.p, plan: choosePlan(db, top.id, obs, patient.age) };
  }

  const primary = patient.truth.conditions.find(c => c.role === 'primary')!.id;
  const money = done.reduce((a, id) => a + db.exams[id].cost, 0);
  const minutes = done.reduce((a, id) => a + db.exams[id].time.procedure + (db.exams[id].time.report ?? 0) + (db.exams[id].time.turnaround ?? 0), 0);
  const group = (id: Id) => db.conditions[id]?.group ?? id;
  const { diagnosis, confidence, plan } = decision;
  return { diagnosis, correct: diagnosis === primary, correctGroup: group(diagnosis) === group(primary), confidence, exams: done, money, minutes, plan, observations: obs };
}
