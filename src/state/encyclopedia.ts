// Энциклопедия (03-game-design.md §11, 05-content.md §4). Статьи собираются из тех же записей
// базы, по которым работает модель, — поэтому энциклопедия не может разойтись с игрой.
// Здесь только вид: разделы, статьи, поиск; экраны — src/app/encyclopedia. База приходит
// параметром, как у движка: тесты подставляют ту же собранную базу.
import {
  type Condition, type ContentDb, type Equipment, type Exam, type Finding, type Id, type Link, membersOf, type P, type Risk, type RoomType, type Rule, type RulePoints, type Score, type StaffRole, SYSTEMS,
  type Tactics, type Tip, type Treatment,
} from '@/content/types';
import { surgeriesOf } from '@/engine/med/plan';
import { pointsFrom } from '@/engine/med/rules';
import { formatNumber } from '@/engine/med/text';
import { T } from '@/i18n';
import { lowerFirst } from '@/i18n/case';
import { TX_GROUP_ORDER, txGroupOfClass, whenText } from './caseView';
import { sourceLine } from './sources';

export { whenText };

export type Section = 'conditions' | 'findings' | 'exams' | 'treatments' | 'risks' | 'scores' | 'hospital' | 'tips';
export const SECTIONS: Section[] = ['conditions', 'findings', 'exams', 'treatments', 'risks', 'scores', 'hospital', 'tips'];

/** Ссылка на статью; `note` — пометка рядом: частота, «в 2 раза чаще», точность. */
export interface Ref {
  id: Id;
  title: string;
  note?: string;
}

export interface Row {
  label: string;
  refs: Ref[];
}

/** Раздел статьи: текст, ряды ссылок с подписью, просто ссылки, пояснение мелко — что есть. */
export interface Block {
  key: string;
  title: string;
  text?: string[];
  rows?: Row[];
  refs?: Ref[];
  note?: string;
}

export interface Article {
  id: Id;
  section: Section;
  title: string;
  subtitle: string;
  blocks: Block[];
}

export interface SectionView {
  section: Section;
  title: string;
  groups: { key: string; title: string; items: Ref[] }[];
}

// --- общее ------------------------------------------------------------------------------

/** Полосы частоты (04-medical-model.md §4) в долях 1/10 000 — по ним частота словами. */
const BANDS = [
  ['always', 9500],
  ['usually', 7500],
  ['often', 5000],
  ['sometimes', 2500],
  ['rarely', 800],
  ['veryRarely', 200],
  ['never', 0],
] as const;
export type Band = (typeof BANDS)[number][0];

/** Ближайшая полоса: число из источника (6000) называется словом соседней полосы. */
/** Доля 1/10 000 — процентами с десятичной запятой: 413 → «4,13», 3 → «0,03». */
const pct = (p: P) => String(p / 100).replace('.', ',');

export function bandOf(p: P): Band {
  let best: (typeof BANDS)[number] = BANDS[0];
  for (const b of BANDS) if (Math.abs(b[1] - p) < Math.abs(best[1] - p)) best = b;
  return best[0];
}

export function sectionOf(db: ContentDb, id: Id): Section | undefined {
  if (db.conditions[id]) return 'conditions';
  if (db.findings[id]) return 'findings';
  if (db.exams[id]) return 'exams';
  if (db.treatments[id]) return 'treatments';
  if (db.risks[id]) return 'risks';
  if (db.scores[id] || db.rules[id]) return 'scores';
  if (db.rooms[id] || db.equipment[id] || db.roles[id]) return 'hospital';
  if (db.tips[id]) return 'tips';
  return undefined;
}

function nameOf(db: ContentDb, id: Id): string {
  return (db.conditions[id] ?? db.findings[id] ?? db.exams[id] ?? db.treatments[id] ?? db.risks[id] ?? db.scores[id] ?? db.rules[id] ?? db.rooms[id] ?? db.equipment[id] ?? db.roles[id] ?? db.tips[id])?.name.ru ?? id;
}

const ref = (db: ContentDb, id: Id, note?: string): Ref => (note ? { id, title: nameOf(db, id), note } : { id, title: nameOf(db, id) });
const byTitle = (a: { title: string }, b: { title: string }) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);
const unique = (xs: string[]) => [...new Set(xs)];

/**
 * У признака в записи бывает несколько связей (по тяжести, по типу) — берём самую частую. Одинаково
 * частые при всех значениях одного параметра — без условия (часть 43а): рвущая боль при расслоении
 * аорты — у 85 из 100 и при типе A, и при типе B, а связей две, потому что болит в разных местах.
 */
function strongest(links: readonly Link[], params?: Condition['params']): Link[] {
  const best = new Map<Id, Link>();
  for (const l of links) {
    const b = best.get(l.f);
    if (!b || l.p > b.p) best.set(l.f, l);
  }
  // условие у ряда — только для подписи: без него связь та же
  return [...best.values()].map(b => (params && everyValue(params, links.filter(l => l.f === b.f && l.p === b.p)) ? { f: b.f, p: b.p } : b));
}

/** Связи — каждая при значениях одного и того же параметра, а вместе — при всех его значениях. */
function everyValue(params: NonNullable<Condition['params']>, links: readonly Link[]): boolean {
  const names = new Set(links.map(l => Object.keys(l.when ?? {}).join('|')));
  const [name] = [...names];
  if (links.length < 2 || names.size !== 1 || name === undefined || !(name in params)) return false;
  const seen = new Set(links.flatMap(l => l.when?.[name] ?? []));
  return Object.keys(params[name]).every(v => seen.has(v));
}


/** Ряды «почти всегда / обычно / … / не бывает»; внутри ряда — по алфавиту. */
function byBand(db: ContentDb, items: { id: Id; p: P; note?: string }[]): Row[] {
  return BANDS.map(([band]) => ({
    label: T.encyclopedia.band[band],
    refs: items.filter(x => bandOf(x.p) === band).map(x => ref(db, x.id, x.note)).sort(byTitle),
  })).filter(r => r.refs.length > 0);
}

function sources(db: ContentDb, list: { sources: Condition['sources'] }): Block {
  return { key: 'sources', title: T.encyclopedia.sources, text: unique(list.sources.map(sourceLine)) };
}

// --- «с чем спутать» ----------------------------------------------------------------------

/** Порог сходства и сколько показывать: ниже порога — случайные совпадения (простуда и мигрень). */
const SIMILAR_MIN = 0.15;
const SIMILAR_MAX = 3;
const similarCache = new WeakMap<ContentDb, Map<Id, Id[]>>();

/**
 * Параметры болезни, от которых зависит только обязательная профилактика (часть 32г-2): прививки
 * от столбняка у раны и ожога — о человеке, а не о болезни, и признаки по ним болезни не различают.
 */
function preventOnly(c: Condition): Set<string> {
  const t = c.treatment;
  const other = new Set([...(t?.setting.param ? [t.setting.param.name] : []), ...(c.surgery?.byParam ?? []).flatMap(b => Object.keys(b.when))]);
  const prevent = new Set<string>();
  for (const b of t?.byParam ?? []) {
    const only = !b.plan && !b.preHospital && [b.firstLine, b.acceptable, b.supportive, b.notIndicated, b.harmful].every(l => l.length === 0);
    for (const k of Object.keys(b.when)) (only ? prevent : other).add(k);
  }
  return new Set([...prevent].filter(k => !other.has(k)));
}

/**
 * С чем спутать: болезни с похожим набором признаков (05-content.md §4). Сходство — взвешенный
 * Жаккар по частотам признаков: сумма меньших частот к сумме больших. Признаки, которые зависят
 * только от прививок (`preventOnly`), не считаются: иначе рана «похожа» на ожог по записям о
 * прививках от столбняка (часть 32д-2). Названное рекомендацией (`differential`, часть 33б) — первым
 * и в обе стороны: острую ишемию ноги путают с тромбозом вен, хотя признаки у них разные.
 */
export function similar(db: ContentDb, id: Id): Id[] {
  let cache = similarCache.get(db);
  if (!cache) {
    cache = new Map();
    const all = Object.values(db.conditions).filter(c => c.presenting);
    const own = (c: Condition) => {
      const skip = preventOnly(c);
      return c.findings.filter(l => !l.when || !Object.keys(l.when).every(k => skip.has(k)));
    };
    const vec = new Map(all.map(c => [c.id, new Map(strongest(own(c)).map(l => [l.f, l.p]))]));
    for (const c of all) {
      const a = vec.get(c.id)!;
      const scored = all
        .filter(o => o.id !== c.id)
        .map(o => {
          const b = vec.get(o.id)!;
          let lo = 0;
          let hi = 0;
          for (const f of new Set([...a.keys(), ...b.keys()])) {
            lo += Math.min(a.get(f) ?? 0, b.get(f) ?? 0);
            hi += Math.max(a.get(f) ?? 0, b.get(f) ?? 0);
          }
          return { id: o.id, s: hi > 0 ? lo / hi : 0 };
        })
        .filter(x => x.s >= SIMILAR_MIN)
        .sort((x, y) => y.s - x.s || (x.id < y.id ? -1 : 1));
      const named = all.filter(o => c.differential?.includes(o.id) || o.differential?.includes(c.id)).map(o => o.id).sort();
      cache.set(c.id, [...named, ...scored.map(x => x.id).filter(x => !named.includes(x))].slice(0, Math.max(SIMILAR_MAX, named.length)));
    }
    similarCache.set(db, cache);
  }
  return cache.get(id) ?? [];
}

// --- статьи -------------------------------------------------------------------------------

/** Тактика: подпись в статье болезни и, если есть, в статье лечения («первая линия при …»). */
const TACTICS: {
  key: keyof Omit<Tactics, 'setting' | 'byParam'>;
  label: 'firstLine' | 'plan' | 'acceptable' | 'supportive' | 'notIndicated' | 'harmful' | 'prevent' | 'require' | 'beforeTransfer' | 'preHospital';
  forLabel?: 'firstLineFor' | 'planFor' | 'acceptableFor' | 'supportiveFor' | 'harmfulFor' | 'preventFor' | 'requireFor' | 'beforeTransferFor' | 'preHospitalFor';
}[] = [
  { key: 'firstLine', label: 'firstLine', forLabel: 'firstLineFor' },
  { key: 'plan', label: 'plan', forLabel: 'planFor' },
  { key: 'acceptable', label: 'acceptable', forLabel: 'acceptableFor' },
  { key: 'supportive', label: 'supportive', forLabel: 'supportiveFor' },
  // «не нужно при» у лекарства — почти вся база (антибиотик — при мигрени…): список короткий
  // и по делу только в статье болезни
  { key: 'notIndicated', label: 'notIndicated' },
  { key: 'harmful', label: 'harmful', forLabel: 'harmfulFor' },
  // обязательная профилактика (часть 32г-2): анатоксин столбнячный при просроченной прививке
  { key: 'prevent', label: 'prevent', forLabel: 'preventFor' },
  // обязательное при лечении здесь (часть 38б): кислород через маску при сатурации ниже порога
  { key: 'require', label: 'require', forLabel: 'requireFor' },
  // обязательное и при переводе (часть 39а): тромболизис при инфаркте с подъёмом ST в окне
  { key: 'beforeTransfer', label: 'beforeTransfer', forLabel: 'beforeTransferFor' },
  // до приезда скорой (часть 32д-2): при обширном ожоге — капельница до перевода
  { key: 'preHospital', label: 'preHospital', forLabel: 'preHospitalFor' },
];

function whereLines(db: ContentDb, c: Condition, t: Tactics): string[] {
  const e = T.encyclopedia;
  const s = t.setting;
  const lines = [e.whereDefault(e.setting[s.default])];
  // ПИТ нет в амбулатории и в районной больнице без неё — туда везёт скорая (часть 38а)
  if (s.default === 'icu') lines.push(e.whereNoIcu(e.setting.ambulance));
  for (const [value, set] of Object.entries(s.param?.map ?? {})) if (set !== s.default) lines.push(e.whereIf(whenText({ [s.param!.name]: [value] }) ?? value, e.setting[set]));
  if (s.redFlag && s.redFlag !== s.default) lines.push(e.whereRedFlag(e.setting[s.redFlag]));
  for (const r of s.risks ?? []) if (r.setting !== s.default) lines.push(e.whereRisk(nameOf(db, r.id), e.setting[r.setting]));
  // без аппарата у постели (часть 42б): приступ наджелудочковой тахикардии снимают под монитором
  if (s.without && s.without.setting !== s.default) lines.push(e.whereWithout(s.without.equipment.map(id => db.equipment[id]?.gen.ru ?? id), e.setting[s.without.setting]));
  // ПИТ не обычное место, но бывает нужна — без своей та же скорая
  const icu = [...Object.values(s.param?.map ?? {}), s.redFlag, ...(s.risks ?? []).map(r => r.setting), s.without?.setting];
  if (s.default !== 'icu' && icu.includes('icu')) lines.push(e.whereNoIcu(e.setting.ambulance));
  // операция и срок стационара (spec 2026-09-chapter-2, части 26 и 28), после осложнённой стадии — свой (28б)
  if (c.surgery) lines.push(e.whereSurgery(nameOf(db, c.surgery.tx), c.surgery.window, c.surgery.from === 'onset'));
  // операция по скрытому параметру (часть 32б): «Без смещения — остеосинтез шейки бедра винтами.»
  for (const b of c.surgery?.byParam ?? []) {
    const when = whenText(b.when);
    if (when) lines.push(e.whereIf(when, lowerFirst(nameOf(db, b.tx))));
  }
  // ещё места, которые не ошибка (часть 32б), — пока место не подняли красный флаг или риск
  const flags = !!s.redFlag && (c.redFlags?.length ?? 0) > 0;
  const risks = (s.risks?.length ?? 0) > 0;
  for (const a of s.also ?? []) {
    const when = whenText(a.when);
    if (when) lines.push(e.whereAlso(when, a.settings.map(x => e.setting[x]).join(', '), flags, risks));
  }
  // после обследования (часть 40): КТ без крови — дома, при оглушении — в стационар
  if (s.after) {
    const exams = s.after.exams.map(id => nameOf(db, id));
    lines.push(e.whereAfter(exams, e.setting[s.after.setting]));
    if (s.after.flags) lines.push(e.whereAfterFlags(exams, s.after.flags.any.map(f => nameOf(db, f)), e.setting[s.after.flags.setting]));
  }
  // без показаний к экстренной операции — наблюдение в палате, не помогло — операция в срок (часть 30в)
  if (c.surgery?.observe !== undefined) lines.push(e.whereObserve(c.surgery.observe));
  if (c.stay) lines.push(e.whereStay(c.stay[0], c.stay[1]));
  if (c.surgery?.stay) lines.push(e.whereStayOperated(c.surgery.stay[0], c.surgery.stay[1]));
  if (c.complication?.stay) lines.push(e.whereStayComplicated(c.complication.name.ru, c.complication.stay[0], c.complication.stay[1]));
  return lines;
}

function whoLines(c: Condition): string[] {
  const e = T.encyclopedia;
  const out: string[] = [];
  const peak = c.age.peak;
  if (peak) out.push(peak[1] >= 90 ? e.peakAfter(peak[0]) : e.peakBetween(peak[0], peak[1]));
  if (c.sex) {
    const r = c.sex.f > 0 ? c.sex.m / c.sex.f : Infinity;
    if (r <= 0.1) out.push(e.onlyWomen);
    else if (r <= 0.6) out.push(e.moreWomen);
    else if (r >= 10) out.push(e.onlyMen);
    else if (r >= 1.67) out.push(e.moreMen);
  }
  const season = Object.entries(c.season ?? {}).sort((a, b) => b[1] - a[1])[0] as [keyof typeof e.season, number] | undefined;
  if (season && season[1] >= 1.3) out.push(e.season[season[0]]);
  return out;
}

function conditionArticle(db: ContentDb, c: Condition): Article {
  const e = T.encyclopedia;
  const blocks: Block[] = [{ key: 'what', title: e.what, text: [c.texts.summary.ru] }];
  blocks.push({ key: 'signs', title: e.signs, rows: byBand(db, strongest(c.findings, c.params).map(l => ({ id: l.f, p: l.p, note: whenText(l.when) }))) });

  const who = whoLines(c);
  const whoRows: Row[] = [];
  if (c.requires?.length) whoRows.push({ label: e.requires, refs: c.requires.map(id => ref(db, id)) });
  if (c.risks?.length) whoRows.push({ label: e.riskFactors, refs: c.risks.map(r => ref(db, r.id, e.times(r.x))) });
  if (who.length > 0 || whoRows.length > 0) blocks.push({ key: 'who', title: e.who, text: who, rows: whoRows });

  blocks.push(c.confirm === 'clinical'
    ? { key: 'confirm', title: e.confirm, text: [e.clinical] }
    : { key: 'confirm', title: e.confirm, refs: c.confirm.map(id => ref(db, id)) });

  // правила решения (часть 32): оттавские — нужен ли снимок
  const rules = Object.values(db.rules).filter(r => r.about.includes(c.id)).map(r => ref(db, r.id));
  if (rules.length > 0) blocks.push({ key: 'rules', title: e.rulesFor, refs: rules });

  const alike = similar(db, c.id);
  if (alike.length > 0) blocks.push({ key: 'similar', title: e.similar, refs: alike.map(id => ref(db, id)) });

  const t = c.treatment;
  if (t) {
    // строки списка тактики: каждое — одной строкой, группа «одно из» (часть 39в) — своей
    const tacticRows = (label: string, list: readonly (Id | Id[])[] | undefined): Row[] => {
      const each = (list ?? []).filter((g): g is Id => typeof g === 'string');
      return [
        ...(each.length > 0 ? [{ label, refs: each.map(id => ref(db, id)) }] : []),
        ...(list ?? []).filter((g): g is Id[] => typeof g !== 'string').map(g => ({ label: e.oneOf(label), refs: g.map(id => ref(db, id)) })),
      ];
    };
    const rows = TACTICS.flatMap(k => tacticRows(e[k.label], t[k.key]));
    if (c.surgery) rows.unshift({ label: e.surgeryRow, refs: [ref(db, c.surgery.tx)] });
    // операция по скрытому параметру (часть 32б): «Операция, без смещения — остеосинтез винтами»
    for (const [i, b] of (c.surgery?.byParam ?? []).entries()) {
      const when = whenText(b.when);
      if (when) rows.splice(1 + i, 0, { label: e.byParamRow(e.surgeryRow, when), refs: [ref(db, b.tx)] });
    }
    // тактика по скрытому параметру (часть 32): «Первая линия, со смещением — …»
    for (const b of t.byParam ?? []) {
      const when = whenText(b.when);
      if (!when) continue;
      for (const k of TACTICS) rows.push(...tacticRows(e.byParamRow(e[k.label], when), b[k.key]));
    }
    blocks.push({ key: 'treatment', title: e.treatment, rows });
    blocks.push({ key: 'where', title: e.whereTitle, text: whereLines(db, c, t) });
  }

  const course: string[] = [];
  // течение может зависеть от скрытого параметра (часть 30д): «при неосложнённом — проходит само»
  if (c.selfLimiting) course.push(c.selfLimitingWhen ? e.selfLimitingIf(whenText(c.selfLimitingWhen) ?? '') : e.selfLimiting);
  // острый период проходит в стационаре (часть 41а): у инсульта — под наблюдением, последствия могут остаться;
  // нет лечения, которое бы их сняло (часть 41в: кровоизлияние в мозг), — остаются
  const clears = Object.values(db.treatments).some(x => x.effects.some(ef => ef.on === c.id && ef.kind === 'cure'));
  if (c.settles) course.push(clears ? e.settles : e.settlesResidual);
  // записей может быть несколько (часть 41б): риск инсульта после ТИА — по группе ABCD2, долей
  for (const u of c.untreated ?? []) {
    if (u.p <= 0) continue;
    course.push(u.as ? e.untreatedAs(pct(u.p), u.days[0], u.days[1], lowerFirst(nameOf(db, u.as)), whenText(u.when)) : e.untreated(e.band[bandOf(u.p)], u.days[0], u.days[1], whenText(u.when)));
  }
  const x = c.complication;
  if (x?.after !== undefined) course.push(e.complicationAfter(x.name.ru, x.after, whenText(x.when)));
  else if (x?.early && x.later) course.push(e.complicationRisk(x.name.ru, x.early.hours, pct(x.early.p), x.later.every, pct(x.later.p)));
  if (course.length > 0) blocks.push({ key: 'course', title: e.course, text: course });

  // после перевода (часть 39б): как открывают артерию, смертность по классу Killip, фибрилляция до того
  const r = c.reperfusion;
  if (r) {
    // значения класса — римские цифры: «по классу Killip: I — 2–3 %, II — 5–12 %…»
    const rows = Object.entries(r.death).map(([v, [lo, hi]]) => e.rscRow(v.toUpperCase(), pct(lo), pct(hi))).join(', ');
    const text = [e.rscWay(db.economy.transfer.hours, db.economy.transfer.pci), e.rscLysis(pct(r.lysis.p)), e.rscDeath(rows)];
    if (c.arrest) text.push(e.arrest(pct(c.arrest.perHour), c.arrest.hours));
    blocks.push({ key: 'afterTransfer', title: e.afterTransfer, text, refs: [ref(db, r.lysis.tx)] });
  }

  if (c.redFlags?.length) blocks.push({ key: 'redFlags', title: e.redFlags, text: [e.redFlagsNote], refs: c.redFlags.map(id => ref(db, id)) });
  if (c.pearls?.length) blocks.push({ key: 'pearls', title: e.pearls, text: c.pearls.map(p => p.ru) });
  blocks.push(sources(db, c));

  const subtitle = [c.icd10 ? e.icd(c.icd10) : '', c.system ? T.spikes.decision.system[c.system] : e.chronic].filter(Boolean).join(' · ');
  return { id: c.id, section: 'conditions', title: c.name.ru, subtitle, blocks };
}

function findingArticle(db: ContentDb, f: Finding): Article {
  const e = T.encyclopedia;
  const blocks: Block[] = [];
  if (f.texts.hint) blocks.push({ key: 'what', title: e.what, text: [f.texts.hint.ru] });
  const by = db.revealedBy[f.id] ?? [];
  if (by.length > 0) blocks.push({ key: 'howFound', title: e.howFound, refs: by.map(id => ref(db, id)) });

  const inConditions = Object.values(db.conditions).flatMap(c => {
    const l = strongest(c.findings.filter(x => x.f === f.id), c.params)[0];
    return l ? [{ id: c.id, p: l.p, note: whenText(l.when) }] : [];
  });
  const rows = byBand(db, inConditions);
  const risks = Object.values(db.risks).filter(r => r.findings.some(l => l.f === f.id)).map(r => ref(db, r.id)).sort(byTitle);
  if (risks.length > 0) rows.push({ label: e.fromRisks, refs: risks });
  if (rows.length > 0) blocks.push({ key: 'inConditions', title: e.inConditions, rows });

  const flagFor = Object.values(db.conditions).filter(c => c.redFlags?.includes(f.id)).map(c => ref(db, c.id)).sort(byTitle);
  if (flagFor.length > 0) blocks.push({ key: 'redFlagFor', title: e.redFlagFor, refs: flagFor });
  const inRules = Object.values(db.rules)
    .filter(r => r.any.includes(f.id) || r.complaints.includes(f.id) || (r.minor?.any ?? []).includes(f.id) || (r.requires ?? []).includes(f.id) || (r.excludes ?? []).includes(f.id))
    .map(r => ref(db, r.id))
    .sort(byTitle);
  if (inRules.length > 0) blocks.push({ key: 'inRules', title: e.inRules, refs: inRules });

  const subtitle = [e.findingKind[f.kind], f.redFlag ? e.redFlag : ''].filter(Boolean).join(' · ');
  return { id: f.id, section: 'findings', title: f.name.ru, subtitle, blocks };
}

function examArticle(db: ContentDb, x: Exam): Article {
  const e = T.encyclopedia;
  const blocks: Block[] = [{ key: 'what', title: e.what, text: [x.texts.summary.ru, ...(x.texts.hint ? [x.texts.hint.ru] : [])] }];
  if (x.checks.length > 0) {
    blocks.push({
      key: 'checks',
      title: e.checks,
      refs: x.checks.map(k => ref(db, k.f, e.accuracy(Math.round(k.sens / 100), Math.round(k.spec / 100)))),
      note: e.accuracyNote,
    });
  }
  // только при жалобе (часть 32г): расспрос о травме головы — при травме головы
  if (x.complaints) blocks.push({ key: 'forComplaints', title: e.examForComplaints, refs: x.complaints.map(id => ref(db, id)) });
  const confirms = Object.values(db.conditions).filter(c => c.confirm !== 'clinical' && c.confirm.includes(x.id)).map(c => ref(db, c.id)).sort(byTitle);
  if (confirms.length > 0) blocks.push({ key: 'confirms', title: e.confirms, refs: confirms });
  // где делают: помещение, аппараты, где берут материал; без помещения — у врача в кабинете
  const room = x.room ?? (db.rooms['room.office'] ? 'room.office' : undefined);
  if (room && db.rooms[room]) {
    const refs = [ref(db, room), ...(x.equipment ?? []).map(id => ref(db, id))];
    if (x.collect) refs.push(ref(db, x.collect, e.collectHere));
    blocks.push({ key: 'where', title: e.whereDone, refs });
  }
  blocks.push(sources(db, x));

  const minutes = x.time.procedure + (x.time.report ?? 0) + (x.time.turnaround ?? 0);
  const subtitle = [e.examKind[x.kind], e.minutes(minutes), T.common.rub(x.cost)].join(' · ');
  return { id: x.id, section: 'exams', title: x.name.ru, subtitle, blocks };
}

function treatmentArticle(db: ContentDb, x: Treatment): Article {
  const e = T.encyclopedia;
  const blocks: Block[] = [{ key: 'what', title: e.what, text: [x.texts.hint.ru] }];
  const conditions = Object.values(db.conditions);
  // роль по скрытому параметру (часть 32) — с условием: «Первая линия при — Перелом… (со смещением)»
  // и из группы «одно из» обязательного (часть 39в)
  const byParam = (c: Condition, key: (typeof TACTICS)[number]['key']) => (c.treatment?.byParam ?? []).filter(b => membersOf(b[key]).includes(x.id)).map(b => ref(db, c.id, whenText(b.when)));
  const rows = TACTICS.flatMap(k => (k.forLabel ? [{
    label: e[k.forLabel],
    refs: [...conditions.filter(c => membersOf(c.treatment?.[k.key]).includes(x.id)).map(c => ref(db, c.id)), ...conditions.flatMap(c => byParam(c, k.key))].sort(byTitle),
  }] : [])).filter(r => r.refs.length > 0);
  if (rows.length > 0) blocks.push({ key: 'usedAs', title: e.usedAs, rows });
  if (x.contraindications.length > 0) {
    blocks.push({ key: 'contraindications', title: e.contraindications, refs: x.contraindications.map(k => ref(db, k.id, e.level[k.level])) });
  }
  // лечение у постели (часть 39а): только под своим аппаратом — и где он стоит
  if (x.bedside) {
    const rooms = [...new Set(x.bedside.equipment.flatMap(id => db.equipment[id]?.rooms ?? []))];
    blocks.push({ key: 'where', title: e.whereDone, text: [e.bedsideOnly], refs: [...x.bedside.equipment, ...rooms].map(id => ref(db, id)) });
  }
  // спутники (часть 39а): каждое — обязательно, из группы — одно; с частью 42б — только при названных
  // болезнях: антикоагулянт рядом с кардиоверсией — при фибрилляции предсердий
  if (x.companions?.length) {
    const each = x.companions.filter((g): g is Id => typeof g === 'string');
    const rows = [
      ...(each.length > 0 ? [{ label: e.companionsEach, refs: each.map(id => ref(db, id)) }] : []),
      ...x.companions.filter((g): g is Id[] => typeof g !== 'string').map(g => ({ label: e.companionsOneOf, refs: g.map(id => ref(db, id)) })),
      ...(x.companionsFor ? [{ label: e.companionsFor, refs: x.companionsFor.map(id => ref(db, id)) }] : []),
    ];
    blocks.push({ key: 'companions', title: e.companions, text: [e.companionsNote], rows });
  }
  // операция (часть 28): что ею лечат и в какой срок, где делают и какая бригада
  const op = x.surgery;
  if (op) {
    const treats = conditions.filter(c => surgeriesOf(db, c.id).includes(x.id)).map(c => ref(db, c.id, c.surgery!.window !== undefined ? e.opWindow(c.surgery!.window, c.surgery!.from === 'onset', c.surgery!.observe) : undefined)).sort(byTitle);
    if (treats.length > 0) blocks.push({ key: 'treats', title: e.opTreats, refs: treats });
    blocks.push({ key: 'where', title: e.whereDone, refs: [ref(db, op.room), ...op.equipment.map(id => ref(db, id))] });
    blocks.push({ key: 'team', title: e.opTeam, refs: op.team.map(id => ref(db, id)) });
    // исходы по стадии болезни (часть 28б): осложнения и смерть в стационаре
    const stage = conditions.find(c => surgeriesOf(db, c.id).includes(x.id) && c.complication)?.complication?.name.ru;
    const k = op.complicated;
    const out = [e.opComplications(pct(op.complications), k && pct(k.complications), stage)];
    if (op.death !== undefined) out.push(e.opDeaths(pct(op.death), k?.death !== undefined ? pct(k.death) : undefined, stage));
    if (op.delay !== undefined) out.push(e.opDelay(pct(op.delay)));
    blocks.push({ key: 'outcomes', title: e.opOutcomes, text: out });
  }
  blocks.push(sources(db, x));

  const kind = x.kind === 'drug' ? T.spikes.decision.txGroup[txGroupOfClass(x.class)] : e.txKind[x.kind];
  const subtitle = op ? [kind, e.minutes(op.minutes), T.common.rub(x.cost)] : [kind, T.common.rub(x.cost)];
  return { id: x.id, section: 'treatments', title: x.name.ru, subtitle: subtitle.join(' · '), blocks };
}

function riskArticle(db: ContentDb, r: Risk): Article {
  const e = T.encyclopedia;
  const blocks: Block[] = [];
  if (r.findings.length > 0) blocks.push({ key: 'shows', title: e.shows, rows: byBand(db, strongest(r.findings).map(l => ({ id: l.f, p: l.p }))) });
  const raises = Object.values(db.conditions).flatMap(c => {
    const x = c.risks?.find(k => k.id === r.id);
    return x ? [ref(db, c.id, e.times(x.x))] : [];
  }).sort(byTitle);
  if (raises.length > 0) blocks.push({ key: 'raises', title: e.raises, refs: raises });
  const limits = Object.values(db.treatments).flatMap(x => {
    const k = x.contraindications.find(y => y.id === r.id);
    return k ? [ref(db, x.id, e.level[k.level])] : [];
  }).sort(byTitle);
  if (limits.length > 0) blocks.push({ key: 'limits', title: e.limits, refs: limits });
  blocks.push(sources(db, r));
  return { id: r.id, section: 'risks', title: r.name.ru, subtitle: e.riskKind, blocks };
}

// --- шкалы (spec 2026-09-chapter-2, часть 27) --------------------------------------------

/** Шкала по витальным: что это, баллы по показателям, что значит сумма, по каким признакам, источники. */
function scoreArticle(db: ContentDb, x: Score): Article {
  const e = T.encyclopedia;
  const num = (f: Id, v: number) => formatNumber(v, db.findings[f]?.value?.decimals ?? 0);
  const lines = x.params.map(par => {
    const unit = db.findings[par.f]?.value?.unit ?? '';
    const bands = par.points.map(([lo, hi, pts]) => {
      const range = lo === null ? e.scoreUpTo(num(par.f, hi ?? 0)) : hi === null ? e.scoreFrom(num(par.f, lo)) : `${num(par.f, lo)}–${num(par.f, hi)}`;
      return `${range} — ${pts}`;
    });
    return `${T.shift.ward.vital[par.f] ?? nameOf(db, par.f)}, ${unit}: ${bands.join('; ')}`;
  });
  const blocks: Block[] = [
    { key: 'what', title: e.what, text: [x.texts.summary.ru] },
    { key: 'points', title: e.scorePoints, text: [...lines, e.scoreOxygen(x.oxygen), e.scoreConfusion(x.confusion)] },
    { key: 'levels', title: e.scoreLevels, text: [e.scoreLevelsText(x.levels.medium, x.levels.single, x.levels.high)] },
    { key: 'uses', title: e.scoreUses, refs: x.params.map(p => ref(db, p.f)) },
    sources(db, x),
  ];
  return { id: x.id, section: 'scores', title: x.name.ru, subtitle: e.scoreKind, blocks };
}

/**
 * Пункты шкалы с весами (часть 41б): ссылка на признак с подписью — «2 балла», «1 балл, если нет
 * пункта «Прошедшая слабость в руке и ноге»»; возраст — строкой над ними (`rulePointsAge`).
 */
/**
 * Строки шкалы без ссылки (части 41б и 42а): возраст — каждой полосой («65–74 года — 1 балл», «75 лет
 * и старше — 2 балла»), затем пол.
 */
function pointLines(p: RulePoints): string[] {
  const e = T.encyclopedia;
  const bands = p.age ?? [];
  const age = bands.map((a, i) => (i + 1 < bands.length ? e.rulePointsAgeRange(a.from, bands[i + 1].from - 1, a.w) : e.rulePointsAge(a.from, a.w)));
  const sex = (['f', 'm'] as const).filter(s => p.sex?.[s]).map(s => e.rulePointsSex(s, p.sex![s]!));
  return [...age, ...sex];
}

/** Порог у мужчин и женщин разный (часть 42а). */
const bySex = (p: RulePoints) => pointsFrom(p, 'm') !== pointsFrom(p, 'f');

function pointRefs(db: ContentDb, p: RulePoints): Ref[] {
  const e = T.encyclopedia;
  return p.items.map(i => ref(db, i.f, i.unless ? e.rulePointsUnless(i.w, i.unless.map(u => nameOf(db, u))) : e.rulePointsItem(i.w)));
}

/** Правило решения (часть 32): когда применяют, какие признаки, какое обследование, при каких болезнях. */
function ruleArticle(db: ContentDb, x: Rule): Article {
  const e = T.encyclopedia;
  const blocks: Block[] = [
    { key: 'what', title: e.what, text: [x.texts.summary.ru] },
    { key: 'when', title: e.ruleWhen, refs: x.complaints.map(id => ref(db, id)), ...(x.ageMin !== undefined ? { note: e.ruleAge(x.ageMin) } : {}) },
    // часть 32г: к кому правило применимо, возраст и дополнительные признаки
    ...(x.requires ? [{ key: 'requires', title: e.ruleRequires, refs: x.requires.map(id => ref(db, id)), text: [x.texts.na?.ru ?? ''] }] : []),
    // часть 33а: при тромбофлебите и беременности шкалу Уэллса и D-димер не применяют
    ...(x.excludes ? [{ key: 'excludes', title: e.ruleExcludes, refs: x.excludes.map(id => ref(db, id)), ...(x.requires ? {} : { text: [x.texts.na?.ru ?? ''] }) }] : []),
    // шкала с баллами (часть 41б): пункты с весами, затем что значит сумма
    ...(x.points ? [{ key: 'points', title: e.rulePointsTitle, ...(pointLines(x.points).length > 0 ? { text: pointLines(x.points) } : {}), refs: pointRefs(db, x.points) }] : []),
    ...(x.any.length > 0 || !x.points ? [{ key: 'any', title: e.ruleAny, text: [x.texts.yes.ru, ...(x.age?.main !== undefined ? [e.ruleAgeMain(x.age.main)] : x.age?.from !== undefined ? [e.ruleAgeFrom(x.age.from)] : [])], refs: x.any.map(id => ref(db, id)) }] : []),
    ...(x.points ? [{ key: 'pointsYes', title: bySex(x.points) ? e.rulePointsYesSex(pointsFrom(x.points, 'm'), pointsFrom(x.points, 'f')) : e.rulePointsYes(x.points.from), text: [x.texts.yes.ru] }] : []),
    ...(x.minor ? [{ key: 'minor', title: e.ruleMinor(x.minor.count), refs: x.minor.any.map(id => ref(db, id)), text: x.age?.minor ? [e.ruleAgeMinor(x.age.minor[0], x.age.minor[1])] : [] }] : []),
    { key: 'none', title: x.points ? (bySex(x.points) ? e.rulePointsNoSex(pointsFrom(x.points, 'm'), pointsFrom(x.points, 'f')) : e.rulePointsNo(x.points.from)) : x.minor ? e.ruleNoneMinor : e.ruleNone, text: [x.texts.no.ru] },
    // обследования, которого в игре нет (КТ, часть 32г), — словами; правило о лечении (часть 39а) — лечение
    x.decides
      ? { key: 'decides', title: e.ruleDecides, refs: [ref(db, x.decides)] }
      : { key: 'exams', title: e.ruleExams, refs: x.exams.map(id => ref(db, id)), ...(x.texts.exam ? { text: [x.texts.exam.ru] } : {}) },
    { key: 'about', title: e.ruleAbout, refs: x.about.map(id => ref(db, id)).sort(byTitle) },
    sources(db, x),
  ];
  return { id: x.id, section: 'scores', title: x.name.ru, subtitle: e.ruleKind, blocks };
}

// --- больница: помещения, аппараты, должности (spec 2026-09-own-hospital) ----------------

function roomArticle(db: ContentDb, r: RoomType): Article {
  const e = T.encyclopedia;
  const rub = T.common.rub;
  const blocks: Block[] = [{ key: 'what', title: e.what, text: [r.texts.hint.ru] }];
  // операции (spec 2026-09-chapter-2, часть 28) — тоже «что здесь делают»; их аппараты нужны все сразу
  const ops = Object.values(db.treatments).filter(t => t.surgery?.room === r.id);
  const done = [...r.exams.map(id => ref(db, id)), ...ops.map(t => ref(db, t.id, e.minutes(t.surgery!.minutes)))].sort(byTitle);
  if (done.length > 0) blocks.push({ key: 'doneHere', title: e.doneHere, refs: done });
  if (r.collects.length > 0) blocks.push({ key: 'collectsFor', title: e.collectsFor, refs: r.collects.map(id => ref(db, id)).sort(byTitle) });
  const rows: Row[] = [];
  if (r.staff.length > 0) rows.push({ label: e.needPeople, refs: r.staff.map(id => ref(db, id)) });
  const allAtOnce = ops.length > 0 && r.equipment.every(id => ops.some(t => t.surgery!.equipment.includes(id)));
  const label = allAtOnce ? e.needMachines : r.needsEquipment ? e.needMachine : e.machines;
  if (r.equipment.length > 0) rows.push({ label, refs: r.equipment.map(id => ref(db, id, rub(db.equipment[id].price))) });
  if (rows.length > 0) blocks.push({ key: 'needs', title: e.needs, rows });
  blocks.push({
    key: 'sizes',
    title: e.sizes,
    text: r.sizes.map(z => e.sizeLine(z.id, z.w, z.h, rub(z.cost), rub(z.upkeep), z.seats, r.beds ? z.beds : 0, r.emergency ? z.beds : 0)),
    note: e.sizeNote,
  });
  const from = Math.min(...r.sizes.map(z => z.cost));
  return { id: r.id, section: 'hospital', title: r.name.ru, subtitle: [e.roomKind, e.fromPrice(rub(from))].join(' · '), blocks };
}

function equipmentArticle(db: ContentDb, x: Equipment): Article {
  const e = T.encyclopedia;
  const rub = T.common.rub;
  const blocks: Block[] = [{ key: 'what', title: e.what, text: [x.texts.hint.ru] }];
  // аппаратом делают обследования или операции (операционный стол — часть 28); под ним — лечение у
  // постели (тромболизис под монитором, часть 39а)
  const ops = Object.values(db.treatments).filter(t => t.surgery?.equipment.includes(x.id) || t.bedside?.equipment.includes(x.id)).map(t => ref(db, t.id));
  const by = [...x.exams.map(id => ref(db, id)), ...ops].sort(byTitle);
  if (by.length > 0) blocks.push({ key: 'examsBy', title: e.examsBy, refs: by });
  // монитор с дефибриллятором — в смотровой приёмного и в ПИТ (часть 38а)
  blocks.push({ key: 'standsIn', title: e.standsIn, refs: x.rooms.map(id => ref(db, id)) });
  if (x.upgradeOf) blocks.push({ key: 'upgrades', title: e.upgrades, refs: [ref(db, x.upgradeOf)] });
  const better = Object.values(db.equipment).filter(y => y.upgradeOf === x.id).map(y => ref(db, y.id, rub(y.price)));
  if (better.length > 0) blocks.push({ key: 'upgradedBy', title: e.upgradedBy, refs: better });
  const lines = [e.priceLine(rub(x.price), rub(x.upkeep))];
  if (x.speed > 1) lines.push(e.slower(x.speed));
  if (x.speed < 1) lines.push(e.faster(Math.round((1 / x.speed) * 10) / 10));
  const { sens, spec } = x.quality;
  if (sens < 0 && spec <= 0) lines.push(e.worse(-sens, -spec));
  if (sens > 0 && spec >= 0) lines.push(e.better(sens, spec));
  blocks.push({ key: 'prices', title: e.prices, text: lines });
  return { id: x.id, section: 'hospital', title: x.name.ru, subtitle: [e.equipmentKind, x.rooms.map(id => db.rooms[id]?.name.ru ?? id).join(', '), rub(x.price)].join(' · '), blocks };
}

function roleArticle(db: ContentDb, r: StaffRole): Article {
  const e = T.encyclopedia;
  const rub = T.common.rub;
  const blocks: Block[] = [{ key: 'what', title: e.what, text: [r.texts.hint.ru] }];
  if (r.rooms.length > 0) blocks.push({ key: 'worksIn', title: e.worksIn, refs: r.rooms.map(id => ref(db, id)).sort(byTitle) });
  if (r.hire) blocks.push({ key: 'salary', title: e.salary, text: [e.salaryLine(rub(r.salary[0]), rub(r.salary[1]))] });
  const subtitle = r.hire ? [e.roleKind, e.perShift(rub(r.salary[0]), rub(r.salary[1]))].join(' · ') : e.roleKind;
  return { id: r.id, section: 'hospital', title: r.name.ru, subtitle, blocks };
}

// --- подсказки наставника (spec 2026-09-campaign) ------------------------------------------

function tipArticle(db: ContentDb, x: Tip): Article {
  const e = T.encyclopedia;
  const w = x.when;
  const when = typeof w === 'object' ? e.tipWhen.condition(nameOf(db, w.condition)) : e.tipWhen[w];
  const blocks: Block[] = [
    { key: 'text', title: e.tipText, text: [x.text.ru] },
    { key: 'when', title: e.tipWhenTitle, text: [when], note: e.tipNote },
  ];
  if (x.see.length > 0) blocks.push({ key: 'see', title: e.tipSee, refs: x.see.map(id => ref(db, id)) });
  const who = db.characters[x.from];
  return { id: x.id, section: 'tips', title: x.name.ru, subtitle: who ? `${e.tipKind} · ${who.short.ru}` : e.tipKind, blocks };
}

/** Статья по идентификатору; нет такой записи — undefined. */
export function article(db: ContentDb, id: Id): Article | undefined {
  if (db.conditions[id]) return conditionArticle(db, db.conditions[id]);
  if (db.findings[id]) return findingArticle(db, db.findings[id]);
  if (db.exams[id]) return examArticle(db, db.exams[id]);
  if (db.treatments[id]) return treatmentArticle(db, db.treatments[id]);
  if (db.risks[id]) return riskArticle(db, db.risks[id]);
  if (db.scores[id]) return scoreArticle(db, db.scores[id]);
  if (db.rules[id]) return ruleArticle(db, db.rules[id]);
  if (db.rooms[id]) return roomArticle(db, db.rooms[id]);
  if (db.equipment[id]) return equipmentArticle(db, db.equipment[id]);
  if (db.roles[id]) return roleArticle(db, db.roles[id]);
  if (db.tips[id]) return tipArticle(db, db.tips[id]);
  return undefined;
}

// --- разделы и поиск --------------------------------------------------------------------

const FINDING_KINDS: Finding['kind'][] = ['sym', 'hx', 'sign', 'vital', 'lab', 'img', 'ecg'];
const EXAM_GROUPS: { key: 'ask' | 'examine' | 'lab' | 'imaging'; kinds: Exam['kind'][] }[] = [
  { key: 'ask', kinds: ['ask'] },
  { key: 'examine', kinds: ['physical', 'bedside'] },
  { key: 'lab', kinds: ['lab', 'rapid'] },
  { key: 'imaging', kinds: ['imaging', 'functional'] },
];

function table(db: ContentDb, section: Section): { id: Id; name: { ru: string } }[] {
  if (section === 'hospital') return [...Object.values(db.rooms), ...Object.values(db.equipment), ...Object.values(db.roles)];
  if (section === 'tips') return Object.values(db.tips);
  if (section === 'scores') return [...Object.values(db.scores), ...Object.values(db.rules)];
  const t = { conditions: db.conditions, findings: db.findings, exams: db.exams, treatments: db.treatments, risks: db.risks }[section];
  return Object.values(t);
}

export function sectionView(db: ContentDb, section: Section): SectionView {
  const e = T.encyclopedia;
  const refs = (xs: { id: Id; name: { ru: string } }[]) => xs.map(x => ({ id: x.id, title: x.name.ru })).sort(byTitle);
  let groups: SectionView['groups'];
  if (section === 'conditions') {
    const all = Object.values(db.conditions);
    groups = [
      ...SYSTEMS.map(s => ({ key: s, title: T.spikes.decision.system[s], items: refs(all.filter(c => c.presenting && c.system === s)) })),
      { key: 'chronic', title: e.chronic, items: refs(all.filter(c => !c.presenting || !c.system)) },
    ];
  } else if (section === 'findings') {
    const all = Object.values(db.findings);
    groups = FINDING_KINDS.map(k => ({ key: k, title: e.findingGroup[k], items: refs(all.filter(f => f.kind === k)) }));
  } else if (section === 'exams') {
    const all = Object.values(db.exams);
    groups = EXAM_GROUPS.map(g => ({ key: g.key, title: e.examGroup[g.key], items: refs(all.filter(x => g.kinds.includes(x.kind))) }));
  } else if (section === 'treatments') {
    const all = Object.values(db.treatments);
    groups = TX_GROUP_ORDER.map(k => ({ key: k, title: T.spikes.decision.txGroup[k], items: refs(all.filter(x => txGroupOfClass(x.class) === k)) }));
  } else if (section === 'hospital') {
    groups = [
      { key: 'rooms', title: e.hospitalGroup.rooms, items: refs(Object.values(db.rooms)) },
      { key: 'equipment', title: e.hospitalGroup.equipment, items: refs(Object.values(db.equipment)) },
      { key: 'roles', title: e.hospitalGroup.roles, items: refs(Object.values(db.roles)) },
    ];
  } else if (section === 'scores') {
    groups = [
      { key: 'scores', title: e.scoreGroup, items: refs(Object.values(db.scores)) },
      { key: 'rules', title: e.ruleGroup, items: refs(Object.values(db.rules)) },
    ];
  } else if (section === 'tips') {
    // в том порядке, в каком наставник подсказывает
    groups = [{ key: 'tips', title: e.tipKind, items: Object.values(db.tips).map(x => ({ id: x.id, title: x.name.ru })) }];
  } else {
    groups = [{ key: 'risks', title: e.sections.risks, items: refs(Object.values(db.risks)) }];
  }
  return { section, title: e.sections[section], groups: groups.filter(g => g.items.length > 0) };
}

/** Разделы с числом статей — для оглавления. */
export function sectionsOf(db: ContentDb): { section: Section; title: string; count: number }[] {
  return SECTIONS.map(section => ({ section, title: T.encyclopedia.sections[section], count: table(db, section).length }));
}

/** Строчные, «ё» как «е»: ищут и «прием», и «приём». */
const norm = (s: string) => s.toLowerCase().replace(/\u0451/g, '\u0435');

/** Поиск по названиям (у болезней — и по коду МКБ): все слова запроса — в названии. */
export function search(db: ContentDb, query: string, limit = 50): (Ref & { section: Section })[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const found: (Ref & { section: Section })[] = [];
  for (const section of SECTIONS) {
    const hits = table(db, section)
      .filter(x => {
        const hay = norm(`${x.name.ru} ${section === 'conditions' ? (db.conditions[x.id].icd10 ?? '') : ''}`);
        return words.every(w => hay.includes(w));
      })
      .map(x => ({ id: x.id, title: x.name.ru, section }))
      .sort(byTitle);
    found.push(...hits);
  }
  return found.slice(0, limit);
}
