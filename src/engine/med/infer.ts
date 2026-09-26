// Уверенность так, как её считал бы идеальный врач на месте игрока, — только по
// открытому (`docs/04-medical-model.md` §10). Нужна подсказкам, оценке и разбору.
//
// Вывод состояние партии не меняет, поэтому здесь можно обычную математику с плавающей
// точкой и логарифмами (ADR 0004 запрещает их только в коде, меняющем состояние).
import type { Condition, ContentDb, Id, Link, Season } from '../../content/types';
import { P_ONE } from '../core/rng';
import { chronicChance, presentingWeight } from './generate';
import type { Observation, Sex } from './types';

export interface InferContext {
  sex: Sex;
  age: number;
  season: Season;
  /** что известно о пациенте наверняка: факторы риска и хронические болезни, о которых он сказал */
  knownRisks: Id[];
  knownConditions: Id[];
}

export interface Belief {
  id: Id;
  p: number;
}

/** Доля параметров случая, при которых связь действует (усреднение по скрытым параметрам). */
function linkWeight(cond: Condition | undefined, link: Link): number {
  if (!link.when || !cond?.params) return 1;
  let share = 1;
  for (const [param, allowed] of Object.entries(link.when)) {
    const dist = cond.params[param];
    if (!dist) continue;
    const total = Object.values(dist).reduce((a, b) => a + b, 0);
    const ok = allowed.reduce((a, v) => a + (dist[v] ?? 0), 0);
    share *= total > 0 ? ok / total : 0;
  }
  return share;
}

/** Вероятность вызвать признак хотя бы одной связью причины (без учёта стадии). */
function causeProbability(links: Link[], f: Id, cond?: Condition): number {
  let miss = 1;
  for (const l of links) if (l.f === f) miss *= 1 - (l.p / P_ONE) * linkWeight(cond, l);
  return 1 - miss;
}

/** P(признак есть | набор состояний и факторов риска) — noisy-OR с фоном. */
export function findingProbability(db: ContentDb, f: Id, conditions: readonly Id[], risks: readonly Id[]): number {
  let miss = 1 - (db.findings[f]?.leak ?? 0) / P_ONE;
  for (const id of conditions) {
    const c = db.conditions[id];
    if (c) miss *= 1 - causeProbability(c.findings, f, c);
  }
  for (const id of risks) {
    const r = db.risks[id];
    if (r) miss *= 1 - causeProbability(r.findings, f);
  }
  return 1 - miss;
}

/** Чувствительность и специфичность, с которыми наблюдение получено. Жалоба — без ошибок. */
function accuracy(db: ContentDb, o: Observation): { sens: number; spec: number } {
  if (o.exam === 'complaint') return { sens: 1, spec: 1 };
  const check = db.exams[o.exam]?.checks.find(c => c.f === o.f);
  return check ? { sens: check.sens / P_ONE, spec: check.spec / P_ONE } : { sens: 1, spec: 1 };
}

/**
 * Правдоподобие всех наблюдений одного признака. Ошибки обследований независимы только
 * при известной правде о признаке, поэтому скрытое «есть/нет» суммируется один раз на
 * признак: иначе два совпавших ответа об одном признаке считались бы двумя уликами.
 */
function findingLikelihood(db: ContentDb, f: Id, obs: readonly Observation[], conditions: readonly Id[], risks: readonly Id[]): number {
  const p = findingProbability(db, f, conditions, risks);
  let ifPresent = 1;
  let ifAbsent = 1;
  for (const o of obs) {
    const { sens, spec } = accuracy(db, o);
    ifPresent *= o.shown ? sens : 1 - sens;
    ifAbsent *= o.shown ? 1 - spec : spec;
  }
  return p * ifPresent + (1 - p) * ifAbsent;
}

function byFinding(observations: readonly Observation[]): Map<Id, Observation[]> {
  const m = new Map<Id, Observation[]>();
  for (const o of observations) {
    const list = m.get(o.f);
    if (list) list.push(o);
    else m.set(o.f, [o]);
  }
  return m;
}

/** Априорный вес кандидата с учётом того, что о пациенте известно. */
export function priorWeight(db: ContentDb, id: Id, ctx: InferContext): number {
  const c = db.conditions[id];
  // Требуемые хронические болезни, о которых неизвестно, считаем «возможными» с их
  // вероятностью у этого человека (упрощение среза: без учёта отрицательного ответа).
  const assumed = [...ctx.knownConditions, ...(c.requires ?? [])];
  let w = presentingWeight(c, { sex: ctx.sex, age: ctx.age, season: ctx.season, risks: ctx.knownRisks, chronic: assumed });
  for (const req of c.requires ?? []) {
    if (!ctx.knownConditions.includes(req)) w *= chronicChance(db.conditions[req], ctx.knownRisks) / P_ONE;
  }
  return w;
}

/**
 * Апостериорные вероятности кандидатов. Предположение — одно основное заболевание плюс
 * известные сопутствующие (`docs/04-medical-model.md` §10).
 */
export function posterior(db: ContentDb, candidates: readonly Id[], observations: readonly Observation[], ctx: InferContext): Belief[] {
  const grouped = byFinding(observations);
  const scored = candidates.map(id => {
    const set = [id, ...(db.conditions[id].requires ?? []), ...ctx.knownConditions];
    let w = priorWeight(db, id, ctx);
    for (const [f, obs] of grouped) {
      if (w === 0) break;
      w *= findingLikelihood(db, f, obs, set, ctx.knownRisks);
    }
    return { id, p: w };
  });
  const total = scored.reduce((a, b) => a + b.p, 0);
  return scored.map(b => ({ id: b.id, p: total > 0 ? b.p / total : 0 })).sort((a, b) => b.p - a.p || (a.id < b.id ? -1 : 1));
}

export function entropy(beliefs: readonly Belief[]): number {
  let h = 0;
  for (const b of beliefs) if (b.p > 0) h -= b.p * Math.log2(b.p);
  return h;
}

/**
 * Ожидаемая польза обследования в битах. Приближение среза: сумма пользы каждого
 * проверяемого признака по отдельности при текущей уверенности — точный перебор всех
 * сочетаний исходов стоит 2^k и для «виртуального врача» на тысячах пациентов дорог.
 */
export function expectedGain(db: ContentDb, examId: Id, beliefs: readonly Belief[], ctx: InferContext, observed: ReadonlySet<Id>): number {
  const exam = db.exams[examId];
  const h0 = entropy(beliefs);
  let gain = 0;
  for (const check of exam.checks) {
    if (observed.has(check.f)) continue;
    const sens = check.sens / P_ONE;
    const spec = check.spec / P_ONE;
    // P(«есть» | кандидат) для каждого кандидата
    const yes = beliefs.map(b => {
      const set = [b.id, ...(db.conditions[b.id].requires ?? []), ...ctx.knownConditions];
      const p = findingProbability(db, check.f, set, ctx.knownRisks);
      return sens * p + (1 - spec) * (1 - p);
    });
    let pYes = 0;
    beliefs.forEach((b, i) => (pYes += b.p * yes[i]));
    const hGiven = (shown: boolean) => {
      const norm = shown ? pYes : 1 - pYes;
      if (norm <= 0) return 0;
      return entropy(beliefs.map((b, i) => ({ id: b.id, p: (b.p * (shown ? yes[i] : 1 - yes[i])) / norm })));
    };
    gain += h0 - (pYes * hGiven(true) + (1 - pYes) * hGiven(false));
  }
  return Math.max(0, gain);
}

/** Что известно о пациенте наверняка — из ответов на вопросы (`hx.*`, связанных с риском или болезнью). */
export function knownFacts(db: ContentDb, observations: readonly Observation[]): { risks: Id[]; conditions: Id[] } {
  const shownHx = new Set(observations.filter(o => o.shown && o.f.startsWith('hx.')).map(o => o.f));
  const risks = Object.keys(db.risks).filter(id => db.risks[id].findings.some(l => shownHx.has(l.f))).sort();
  const conditions = Object.keys(db.conditions).filter(id => db.conditions[id].chronic && db.conditions[id].findings.some(l => shownHx.has(l.f))).sort();
  return { risks, conditions };
}
