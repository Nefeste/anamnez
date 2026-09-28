// Рождение пациента (`docs/04-medical-model.md` §3–4).
//
// Каждый бросок берётся из своей именованной ветви зерна (`fork`), поэтому добавление
// новой записи в базу не сдвигает случайность у остальных признаков и золотые случаи
// меняются только там, где изменилась медицина.
import type { Condition, ContentDb, Id, Link, Risk, Season } from '../../content/types';
import { P_ONE, Rng } from '../core/rng';
import type { ActiveCondition, Patient, Sex, TrueFinding } from './types';

export interface GenContext {
  department: Id;
  season: Season;
  /** задать основное заболевание (задания, «Случай дня», тесты) */
  primary?: Id;
  /**
   * Повторное обращение того же человека: пол, возраст, привычки, хронические болезни и
   * основное заболевание — те же (то же зерно), а течение и признаки бросаются заново —
   * это новый день болезни. 0 или нет — первое обращение.
   */
  visit?: number;
  /** заменить скрытые параметры основного заболевания: вернулся хуже — тяжёлая форма */
  params?: Record<string, string>;
}

/** Возрастная пирамида обращающихся взрослых: [от, до, вес]. Черновик для среза. */
const AGE_BANDS: [number, number, number][] = [
  [18, 29, 18],
  [30, 44, 24],
  [45, 59, 26],
  [60, 74, 22],
  [75, 90, 10],
];

/** Доля мужчин среди обращающихся, доли 1/10 000. */
const MALE_SHARE = 4600;

const sortedKeys = <T>(r: Record<string, T>) => Object.keys(r).sort();

export function generatePatient(db: ContentDb, seed: number, ctx: GenContext): Patient {
  const root = Rng.seeded(seed);
  const demo = root.fork('demo');

  const sex: Sex = demo.chance(MALE_SHARE) ? 'm' : 'f';
  const band = demo.weighted(AGE_BANDS, b => b[2]);
  const age = demo.range(band[0], band[1]);

  // Факторы риска: у каждого своя ветвь.
  const riskRng = root.fork('risks');
  const risks = sortedKeys(db.risks).filter(id => {
    const r = db.risks[id];
    const roll = riskRng.fork(id).chance(r.p[sex]);
    return roll && age >= (r.ageMin ?? 18) && age <= (r.ageMax ?? 200);
  });

  // Хронические (сопутствующие) болезни.
  const chronicRng = root.fork('chronic');
  const chronic = sortedKeys(db.conditions).filter(id => {
    const c = db.conditions[id];
    if (!c.chronic) return false;
    const roll = chronicRng.fork(id).int(P_ONE);
    if (age < (c.chronic.ageMin ?? c.age.min)) return false;
    return roll < chronicChance(c, risks);
  });

  // Основное заболевание.
  const primaryId = ctx.primary ?? pickPrimary(db, root.fork('primary'), { sex, age, season: ctx.season, department: ctx.department, risks, chronic });
  const primary = db.conditions[primaryId];
  if (!primary) throw new Error(`generatePatient: unknown condition ${primaryId}`);

  // Активные состояния: основное, то, без чего оно не бывает, и хронические.
  const activeIds = [primaryId, ...(primary.requires ?? []), ...chronic].filter((id, i, a) => a.indexOf(id) === i);
  const paramRng = root.fork('params');
  // у повторного обращения — свои ветви течения, признаков и значений: новый день болезни
  const again = (name: string) => root.fork(ctx.visit ? `${name}:visit${ctx.visit}` : name);
  const courseRng = again('course');
  const conditions: ActiveCondition[] = activeIds.map(id => {
    const c = db.conditions[id];
    const params: Record<string, string> = {};
    for (const name of sortedKeys(c.params ?? {})) params[name] = paramRng.fork(`${id}.${name}`).weightedKey(c.params![name]);
    if (id === primaryId) for (const [name, value] of Object.entries(ctx.params ?? {})) if (c.params?.[name]?.[value] !== undefined) params[name] = value;
    const { day, stage } = id === primaryId ? presentationDay(c, courseRng.fork(id)) : { day: 0, stage: c.stages[0].id };
    return { id, role: id === primaryId ? 'primary' : 'comorbid', day, stage, params };
  });

  const findings = realizeFindings(db, again('findings'), conditions, risks);
  const values = realizeValues(db, again('values'), findings);
  const complaints = pickComplaints(db, findings);

  return { seed, sex, age, season: ctx.season, department: ctx.department, truth: { conditions, risks, findings, values }, complaints };
}

/**
 * Пациент с заданной болезнью, у которого она обычна: бывает основной в его возрасте и с его
 * болезнями, а по полу не редкость — цистит у женщины (заданные первые пациенты главы, spec
 * 2026-09-campaign). Зёрна — по порядку из ряда `seeds`: первое, где так; не нашлось — первое.
 */
export function typicalPatient(db: ContentDb, seeds: (k: number) => number, ctx: GenContext & { primary: Id }, tries = 16): Patient {
  const c = db.conditions[ctx.primary];
  let first: Patient | undefined;
  for (let k = 0; k < tries; k++) {
    const p = generatePatient(db, seeds(k), ctx);
    first ??= p;
    const chronic = p.truth.conditions.filter(x => x.role === 'comorbid').map(x => x.id);
    const fits = presentingWeight(c, { sex: p.sex, age: p.age, season: p.season, risks: p.truth.risks, chronic }) > 0;
    if (fits && (!c.sex || 2 * c.sex[p.sex] >= Math.max(c.sex.m, c.sex.f))) return p;
  }
  return first!;
}

/** Вероятность хронической болезни с учётом факторов риска, доли 1/10 000, не выше 95 %. */
export function chronicChance(c: Condition, risks: readonly Id[]): number {
  if (!c.chronic) return 0;
  let p = c.chronic.p;
  for (const r of c.chronic.risks ?? []) if (risks.includes(r.id)) p *= r.x;
  return Math.min(9500, Math.round(p));
}

interface Who {
  sex: Sex;
  age: number;
  season: Season;
  department: Id;
  risks: readonly Id[];
  chronic: readonly Id[];
}

/** Вес состояния как основного заболевания у этого человека (0 — не бывает). */
export function presentingWeight(c: Condition, who: Omit<Who, 'department'>): number {
  if (!c.presenting) return 0;
  if (who.age < c.age.min || who.age > c.age.max) return 0;
  if ((c.requires ?? []).some(r => !who.chronic.includes(r))) return 0;
  if ((c.excludes ?? []).some(r => who.chronic.includes(r))) return 0;
  let w = c.weight;
  if (c.sex) w *= who.sex === 'm' ? c.sex.m : c.sex.f;
  if (c.season) w *= c.season[who.season];
  if (c.age.peak && who.age >= c.age.peak[0] && who.age <= c.age.peak[1]) w *= 2;
  for (const r of c.risks ?? []) if (who.risks.includes(r.id) || who.chronic.includes(r.id)) w *= r.x;
  return w;
}

function pickPrimary(db: ContentDb, rng: Rng, who: Who): Id {
  const ids = sortedKeys(db.conditions).filter(id => db.conditions[id].department === who.department);
  const weights = ids.map(id => Math.round(presentingWeight(db.conditions[id], who) * 100));
  return rng.weighted(ids.map((id, i) => ({ id, w: weights[i] })), x => x.w).id;
}

/**
 * День обращения: из окна `presentation` записи (когда с этой болезнью обычно приходят),
 * иначе — первая неделя. Стадия — та, что без лечения идёт в этот день; стадии, которые
 * наступают только при лечении (разрешение пневмонии), без лечения не наступают.
 */
function presentationDay(c: Condition, rng: Rng): { day: number; stage: string } {
  const natural = c.stages.filter(s => !s.needs);
  const first = natural[0] ?? c.stages[0];
  const last = natural[natural.length - 1] ?? first;
  const [lo, hi] = c.presentation ?? [first.days[0], Math.min(last.days[1], first.days[0] + 7)];
  const day = rng.range(lo, Math.max(lo, hi));
  const stage = natural.find(s => day >= s.days[0] && day < s.days[1]) ?? last;
  return { day, stage: stage.id };
}

function linkApplies(link: Link, cond: ActiveCondition | undefined): boolean {
  if (!cond) return true;
  if (link.stages && !link.stages.includes(cond.stage)) return false;
  if (link.when) for (const [param, allowed] of Object.entries(link.when)) if (!allowed.includes(cond.params[param])) return false;
  return true;
}

/**
 * Noisy-OR (ADR 0009): каждая причина пытается вызвать признак своей монетой, плюс фон.
 * Бросаются **все** монеты — так расход случайности не зависит от исхода, — а причиной
 * записывается первая сработавшая: основное заболевание, затем остальные, затем фон.
 */
function realizeFindings(db: ContentDb, rng: Rng, conditions: ActiveCondition[], risks: Id[]): TrueFinding[] {
  type Cause = { id: Id; links: Link[]; cond?: ActiveCondition };
  const causes: Cause[] = [
    ...conditions.map(c => ({ id: c.id, links: db.conditions[c.id].findings, cond: c })),
    ...risks.map(id => ({ id, links: (db.risks[id] as Risk).findings })),
  ];
  const candidates = new Set<Id>();
  for (const c of causes) for (const l of c.links) candidates.add(l.f);
  for (const id of Object.keys(db.findings)) if (db.findings[id].leak > 0) candidates.add(id);

  const out: TrueFinding[] = [];
  for (const f of [...candidates].sort()) {
    let cause: Id | 'leak' | undefined;
    let causeLink: Link | undefined;
    let causeCond: ActiveCondition | undefined;
    for (const c of causes) {
      c.links.forEach((link, i) => {
        if (link.f !== f || !linkApplies(link, c.cond)) return;
        const hit = rng.fork(`${c.id}>${f}#${i}`).chance(link.p);
        if (hit && cause === undefined) {
          cause = c.id;
          causeLink = link;
          causeCond = c.cond;
        }
      });
    }
    const leakHit = rng.fork(`leak>${f}`).chance(db.findings[f]?.leak ?? 0);
    if (cause === undefined && leakHit) cause = 'leak';
    if (cause === undefined) continue;
    const attrs = realizeAttrs(db, rng.fork(`attrs>${f}`), f, causeLink, causeCond);
    out.push(attrs ? { f, cause, attrs } : { f, cause });
  }
  return ensureManifest(db, rng, out, conditions[0]);
}

/**
 * Человек пришёл, потому что с ним что-то не так: если основная болезнь по жребию не дала
 * заметного симптома (жалобы), у неё появляется самый частый. Без этого часть пациентов
 * (ГЭРБ без изжоги, инфаркт без боли) приходила бы с одними фоновыми жалобами и была бы
 * неотличима от здоровых. Исключение — то, что находят без жалоб, на профосмотре
 * (`checkup`): там достаточно любого признака. Новых бросков для остальных признаков
 * нет — золотые случаи меняются только у таких пациентов.
 */
function ensureManifest(db: ContentDb, rng: Rng, out: TrueFinding[], primary: ActiveCondition): TrueFinding[] {
  const cond = db.conditions[primary.id];
  const salient = (f: Id) => db.findings[f]?.kind === 'sym' && db.findings[f].salience >= 2;
  const need = cond.checkup ? () => true : salient;
  if (out.some(x => x.cause === primary.id && need(x.f))) return out;
  let links = cond.findings.filter(l => l.p > 0 && linkApplies(l, primary) && need(l.f));
  if (links.length === 0) links = cond.findings.filter(l => l.p > 0 && linkApplies(l, primary));
  if (links.length === 0 || out.some(x => x.cause === primary.id && links.some(l => l.f === x.f))) return out;
  const link = links.reduce((best, l) => (l.p > best.p ? l : best));
  const existing = out.find(x => x.f === link.f);
  if (existing) {
    existing.cause = primary.id;
    return out;
  }
  const attrs = realizeAttrs(db, rng.fork(`attrs>${link.f}`), link.f, link, primary);
  return [...out, attrs ? { f: link.f, cause: primary.id, attrs } : { f: link.f, cause: primary.id }].sort((a, b) => (a.f < b.f ? -1 : 1));
}

function realizeAttrs(db: ContentDb, rng: Rng, f: Id, link: Link | undefined, cond: ActiveCondition | undefined): Record<string, string> | undefined {
  const options = db.findings[f]?.attrs;
  if (!options) return undefined;
  const attrs: Record<string, string> = {};
  for (const name of Object.keys(options).sort()) {
    const spec = link?.attrs?.[name];
    const r = rng.fork(name);
    if (spec && 'param' in spec && cond?.params[spec.param]) attrs[name] = cond.params[spec.param];
    else if (spec && 'dist' in spec) attrs[name] = r.weightedKey(spec.dist);
    else if (spec && 'value' in spec) attrs[name] = spec.value;
    else attrs[name] = r.pick(Object.keys(options[name]).sort());
  }
  return attrs;
}

/** Истинные значения числовых показателей: из диапазона «есть» или «нет». */
function realizeValues(db: ContentDb, rng: Rng, findings: TrueFinding[]): Record<Id, number> {
  const present = new Set(findings.map(x => x.f));
  const values: Record<Id, number> = {};
  for (const id of Object.keys(db.findings).sort()) {
    const spec = db.findings[id].value;
    if (!spec) continue;
    values[id] = sampleRange(rng.fork(id), present.has(id) ? spec.present : spec.absent, spec.decimals);
  }
  return values;
}

/** Равномерно по сетке с шагом 10^-decimals; целочисленный жребий. */
export function sampleRange(rng: Rng, [lo, hi]: [number, number], decimals: number): number {
  const scale = 10 ** decimals;
  const steps = Math.round((hi - lo) * scale);
  return Math.round((lo * scale + rng.int(steps + 1))) / scale;
}

/**
 * Жалобы: заметные симптомы (заметность ≥ 2), не больше трёх. Сначала то, с чем пришёл, —
 * симптомы от болезней пациента, самые заметные первыми; фоновые (без причины в модели) —
 * только после них: человек с изжогой не начнёт рассказ с того, что иногда ноет спина.
 */
function pickComplaints(db: ContentDb, findings: TrueFinding[]): Id[] {
  const background = (x: TrueFinding) => (x.cause === 'leak' ? 1 : 0);
  return findings
    .filter(x => db.findings[x.f]?.kind === 'sym' && db.findings[x.f].salience >= 2)
    .sort((a, b) => background(a) - background(b) || db.findings[b.f].salience - db.findings[a.f].salience || (a.f < b.f ? -1 : 1))
    .slice(0, 3)
    .map(x => x.f);
}
