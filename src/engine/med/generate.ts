// Рождение пациента (`docs/04-medical-model.md` §3–4).
//
// Каждый бросок берётся из своей именованной ветви зерна (`fork`), поэтому добавление
// новой записи в базу не сдвигает случайность у остальных признаков и золотые случаи
// меняются только там, где изменилась медицина.
import { byParams, byRule, byValue, crosses, paramsHold, type Condition, type ContentDb, type Id, type Link, type Onset, type Risk, type Season } from '../../content/types';
import { P_ONE, Rng } from '../core/rng';
import { checkRule, type Who as RuleWho } from './rules';
import type { ActiveCondition, Patient, Sex, TrueFinding } from './types';

export interface GenContext {
  department: Id;
  /**
   * из болезней каких отделений основное заболевание: больница с приёмным принимает и хирургию
   * (spec 2026-09-chapter-2, часть 30); нет — только `department`
   */
  departments?: readonly Id[];
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
  /**
   * везёт скорая (spec 2026-09-chapter-2, части 27 и 30): вес основного заболевания у этого
   * человека умножается на вес его тяжести (0 — такое не везут); осмотры и болезни без лечения
   * не везут. Человек — прежде болезни: камни, привычки и возраст решают, чем он заболел
   */
  carried?: Readonly<Record<Condition['severity'], number>>;
  /**
   * пришёл сам (spec 2026-10-chapter-3, часть 41а): того, с чем приходят только со скорой, у него
   * нет — инсульт привозят в смотровую приёмного
   */
  walkIn?: boolean;
  /**
   * «Разнообразие» из настроек (spec 2026-10-variety, 0.3.11): основное заболевание — по сглаженным
   * весу записи и сезону (`VARIETY_POWER`); человек и вывод — как в жизни
   */
  variety?: boolean;
}

/**
 * Степень, в которую с «Разнообразием» берутся вес записи и сезонный множитель (spec
 * 2026-10-variety): при ½ ОРВИ и грипп остаются по 9–10 % пришедших, при 0 пропадает сезон.
 */
export const VARIETY_POWER = 0.25;

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
  const primaryId = ctx.primary ?? pickPrimary(db, root.fork('primary'), { sex, age, season: ctx.season, departments: ctx.departments ?? [ctx.department], risks, chronic, walkIn: ctx.walkIn === true }, ctx.carried, ctx.variety === true);
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
    // производный параметр (часть 32г) не бросается: его считают по признакам ниже
    for (const name of sortedKeys(c.params ?? {})) if (!c.derived?.[name]) params[name] = paramRng.fork(`${id}.${name}`).weightedKey(c.params![name]);
    if (id === primaryId) for (const [name, value] of Object.entries(ctx.params ?? {})) if (c.params?.[name]?.[value] !== undefined && !c.derived?.[name]) params[name] = value;
    const { day, stage } = id === primaryId ? presentationDay(c, courseRng.fork(id)) : { day: 0, stage: c.stages[0].id };
    return { id, role: id === primaryId ? 'primary' : 'comorbid', day, stage, params };
  });

  const findings = oneMeasure(db, followers(db, unmasked(db, conditions, realizeFindings(db, again('findings'), conditions, risks))));
  deriveParams(db, conditions, { age, sex }, findings);
  const values = realizeValues(db, again('values'), findings);
  // часы от начала (часть 39а): число признака — по долям записи, из своей ветви зерна
  if (primary.onset && findings.some(x => x.f === primary.onset!.f)) values[primary.onset.f] = onsetValue(primary.onset, root.fork('onset'));
  deriveByValue(db, conditions, values);
  deriveByParams(db, conditions);
  const complaints = pickComplaints(db, findings);

  // отделение пациента — его основного заболевания: в больнице с приёмным это и хирургия
  return { seed, sex, age, season: ctx.season, department: primary.department, truth: { conditions, risks, findings, values }, complaints };
}

/**
 * Пациент с заданной болезнью, у которого она обычна: бывает основной в его возрасте и с его
 * болезнями, а по полу не редкость — цистит у женщины (заданные первые пациенты главы, spec
 * 2026-09-campaign); `age` — ещё и в этом возрасте (часть 34б: аппендицит у молодого). Зёрна — по
 * порядку из ряда `seeds`: первое, где так; не нашлось — первое.
 */
export function typicalPatient(db: ContentDb, seeds: (k: number) => number, ctx: GenContext & { primary: Id }, tries = 16, age?: readonly [number, number]): Patient {
  const c = db.conditions[ctx.primary];
  let first: Patient | undefined;
  for (let k = 0; k < tries; k++) {
    const p = generatePatient(db, seeds(k), ctx);
    first ??= p;
    const chronic = p.truth.conditions.filter(x => x.role === 'comorbid').map(x => x.id);
    const fits = presentingWeight(c, { sex: p.sex, age: p.age, season: p.season, risks: p.truth.risks, chronic }) > 0;
    const aged = !age || (p.age >= age[0] && p.age <= age[1]);
    if (fits && aged && (!c.sex || 2 * c.sex[p.sex] >= Math.max(c.sex.m, c.sex.f))) return p;
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
  departments: readonly Id[];
  risks: readonly Id[];
  chronic: readonly Id[];
  /** пришёл сам: того, с чем только привозят (часть 41а), у него нет */
  walkIn?: boolean;
}

/** Вес состояния как основного заболевания у этого человека (0 — не бывает). */
export function presentingWeight(c: Condition, who: Omit<Who, 'departments'>): number {
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

/**
 * Вес для жребия с «Разнообразием» (spec 2026-10-variety): вес записи и сезон — в степени
 * `VARIETY_POWER`, пол, пик возраста, привычки и хронические болезни — как в жизни. Вывод врача
 * берёт прежний `presentingWeight`.
 */
function variedWeight(c: Condition, who: Omit<Who, 'departments'>): number {
  const w = presentingWeight(c, who);
  const base = c.weight * (c.season ? c.season[who.season] : 1);
  return w > 0 && base > 0 ? (w / base) * base ** VARIETY_POWER : 0;
}

function pickPrimary(db: ContentDb, rng: Rng, who: Who, carried?: GenContext['carried'], variety = false): Id {
  const ids = sortedKeys(db.conditions).filter(id => who.departments.includes(db.conditions[id].department) && !(who.walkIn && db.conditions[id].arrival === 'ambulance'));
  const base = ids.map(id => (variety ? variedWeight : presentingWeight)(db.conditions[id], who));
  // скорая: вес ещё и по тяжести; ничего из того, что везут, у этого человека не бывает — как пришёл сам
  const carriedBy = carried && ids.map((id, i) => base[i] * carriedWeight(db.conditions[id], carried));
  const w = carriedBy && carriedBy.some(x => Math.round(x * 100) > 0) ? carriedBy : base;
  return rng.weighted(ids.map((id, i) => ({ id, w: Math.round(w[i] * 100) })), x => x.w).id;
}

/** Множитель скорой: вес тяжести болезни; осмотры и болезни без лечения не везут. */
export function carriedWeight(c: Condition, carried: NonNullable<GenContext['carried']>): number {
  return c.checkup || !c.treatment ? 0 : carried[c.severity];
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

/**
 * Производные параметры (spec 2026-09-chapter-2, часть 32г): «yes», если правило решения выполнено
 * на настоящих признаках и возрасте, иначе «no» — показана ли КТ при сотрясении; по баллам шкалы
 * (часть 41б) — если их не меньше порога параметра: высокий риск по ABCD2; с частью 42а — и по полу
 * (CHA₂DS₂-VASc). Признаки от них не зависят (валидатор), поэтому считаются после признаков; новых
 * бросков нет. Уже посчитанные не трогает: так при загрузке досчитываются пациенты из сохранений до
 * появления параметра (часть 39в: коронарография в первые сутки при ОКС).
 */
export function deriveParams(db: ContentDb, conditions: ActiveCondition[], who: RuleWho, findings: readonly Pick<TrueFinding, 'f'>[]): void {
  const has = new Set(findings.map(x => x.f));
  for (const c of conditions) {
    for (const [name, d] of Object.entries(db.conditions[c.id].derived ?? {})) {
      const r = byRule(d);
      if (!r || c.params[name] !== undefined) continue;
      c.params[name] = checkRule(db.rules[r.rule], who, f => has.has(f), r.from).verdict === 'yes' ? 'yes' : 'no';
    }
  }
}

/**
 * Порог на измерении (spec 2026-10-chapter-3, часть 38б): «yes», если настоящее число признака
 * ниже порога, — сатурация ниже 90 %. Числа от параметров не зависят, поэтому считаются после них;
 * новых бросков нет. Уже посчитанные не трогает: так при загрузке досчитываются пациенты из
 * сохранений до 0.3.4 (`loadShift`), у них порогов нет.
 */
export function deriveByValue(db: ContentDb, conditions: ActiveCondition[], values: Record<Id, number>): void {
  for (const c of conditions) {
    for (const [name, d] of Object.entries(db.conditions[c.id].derived ?? {})) {
      if (!byValue(d) || c.params[name] !== undefined) continue;
      const v = values[d.f];
      c.params[name] = v !== undefined && crosses(d, v) ? 'yes' : 'no';
    }
  }
}

/**
 * По другим параметрам (spec 2026-10-chapter-3, часть 41а): «yes», если у каждого из `all` —
 * одно из названных значений, — тромбэктомия при окклюзии, NIHSS 6 и больше и меньше 6 часов от
 * начала. Считается после остальных производных; бросков нет. Уже посчитанные не трогает.
 */
export function deriveByParams(db: ContentDb, conditions: ActiveCondition[]): void {
  for (const c of conditions) {
    for (const [name, d] of Object.entries(db.conditions[c.id].derived ?? {})) {
      if (!byParams(d) || c.params[name] !== undefined) continue;
      c.params[name] = paramsHold(d, c.params) ? 'yes' : 'no';
    }
  }
}

/**
 * Окна по часам на момент решения (spec 2026-10-chapter-3, часть 41а): у порогов с ходом времени
 * (`clock`) к часам от начала прибавляются `minutes` от прихода до решения — окно тромболизиса
 * закрывается, пока идёт обследование; параметры по другим параметрам пересчитываются по ним.
 * Меняет параметры основного заболевания и возвращает прежние значения тех, что изменились.
 */
export function freezeClock(db: ContentDb, patient: Pick<Patient, 'truth'>, minutes: number): Record<string, string> {
  const primary = patient.truth.conditions.find(c => c.role === 'primary') ?? patient.truth.conditions[0];
  const derived = db.conditions[primary.id]?.derived ?? {};
  const before = { ...primary.params };
  for (const [name, d] of Object.entries(derived)) {
    if (!byValue(d) || !d.clock) continue;
    const v = patient.truth.values[d.f];
    if (v !== undefined) primary.params[name] = crosses(d, v + minutes / 60) ? 'yes' : 'no';
  }
  for (const [name, d] of Object.entries(derived)) {
    if (!byParams(d)) continue;
    primary.params[name] = paramsHold(d, primary.params) ? 'yes' : 'no';
  }
  return Object.fromEntries(Object.entries(before).filter(([k, v]) => primary.params[k] !== v));
}

/** Тот же пациент на `minutes` от прихода (часть 41а): копия с окнами по часам на это время; сам он не меняется. */
export function patientAt(db: ContentDb, patient: Patient, minutes: number): { patient: Patient; before: Record<string, string> } {
  const copy: Patient = { ...patient, truth: { ...patient.truth, conditions: patient.truth.conditions.map(c => ({ ...c, params: { ...c.params } })) } };
  return { patient: copy, before: freezeClock(db, copy, minutes) };
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

/** Сторона напротив (часть 41в): слабость справа — гематома в левом полушарии. */
const OPPOSITE: Record<string, string> = { right: 'left', left: 'right' };

function realizeAttrs(db: ContentDb, rng: Rng, f: Id, link: Link | undefined, cond: ActiveCondition | undefined): Record<string, string> | undefined {
  const options = db.findings[f]?.attrs;
  if (!options) return undefined;
  const attrs: Record<string, string> = {};
  for (const name of Object.keys(options).sort()) {
    const spec = link?.attrs?.[name];
    const r = rng.fork(name);
    if (spec && 'param' in spec && cond?.params[spec.param]) attrs[name] = spec.opposite ? OPPOSITE[cond.params[spec.param]] ?? cond.params[spec.param] : cond.params[spec.param];
    else if (spec && 'dist' in spec) attrs[name] = r.weightedKey(spec.dist);
    else if (spec && 'value' in spec) attrs[name] = spec.value;
    else attrs[name] = r.pick(Object.keys(options[name]).sort());
  }
  return attrs;
}

/**
 * Часов от начала болезни к приходу (spec 2026-10-chapter-3, часть 39а): интервал — по долям
 * записи, в нём — целые часы поровну, не меньше часа: больной говорит «около N ч назад», и по
 * этому числу видно, в окне ли он.
 */
export function onsetValue(o: Onset, rng: Rng): number {
  const k = rng.weighted(o.hours.map((_, i) => i), i => o.hours[i][1]);
  const lo = Math.max(1, k === 0 ? 0 : o.hours[k - 1][0]);
  return rng.range(lo, o.hours[k][0] - 1);
}

/**
 * Чего при состоянии не бывает (spec 2026-10-chapter-3, часть 39а): признак убран, откуда бы он ни
 * пришёл, — при анафилактическом шоке давление не высокое и у гипертоника. Монеты уже брошены,
 * поэтому расход случайности прежний.
 */
function unmasked(db: ContentDb, conditions: ActiveCondition[], findings: TrueFinding[]): TrueFinding[] {
  const masked = new Set(conditions.flatMap(c => db.conditions[c.id].masks ?? []));
  return masked.size > 0 ? findings.filter(x => !masked.has(x.f)) : findings;
}

/**
 * Признаки-последователи (spec 2026-10-chapter-3, часть 39а): есть у каждого, у кого есть хоть один
 * ведущий, — «плохо стало около N ч назад» говорит всякий, кому плохо остро, а не только больной
 * инфарктом; причина — та же, что у первого ведущего. Без бросков. С частью 43б — и цепочкой: одышка
 * есть у каждого, у кого она началась внезапно, а за одышкой — и время начала.
 */
function followers(db: ContentDb, findings: TrueFinding[]): TrueFinding[] {
  const present = new Map(findings.map(x => [x.f, x]));
  const added: TrueFinding[] = [];
  for (let grew = true; grew; ) {
    grew = false;
    for (const id of Object.keys(db.findings).sort()) {
      const leaders = db.findings[id].follows;
      if (!leaders || present.has(id)) continue;
      const lead = leaders.map(f => present.get(f)).find(x => x !== undefined);
      if (!lead) continue;
      const x = { f: id, cause: lead.cause };
      added.push(x);
      present.set(id, x);
      grew = true;
    }
  }
  return added.length > 0 ? [...findings, ...added].sort((a, b) => (a.f < b.f ? -1 : 1)) : findings;
}

/**
 * Одно измерение — одно число (часть 33б): есть порог на чужом измерении — низкое давление, — и
 * того, чьё это измерение, нет: давление не бывает сразу высоким и низким. Порог, который того не
 * снимает (часть 42б, `implies`: пульс 150 и чаще), — то измерение есть, с той же причиной: пульс 180 —
 * и чаще 100. Без бросков.
 */
function oneMeasure(db: ContentDb, findings: TrueFinding[]): TrueFinding[] {
  const taken = new Set<Id>();
  const added: TrueFinding[] = [];
  for (const x of findings) {
    const spec = db.findings[x.f]?.value;
    if (!spec?.of) continue;
    if (!spec.implies) taken.add(spec.of);
    else if (!findings.some(y => y.f === spec.of) && !added.some(y => y.f === spec.of)) added.push({ f: spec.of, cause: x.cause });
  }
  const kept = taken.size > 0 ? findings.filter(x => !taken.has(x.f)) : findings;
  return added.length > 0 ? [...kept, ...added].sort((a, b) => (a.f < b.f ? -1 : 1)) : kept;
}

/**
 * Истинные значения числовых показателей: из диапазона «есть» или «нет». У порога на чужом
 * измерении (часть 33б) число то же: есть порог — общее число из его диапазона «есть».
 */
function realizeValues(db: ContentDb, rng: Rng, findings: TrueFinding[]): Record<Id, number> {
  const present = new Set(findings.map(x => x.f));
  const values: Record<Id, number> = {};
  const shared: Id[] = [];
  for (const id of Object.keys(db.findings).sort()) {
    const spec = db.findings[id].value;
    if (!spec) continue;
    if (spec.of) {
      shared.push(id);
      continue;
    }
    values[id] = sampleRange(rng.fork(id), present.has(id) ? spec.present : spec.absent, spec.decimals);
  }
  for (const id of shared) {
    const spec = db.findings[id].value!;
    if (present.has(id)) values[spec.of!] = sampleRange(rng.fork(id), spec.present, spec.decimals);
  }
  // число одно на всех порогах этого измерения — и когда их два (низкое давление и 180/110 и выше, часть 43г): берут
  // его после всех, иначе у раннего по алфавиту осталось бы прежнее
  for (const id of shared) values[id] = values[db.findings[id].value!.of!];
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
