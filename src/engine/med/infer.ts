// Уверенность так, как её считал бы идеальный врач на месте игрока, — только по
// открытому (`docs/04-medical-model.md` §10). Нужна подсказкам, оценке и разбору.
//
// По пользе обследования решают страховая песочницы и нанятые врачи — а это меняет состояние
// партии, поэтому логарифм здесь свой, из `core/math.ts` (ADR 0004): одинаковый в Hermes, V8 и
// JavaScriptCore.
import type { Condition, ContentDb, DerivedByValue, Id, Link, Season } from '../../content/types';
import { log2 } from '../core/math';
import { P_ONE } from '../core/rng';
import { chronicChance, presentingWeight } from './generate';
import { checkRule, knownOf, type RuleVerdict } from './rules';
import type { Observation, Sex } from './types';

export interface InferContext {
  sex: Sex;
  age: number;
  season: Season;
  /** что известно о пациенте наверняка: факторы риска и хронические болезни, о которых он сказал */
  knownRisks: Id[];
  knownConditions: Id[];
  /** чего о нём не знают — хронические болезни и факторы риска с их долей (`unknownsOf`) */
  unknowns: Unknowns;
}

/**
 * Неизвестное о пациенте (spec 2026-09-chapter-2, часть 30): хронические болезни и факторы
 * риска, о которых он не сказал, — каждый с долей у такого человека. Камни в желчном пузыре
 * есть у каждого восьмого: найденные на УЗИ, они довод за колику, только если сравнить их с
 * этой долей; у пьющего панкреатит в 18 раз чаще — и, пока врач не спросил, в среднем по доле
 * пьющих.
 */
export interface Unknowns {
  /** доля у такого человека: пол, возраст, известные факторы риска и ответы «нет» о себе */
  share: ReadonlyMap<Id, number>;
  /** кто из них вызывает признак и с какой вероятностью (вопросы о себе — нет: их учла доля) */
  causes: ReadonlyMap<Id, readonly { id: Id; p: number }[]>;
}

export const NO_UNKNOWNS: Unknowns = { share: new Map(), causes: new Map() };

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

/** То же по таблице: связи записи не меняются, а вывод спрашивает о них на каждом признаке каждого кандидата. */
const causeTables = new WeakMap<readonly Link[], Map<Id, number>>();

function causeOf(links: Link[], f: Id, cond?: Condition): number {
  let table = causeTables.get(links);
  if (!table) {
    table = new Map();
    for (const l of links) if (!table.has(l.f)) table.set(l.f, causeProbability(links, l.f, cond));
    causeTables.set(links, table);
  }
  return table.get(f) ?? 0;
}

/**
 * P(признак есть | набор состояний и факторов риска) — noisy-OR с фоном. `unknown` — P(признака
 * нет) от того, чего о пациенте не знают (`unknownMiss`); нет — только известное.
 */
export function findingProbability(db: ContentDb, f: Id, conditions: readonly Id[], risks: readonly Id[], unknown = 1): number {
  let miss = (1 - (db.findings[f]?.leak ?? 0) / P_ONE) * unknown;
  for (const id of conditions) {
    const c = db.conditions[id];
    if (c) miss *= 1 - causeOf(c.findings, f, c);
  }
  for (const id of risks) {
    const r = db.risks[id];
    if (r) miss *= 1 - causeOf(r.findings, f);
  }
  return 1 - miss;
}

/**
 * Доли неизвестного у кандидата: то, без чего он не бывает, в наборе наверняка (0 — не фон);
 * фактор риска с множителем у кандидата — чаще: P(фактор | кандидат) = p·x / (p·x + 1 − p).
 */
export function sharesFor(db: ContentDb, id: Id, ctx: InferContext): ReadonlyMap<Id, number> {
  let byDb = sharesCache.get(db);
  if (!byDb) sharesCache.set(db, (byDb = new WeakMap()));
  let cache = byDb.get(ctx.unknowns);
  if (!cache) byDb.set(ctx.unknowns, (cache = new Map()));
  let out = cache.get(id);
  if (!out) cache.set(id, (out = candidateShares(db, id, ctx)));
  return out;
}

/**
 * Доли кандидата считаются один раз на базу и на то, что известно о пациенте: польза
 * обследований спрашивает их часто. Пустое неизвестное (`NO_UNKNOWNS`) одно на все базы — поэтому
 * ключ и по базе.
 */
const sharesCache = new WeakMap<ContentDb, WeakMap<Unknowns, Map<Id, ReadonlyMap<Id, number>>>>();

function candidateShares(db: ContentDb, id: Id, ctx: InferContext): Map<Id, number> {
  const c = db.conditions[id];
  const out = new Map<Id, number>();
  for (const r of c?.requires ?? []) out.set(r, 0);
  for (const r of c?.risks ?? []) {
    const p = ctx.unknowns.share.get(r.id);
    if (p !== undefined && !out.has(r.id)) out.set(r.id, (p * r.x) / (p * r.x + 1 - p));
  }
  return out;
}

/** P(признака нет) от неизвестного — с долями этого кандидата (`sharesFor`). */
export function unknownMiss(ctx: InferContext, f: Id, shares: ReadonlyMap<Id, number>): number {
  let miss = 1;
  for (const u of ctx.unknowns.causes.get(f) ?? []) miss *= 1 - (shares.get(u.id) ?? ctx.unknowns.share.get(u.id) ?? 0) * u.p;
  return miss;
}

/** Всё, что вывод знает о пациенте: пол, возраст, сезон, что он сказал о себе, и доли того, чего не сказал. */
export function contextOf(db: ContentDb, patient: { sex: Sex; age: number; season: Season }, observations: readonly Observation[]): InferContext {
  const known = knownFacts(db, observations);
  const base = { sex: patient.sex, age: patient.age, season: patient.season, knownRisks: known.risks, knownConditions: known.conditions };
  return { ...base, unknowns: unknownsOf(db, observations, base) };
}

/**
 * Неизвестные хронические болезни и факторы риска: доля у такого человека — как при рождении
 * пациента (пол, возраст, факторы риска: известные — множителем, неизвестные — в среднем), —
 * поправленная его ответами о себе: «о камнях не знает» — реже, чем у всех. Вопросы о себе
 * входят в долю, а не в фон признаков.
 */
export function unknownsOf(db: ContentDb, observations: readonly Observation[], ctx: Omit<InferContext, 'unknowns'>): Unknowns {
  const grouped = byFinding(observations);
  const share = new Map<Id, number>();
  const causes = new Map<Id, { id: Id; p: number }[]>();
  const add = (id: Id, p: number, links: Link[], cond?: Condition) => {
    if (p <= 0) return;
    let q = p;
    for (const f of new Set(links.map(l => l.f))) {
      const cause = causeOf(links, f, cond);
      const obs = grouped.get(f);
      if (f.startsWith('hx.')) {
        if (!obs) continue;
        const leak = (db.findings[f]?.leak ?? 0) / P_ONE;
        const yes = observationsLikelihood(db, obs, 1 - (1 - leak) * (1 - cause));
        const no = observationsLikelihood(db, obs, leak);
        q = (q * yes) / (q * yes + (1 - q) * no);
      } else {
        const list = causes.get(f);
        if (list) list.push({ id, p: cause });
        else causes.set(f, [{ id, p: cause }]);
      }
    }
    share.set(id, q);
  };
  for (const id of Object.keys(db.risks).sort()) {
    const r = db.risks[id];
    if (ctx.knownRisks.includes(id) || ctx.age < (r.ageMin ?? 18) || ctx.age > (r.ageMax ?? 200)) continue;
    add(id, r.p[ctx.sex] / P_ONE, r.findings);
  }
  for (const id of Object.keys(db.conditions).sort()) {
    const c = db.conditions[id];
    if (!c.chronic || ctx.knownConditions.includes(id) || ctx.age < (c.chronic.ageMin ?? c.age.min)) continue;
    // известный фактор риска — множителем (как при рождении пациента), неизвестный — в среднем по его доле
    let p = chronicChance(c, ctx.knownRisks) / P_ONE;
    for (const r of c.chronic.risks ?? []) {
      const q = share.get(r.id);
      if (q !== undefined) p *= 1 - q + q * r.x;
    }
    add(id, Math.min(p, 0.95), c.findings, c);
  }
  return { share, causes };
}

/** Чувствительность и специфичность, с которыми наблюдение получено. Жалоба — без ошибок. */
function accuracy(db: ContentDb, o: Observation): { sens: number; spec: number } {
  if (o.exam === 'complaint') return { sens: 1, spec: 1 };
  const check = db.exams[o.exam]?.checks.find(c => c.f === o.f);
  return check ? { sens: check.sens / P_ONE, spec: check.spec / P_ONE } : { sens: 1, spec: 1 };
}

/**
 * Правдоподобие всех наблюдений одного признака, если он есть с вероятностью `p`. Ошибки
 * обследований независимы только при известной правде о признаке, поэтому скрытое «есть/нет»
 * суммируется один раз на признак: иначе два совпавших ответа об одном признаке считались бы
 * двумя уликами.
 */
function observationsLikelihood(db: ContentDb, obs: readonly Observation[], p: number): number {
  return mix(evidenceOf(db, obs), p);
}

/** Наблюдения одного признака: насколько они вероятны, если он есть и если его нет, — от кандидата не зависит. */
interface Evidence {
  ifPresent: number;
  ifAbsent: number;
}

function evidenceOf(db: ContentDb, obs: readonly Observation[]): Evidence {
  let ifPresent = 1;
  let ifAbsent = 1;
  for (const o of obs) {
    const { sens, spec } = accuracy(db, o);
    ifPresent *= o.shown ? sens : 1 - sens;
    ifAbsent *= o.shown ? 1 - spec : spec;
  }
  return { ifPresent, ifAbsent };
}

const mix = (e: Evidence, p: number) => p * e.ifPresent + (1 - p) * e.ifAbsent;

function byFinding(observations: readonly Observation[]): Map<Id, Observation[]> {
  const m = new Map<Id, Observation[]>();
  for (const o of observations) {
    const list = m.get(o.f);
    if (list) list.push(o);
    else m.set(o.f, [o]);
  }
  return m;
}

/** Априорный вес кандидата с учётом того, что о пациенте известно и с какой долей — неизвестное. */
export function priorWeight(db: ContentDb, id: Id, ctx: InferContext): number {
  const c = db.conditions[id];
  const assumed = [...ctx.knownConditions, ...(c.requires ?? [])];
  let w = presentingWeight(c, { sex: ctx.sex, age: ctx.age, season: ctx.season, risks: ctx.knownRisks, chronic: assumed });
  const share = (x: Id) => ctx.unknowns.share.get(x) ?? 0;
  // требуемая хроническая болезнь, о которой не знают, — с её долей у этого человека
  for (const req of c.requires ?? []) if (!ctx.knownConditions.includes(req)) w *= share(req);
  // «впервые выявленная» бывает только у тех, у кого этого ещё нет
  for (const ex of c.excludes ?? []) if (!ctx.knownConditions.includes(ex)) w *= 1 - share(ex);
  // множитель риска, о котором не знают, — в среднем по его доле (часть 30)
  for (const r of c.risks ?? []) {
    if (ctx.knownRisks.includes(r.id) || assumed.includes(r.id)) continue;
    w *= 1 - share(r.id) + share(r.id) * r.x;
  }
  return w;
}

/** Сочетание значений скрытых параметров болезни: доля и вероятность каждого признака от её связей. */
interface Combo {
  share: number;
  causes: ReadonlyMap<Id, number>;
}

const comboCache = new WeakMap<Condition, Combo[]>();

/**
 * Сочетания значений тех скрытых параметров, от которых зависят признаки болезни (часть 33а), — с
 * долями. Признаки одного значения идут вместе: у тромбоза глубоких вен с тромбофлебитом есть и
 * тяж, и тромб в подкожной вене, и её ствол; в среднем по долям каждый из них по отдельности
 * говорил бы против тромбоза, хотя вместе они — его картина. Без таких параметров — одно сочетание.
 */
function combosOf(c: Condition): Combo[] {
  const cached = comboCache.get(c);
  if (cached) return cached;
  const names = [...new Set(c.findings.flatMap(l => Object.keys(l.when ?? {})))].filter(n => c.params?.[n]).sort();
  let combos: { values: Record<string, string>; share: number }[] = [{ values: {}, share: 1 }];
  for (const n of names) {
    const dist = c.params![n];
    const total = Object.values(dist).reduce((a, b) => a + b, 0);
    combos = combos.flatMap(k => Object.entries(dist).filter(([, w]) => w > 0).map(([v, w]) => ({ values: { ...k.values, [n]: v }, share: (k.share * w) / total })));
  }
  const out = combos.map(k => {
    const causes = new Map<Id, number>();
    for (const l of c.findings) {
      if (l.when && !Object.entries(l.when).every(([p, allowed]) => !c.params?.[p] || allowed.includes(k.values[p]))) continue;
      causes.set(l.f, 1 - (1 - (causes.get(l.f) ?? 0)) * (1 - l.p / P_ONE));
    }
    return { share: k.share, causes };
  });
  comboCache.set(c, out);
  return out;
}

/**
 * Апостериорные вероятности кандидатов. Предположение — одно основное заболевание плюс
 * известные сопутствующие (`docs/04-medical-model.md` §10). У болезни со скрытыми параметрами,
 * от которых зависят признаки, правдоподобие — сумма по сочетаниям их значений (часть 33а): так
 * признаки одного значения считаются вместе, а не порознь.
 */
export function posterior(db: ContentDb, candidates: readonly Id[], observations: readonly Observation[], ctx: InferContext): Belief[] {
  const grouped = [...byFinding(observations)].map(([f, obs]) => ({ f, e: evidenceOf(db, obs) }));
  const scored = candidates.map(id => {
    const c = db.conditions[id];
    const shares = sharesFor(db, id, ctx);
    const prior = priorWeight(db, id, ctx);
    const combos = combosOf(c);
    if (combos.length === 1) {
      const set = [id, ...(c.requires ?? []), ...ctx.knownConditions];
      let w = prior;
      for (const { f, e } of grouped) {
        if (w === 0) break;
        w *= mix(e, findingProbability(db, f, set, ctx.knownRisks, unknownMiss(ctx, f, shares)));
      }
      return { id, p: w };
    }
    if (prior === 0) return { id, p: 0 };
    // фон признака без самого кандидата — от сочетания не зависит, считается один раз
    const others = [...(c.requires ?? []), ...ctx.knownConditions];
    const bg = grouped.map(({ f, e }) => ({ f, e, other: findingProbability(db, f, others, ctx.knownRisks, unknownMiss(ctx, f, shares)) }));
    let w = 0;
    for (const k of combos) {
      let x = prior * k.share;
      for (const { f, e, other } of bg) {
        if (x === 0) break;
        x *= mix(e, 1 - (1 - other) * (1 - (k.causes.get(f) ?? 0)));
      }
      w += x;
    }
    return { id, p: w };
  });
  const total = scored.reduce((a, b) => a + b.p, 0);
  return scored.map(b => ({ id: b.id, p: total > 0 ? b.p / total : 0 })).sort((a, b) => b.p - a.p || (a.id < b.id ? -1 : 1));
}

export function entropy(beliefs: readonly Belief[]): number {
  let h = 0;
  for (const b of beliefs) if (b.p > 0) h -= b.p * log2(b.p);
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
  const shares = beliefs.map(b => sharesFor(db, b.id, ctx));
  let gain = 0;
  for (const check of exam.checks) {
    if (observed.has(check.f)) continue;
    const sens = check.sens / P_ONE;
    const spec = check.spec / P_ONE;
    // P(«есть» | кандидат) для каждого кандидата
    const yes = beliefs.map((b, i) => {
      const set = [b.id, ...(db.conditions[b.id].requires ?? []), ...ctx.knownConditions];
      const p = findingProbability(db, check.f, set, ctx.knownRisks, unknownMiss(ctx, check.f, shares[i]));
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

/**
 * P(признак | болезнь, параметр `name` = `value`) — связи с этим значением, остальные параметры —
 * в среднем по долям; плюс фон признака.
 */
function findingGivenParam(db: ContentDb, c: Condition, f: Id, name: string, value: string): number {
  let miss = 1 - (db.findings[f]?.leak ?? 0) / P_ONE;
  for (const l of c.findings) {
    if (l.f !== f || (l.when?.[name] && !l.when[name].includes(value))) continue;
    const others = l.when && Object.fromEntries(Object.entries(l.when).filter(([k]) => k !== name));
    miss *= 1 - (l.p / P_ONE) * linkWeight(c, others ? { ...l, when: others } : l);
  }
  return 1 - miss;
}

/** Признаки болезни, связи которых зависят от параметра, — только они различают его значения. */
const tellingOf = (c: Condition, name: string): Id[] => [...new Set(c.findings.filter(l => l.when?.[name]).map(l => l.f))];

/**
 * Скрытый параметр болезни по тому, что видно (spec 2026-09-chapter-2, часть 32): вероятность
 * каждого значения при этом диагнозе — его доля, умноженная на правдоподобие наблюдений тех
 * признаков, чьи связи от параметра зависят (смещение на снимке); остальные признаки значений не
 * различают. Порядок — как объявлены. Производный параметр (часть 32г) — по правилу решения на
 * известных признаках и возрасте пациента `age` (`derivedBeliefs`).
 */
export function paramBeliefs(db: ContentDb, condId: Id, name: string, observations: readonly Observation[], age: number): { value: string; p: number }[] {
  const c = db.conditions[condId];
  const dist = c?.params?.[name];
  if (!dist) return [];
  const derived = c.derived?.[name];
  if (typeof derived === 'string') return derivedBeliefs(dist, checkRule(db.rules[derived], age, knownOf(observations)).verdict);
  if (derived) return derivedBeliefs(dist, valueVerdict(derived, observations));
  const grouped = byFinding(observations);
  const telling = tellingOf(c, name).filter(f => grouped.has(f));
  const weighted = Object.entries(dist).map(([value, share]) => {
    let w = share;
    for (const f of telling) w *= mix(evidenceOf(db, grouped.get(f)!), findingGivenParam(db, c, f, name, value));
    return { value, p: w };
  });
  const total = weighted.reduce((a, b) => a + b.p, 0);
  return weighted.map(x => ({ value: x.value, p: total > 0 ? x.p / total : 0 }));
}

/**
 * Порог на измерении (часть 38б): число измерили — «yes», если последнее измеренное ниже порога;
 * не измеряли — пока неизвестно.
 */
function valueVerdict(d: DerivedByValue, observations: readonly Observation[]): RuleVerdict {
  const measured = observations.filter(o => o.f === d.f && o.value !== undefined);
  if (measured.length === 0) return 'unknown';
  return measured[measured.length - 1].value! < d.below ? 'yes' : 'no';
}

/**
 * Производный параметр (часть 32г): правило выполнено — «yes» наверняка, выполниться уже не может —
 * «no»; пока неизвестно — доли из записи (игровая оценка: сколько таких больных с показанием).
 */
function derivedBeliefs(dist: Record<string, number>, verdict: RuleVerdict): { value: string; p: number }[] {
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  return Object.entries(dist).map(([value, share]) => ({ value, p: verdict !== 'unknown' ? (value === verdict ? 1 : 0) : total > 0 ? share / total : 0 }));
}

/**
 * Самое вероятное значение каждого скрытого параметра болезни (часть 32); ничего такого не видно —
 * самое частое, при равенстве — объявленное раньше. `age` — возраст пациента: от него зависят
 * правила производных параметров (часть 32г).
 */
export function likelyParams(db: ContentDb, condId: Id, observations: readonly Observation[], age: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(db.conditions[condId]?.params ?? {})) {
    let best: { value: string; p: number } | undefined;
    for (const b of paramBeliefs(db, condId, name, observations, age)) if (!best || b.p > best.p) best = b;
    if (best) out[name] = best.value;
  }
  return out;
}

/**
 * Польза обследования для скрытого параметра, биты (часть 32): насколько оно в среднем уточнит
 * значение при этом диагнозе — сумма по проверяемым признакам, как у `expectedGain`. У производного
 * параметра (часть 32г) — приближение: вывод правила станет известен, когда проверят всё, что
 * осталось (`left`), поэтому польза — неопределённость, умноженная на долю оставшегося, которую
 * обследование проверит.
 */
export function paramGain(db: ContentDb, condId: Id, name: string, examId: Id, observations: readonly Observation[], age: number): number {
  const c = db.conditions[condId];
  const exam = db.exams[examId];
  if (!c || !exam) return 0;
  const beliefs = paramBeliefs(db, condId, name, observations, age);
  if (beliefs.length < 2) return 0;
  const derived = c.derived?.[name];
  if (typeof derived === 'string') {
    const { left } = checkRule(db.rules[derived], age, knownOf(observations));
    const covered = left.filter(f => exam.checks.some(k => k.f === f)).length;
    return left.length > 0 ? (entropy(beliefs.map(b => ({ id: b.value, p: b.p }))) * covered) / left.length : 0;
  }
  // порог на измерении (часть 38б): обследование, которое меряет число, снимает всю неопределённость
  if (derived) return exam.checks.some(k => k.f === derived.f) ? entropy(beliefs.map(b => ({ id: b.value, p: b.p }))) : 0;
  const observed = new Set(observations.map(o => o.f));
  const telling = new Set(tellingOf(c, name));
  const h0 = entropy(beliefs.map(b => ({ id: b.value, p: b.p })));
  let gain = 0;
  for (const check of exam.checks) {
    if (observed.has(check.f) || !telling.has(check.f)) continue;
    const sens = check.sens / P_ONE;
    const spec = check.spec / P_ONE;
    const yes = beliefs.map(b => {
      const q = findingGivenParam(db, c, check.f, name, b.value);
      return sens * q + (1 - spec) * (1 - q);
    });
    let pYes = 0;
    beliefs.forEach((b, i) => (pYes += b.p * yes[i]));
    const hGiven = (shown: boolean) => {
      const norm = shown ? pYes : 1 - pYes;
      if (norm <= 0) return 0;
      return entropy(beliefs.map((b, i) => ({ id: b.value, p: (b.p * (shown ? yes[i] : 1 - yes[i])) / norm })));
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
