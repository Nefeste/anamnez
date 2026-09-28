// Энциклопедия (03-game-design.md §11, 05-content.md §4). Статьи собираются из тех же записей
// базы, по которым работает модель, — поэтому энциклопедия не может разойтись с игрой.
// Здесь только вид: разделы, статьи, поиск; экраны — src/app/encyclopedia. База приходит
// параметром, как у движка: тесты подставляют ту же собранную базу.
import {
  type Condition, type ContentDb, type Equipment, type Exam, type Finding, type Id, type Link, type P, type Risk, type RoomType, type StaffRole, SYSTEMS, type Tactics,
  type Tip, type Treatment,
} from '@/content/types';
import { T } from '@/i18n';
import { TX_GROUP_ORDER, txGroupOfClass } from './caseView';
import { sourceLine } from './sources';

export type Section = 'conditions' | 'findings' | 'exams' | 'treatments' | 'risks' | 'hospital' | 'tips';
export const SECTIONS: Section[] = ['conditions', 'findings', 'exams', 'treatments', 'risks', 'hospital', 'tips'];

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
  if (db.rooms[id] || db.equipment[id] || db.roles[id]) return 'hospital';
  if (db.tips[id]) return 'tips';
  return undefined;
}

function nameOf(db: ContentDb, id: Id): string {
  return (db.conditions[id] ?? db.findings[id] ?? db.exams[id] ?? db.treatments[id] ?? db.risks[id] ?? db.rooms[id] ?? db.equipment[id] ?? db.roles[id] ?? db.tips[id])?.name.ru ?? id;
}

const ref = (db: ContentDb, id: Id, note?: string): Ref => (note ? { id, title: nameOf(db, id), note } : { id, title: nameOf(db, id) });
const byTitle = (a: { title: string }, b: { title: string }) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);
const unique = (xs: string[]) => [...new Set(xs)];

/** У признака в записи бывает несколько связей (по тяжести, по типу) — берём самую частую. */
function strongest(links: readonly Link[]): Link[] {
  const best = new Map<Id, Link>();
  for (const l of links) {
    const b = best.get(l.f);
    if (!b || l.p > b.p) best.set(l.f, l);
  }
  return [...best.values()];
}

/** Условие связи словами: «при тяжёлом течении», «с подъёмом ST». */
function whenNote(when: Link['when']): string | undefined {
  if (!when) return undefined;
  const words = Object.values(when).flat().map(v => T.encyclopedia.when[v] ?? v);
  return words.length > 0 ? words.join(', ') : undefined;
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
 * С чем спутать: болезни с похожим набором признаков (05-content.md §4). Сходство — взвешенный
 * Жаккар по частотам признаков: сумма меньших частот к сумме больших.
 */
export function similar(db: ContentDb, id: Id): Id[] {
  let cache = similarCache.get(db);
  if (!cache) {
    cache = new Map();
    const all = Object.values(db.conditions).filter(c => c.presenting);
    const vec = new Map(all.map(c => [c.id, new Map(strongest(c.findings).map(l => [l.f, l.p]))]));
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
      cache.set(c.id, scored.slice(0, SIMILAR_MAX).map(x => x.id));
    }
    similarCache.set(db, cache);
  }
  return cache.get(id) ?? [];
}

// --- статьи -------------------------------------------------------------------------------

/** Тактика: подпись в статье болезни и, если есть, в статье лечения («первая линия при …»). */
const TACTICS: { key: keyof Omit<Tactics, 'setting'>; label: 'firstLine' | 'plan' | 'acceptable' | 'supportive' | 'notIndicated' | 'harmful'; forLabel?: 'firstLineFor' | 'planFor' | 'acceptableFor' | 'supportiveFor' | 'harmfulFor' }[] = [
  { key: 'firstLine', label: 'firstLine', forLabel: 'firstLineFor' },
  { key: 'plan', label: 'plan', forLabel: 'planFor' },
  { key: 'acceptable', label: 'acceptable', forLabel: 'acceptableFor' },
  { key: 'supportive', label: 'supportive', forLabel: 'supportiveFor' },
  // «не нужно при» у лекарства — почти вся база (антибиотик — при мигрени…): список короткий
  // и по делу только в статье болезни
  { key: 'notIndicated', label: 'notIndicated' },
  { key: 'harmful', label: 'harmful', forLabel: 'harmfulFor' },
];

function whereLines(db: ContentDb, t: Tactics): string[] {
  const e = T.encyclopedia;
  const s = t.setting;
  const lines = [e.whereDefault(e.setting[s.default])];
  for (const [value, set] of Object.entries(s.param?.map ?? {})) if (set !== s.default) lines.push(e.whereIf(e.when[value] ?? value, e.setting[set]));
  if (s.redFlag && s.redFlag !== s.default) lines.push(e.whereRedFlag(e.setting[s.redFlag]));
  for (const r of s.risks ?? []) if (r.setting !== s.default) lines.push(e.whereRisk(nameOf(db, r.id), e.setting[r.setting]));
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
  blocks.push({ key: 'signs', title: e.signs, rows: byBand(db, strongest(c.findings).map(l => ({ id: l.f, p: l.p, note: whenNote(l.when) }))) });

  const who = whoLines(c);
  const whoRows: Row[] = [];
  if (c.requires?.length) whoRows.push({ label: e.requires, refs: c.requires.map(id => ref(db, id)) });
  if (c.risks?.length) whoRows.push({ label: e.riskFactors, refs: c.risks.map(r => ref(db, r.id, e.times(r.x))) });
  if (who.length > 0 || whoRows.length > 0) blocks.push({ key: 'who', title: e.who, text: who, rows: whoRows });

  blocks.push(c.confirm === 'clinical'
    ? { key: 'confirm', title: e.confirm, text: [e.clinical] }
    : { key: 'confirm', title: e.confirm, refs: c.confirm.map(id => ref(db, id)) });

  const alike = similar(db, c.id);
  if (alike.length > 0) blocks.push({ key: 'similar', title: e.similar, refs: alike.map(id => ref(db, id)) });

  const t = c.treatment;
  if (t) {
    const rows = TACTICS.map(k => ({ label: e[k.label], refs: (t[k.key] ?? []).map(id => ref(db, id)) })).filter(r => r.refs.length > 0);
    blocks.push({ key: 'treatment', title: e.treatment, rows });
    blocks.push({ key: 'where', title: e.whereTitle, text: whereLines(db, t) });
  }

  const course: string[] = [];
  if (c.selfLimiting) course.push(e.selfLimiting);
  if (c.untreated && c.untreated.p > 0) course.push(e.untreated(e.band[bandOf(c.untreated.p)], c.untreated.days[0], c.untreated.days[1]));
  if (course.length > 0) blocks.push({ key: 'course', title: e.course, text: course });

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
    const l = strongest(c.findings.filter(x => x.f === f.id))[0];
    return l ? [{ id: c.id, p: l.p, note: whenNote(l.when) }] : [];
  });
  const rows = byBand(db, inConditions);
  const risks = Object.values(db.risks).filter(r => r.findings.some(l => l.f === f.id)).map(r => ref(db, r.id)).sort(byTitle);
  if (risks.length > 0) rows.push({ label: e.fromRisks, refs: risks });
  if (rows.length > 0) blocks.push({ key: 'inConditions', title: e.inConditions, rows });

  const flagFor = Object.values(db.conditions).filter(c => c.redFlags?.includes(f.id)).map(c => ref(db, c.id)).sort(byTitle);
  if (flagFor.length > 0) blocks.push({ key: 'redFlagFor', title: e.redFlagFor, refs: flagFor });

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
  const rows = TACTICS.flatMap(k => (k.forLabel ? [{
    label: e[k.forLabel],
    refs: conditions.filter(c => (c.treatment?.[k.key] ?? []).includes(x.id)).map(c => ref(db, c.id)).sort(byTitle),
  }] : [])).filter(r => r.refs.length > 0);
  if (rows.length > 0) blocks.push({ key: 'usedAs', title: e.usedAs, rows });
  if (x.contraindications.length > 0) {
    blocks.push({ key: 'contraindications', title: e.contraindications, refs: x.contraindications.map(k => ref(db, k.id, e.level[k.level])) });
  }
  blocks.push(sources(db, x));

  const kind = x.kind === 'drug' ? T.spikes.decision.txGroup[txGroupOfClass(x.class)] : e.txKind[x.kind];
  return { id: x.id, section: 'treatments', title: x.name.ru, subtitle: [kind, T.common.rub(x.cost)].join(' · '), blocks };
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

// --- больница: помещения, аппараты, должности (spec 2026-09-own-hospital) ----------------

function roomArticle(db: ContentDb, r: RoomType): Article {
  const e = T.encyclopedia;
  const rub = T.common.rub;
  const blocks: Block[] = [{ key: 'what', title: e.what, text: [r.texts.hint.ru] }];
  if (r.exams.length > 0) blocks.push({ key: 'doneHere', title: e.doneHere, refs: r.exams.map(id => ref(db, id)).sort(byTitle) });
  if (r.collects.length > 0) blocks.push({ key: 'collectsFor', title: e.collectsFor, refs: r.collects.map(id => ref(db, id)).sort(byTitle) });
  const rows: Row[] = [];
  if (r.staff.length > 0) rows.push({ label: e.needPeople, refs: r.staff.map(id => ref(db, id)) });
  if (r.equipment.length > 0) rows.push({ label: r.needsEquipment ? e.needMachine : e.machines, refs: r.equipment.map(id => ref(db, id, rub(db.equipment[id].price))) });
  if (rows.length > 0) blocks.push({ key: 'needs', title: e.needs, rows });
  blocks.push({
    key: 'sizes',
    title: e.sizes,
    text: r.sizes.map(z => e.sizeLine(z.id, z.w, z.h, rub(z.cost), rub(z.upkeep), z.seats)),
    note: e.sizeNote,
  });
  const from = Math.min(...r.sizes.map(z => z.cost));
  return { id: r.id, section: 'hospital', title: r.name.ru, subtitle: [e.roomKind, e.fromPrice(rub(from))].join(' · '), blocks };
}

function equipmentArticle(db: ContentDb, x: Equipment): Article {
  const e = T.encyclopedia;
  const rub = T.common.rub;
  const blocks: Block[] = [{ key: 'what', title: e.what, text: [x.texts.hint.ru] }];
  if (x.exams.length > 0) blocks.push({ key: 'examsBy', title: e.examsBy, refs: x.exams.map(id => ref(db, id)).sort(byTitle) });
  blocks.push({ key: 'standsIn', title: e.standsIn, refs: [ref(db, x.room)] });
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
  return { id: x.id, section: 'hospital', title: x.name.ru, subtitle: [e.equipmentKind, db.rooms[x.room]?.name.ru ?? x.room, rub(x.price)].join(' · '), blocks };
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
