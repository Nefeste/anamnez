// «Разобрать случай» из статьи энциклопедии (spec 2026-10-study-case, часть 74): один больной с выбранной болезнью —
// там, где её лечат. Болезнь терапии, которую обычно лечат дома и без аппаратов у постели, — в амбулатории; иначе — в
// первой больнице кампании, где её лечат целиком: её отделение там есть, есть приёмное, если больного привозит скорая или
// его лечению нужен аппарат у постели, и есть все места и кабинеты из её тактики. Больница — как у «Смены» в этом месте.
import { type Condition, type ContentDb, type Id, membersOf, type Season, type Setting, type Tactics, type TacticsByParam } from '../../content/types';
import { type Block, examWhere } from '../hospital/requirements';
import { typicalPatient } from '../med/generate';
import { bedsideLack, type Venue } from '../med/plan';
import type { Patient } from '../med/types';
import { boxBeds, departmentsOf, hospitalCtx, icuBeds, orBlock, ricuBeds, venueState, wardBeds } from './engine';
import type { ShiftState } from './types';

/** Амбулатория практики — та, что у «Смены» всегда открыта. */
export const STUDY_CLINIC = 'preset.clinic';

/** Где принять больного из статьи: готовая больница и что в ней есть. */
export interface StudyPlace {
  /** готовая больница — запись `presets` */
  venue: Id;
  /** её отделения: из их болезней диагноз, вывод и разбор */
  departments: Id[];
  /** виды работающих помещений: лечение в кабинете — где он есть (часть 53а) */
  rooms: readonly Id[];
  /** больной лежит в смотровой приёмного — её аппараты у постели; в амбулатории — в кабинете врача, без них */
  bedside: readonly Id[];
  /** своя палата, ПИТ, реанимация, боксы, операционная */
  ward: boolean;
  icu: boolean;
  ricu: boolean;
  box: boolean;
  or: boolean;
  /** обследования, которых здесь не сделать, — почему */
  blocked: Readonly<Record<Id, Block>>;
  /** больница «Смены» без разыгранного дня: операционная по операции — `orBlock` */
  state: ShiftState;
}

const places = new WeakMap<ContentDb, Map<Id, StudyPlace>>();
const chosen = new WeakMap<ContentDb, Map<Id, StudyPlace | null>>();

/** Где можно разобрать случай: амбулатория и больницы глав кампании с приёмным — по порядку глав. */
export function studyVenues(db: ContentDb): Id[] {
  const hospitals = Object.values(db.chapters)
    .sort((a, b) => a.order - b.order)
    .map(c => c.preset)
    .filter((p, i, all) => all.indexOf(p) === i && p !== STUDY_CLINIC && venueOf(db, p).bedside.length > 0);
  return [STUDY_CLINIC, ...hospitals];
}

/** Что есть в готовой больнице «Смены» — один раз на базу. */
export function venueOf(db: ContentDb, venue: Id): StudyPlace {
  let byVenue = places.get(db);
  if (!byVenue) places.set(db, (byVenue = new Map()));
  let p = byVenue.get(venue);
  if (!p) {
    const s = venueState(db, venue);
    const ctx = hospitalCtx(db, s);
    const er = ctx.plan.rooms.find(r => db.rooms[r.type]?.emergency && ctx.working.has(r.id));
    const blocked: Record<Id, Block> = {};
    for (const id of Object.keys(db.exams)) {
      const w = examWhere(db, ctx.plan, ctx.working, ctx.staffed, id);
      if ('block' in w) blocked[id] = w.block;
    }
    p = {
      venue, departments: departmentsOf(db, s), rooms: ctx.rooms,
      bedside: er ? [...new Set(er.equipment.filter((x): x is Id => x !== null))].sort() : [],
      ward: wardBeds(db, s).length > 0, icu: icuBeds(db, s).length > 0, ricu: ricuBeds(db, s).length > 0, box: boxBeds(db, s).length > 0,
      or: orBlock(db, s) === null, blocked, state: s,
    };
    byVenue.set(venue, p);
  }
  return p;
}

/** Что что-то из этого места даёт в оценке плана: аппараты у постели, кабинеты, своя реанимация. */
export function placeVenue(p: StudyPlace): Venue {
  return { bedside: p.bedside, rooms: p.rooms, ...(p.ward ? { ward: true } : {}), ...(p.or ? { or: true } : {}), ...(p.icu ? { icu: true } : {}), ...(p.ricu ? { ricu: true } : {}), ...(p.box ? { box: true } : {}) };
}

/** Все места, которые тактика может назвать: по умолчанию, по параметру, при красном флаге, факторе риска, результате. */
function settingsOf(t: Tactics): Setting[] {
  const s = t.setting;
  return [s.default, ...Object.values(s.param?.map ?? {}), ...(s.redFlag ? [s.redFlag] : []), ...(s.risks ?? []).map(r => r.setting),
    ...(s.after ? [s.after.setting, ...(s.after.flags ? [s.after.flags.setting] : [])] : [])];
}

/** Лечение тактики, которое назначают, — и по значениям параметров. */
function treatmentsOf(t: Tactics): Id[] {
  const lists = (x: Tactics | TacticsByParam) => [
    ...x.firstLine, ...x.acceptable, ...x.supportive, ...(x.plan ?? []), ...(x.preHospital ?? []),
    ...membersOf(x.require), ...membersOf(x.beforeTransfer),
  ];
  return [...new Set([...lists(t), ...(t.byParam ?? []).flatMap(lists)])];
}

/** Место есть здесь: «скорая», «направить» и «перевести» — везде, остальное — своё. */
function settingHere(p: StudyPlace, s: Setting): boolean {
  switch (s) {
    case 'home': case 'ambulance': case 'transfer': return true;
    case 'ward': case 'admit': return p.ward;
    case 'icu': return p.icu || p.ricu;
    case 'ricu': return p.ricu;
    case 'box': return p.box;
    case 'surgery': return p.or;
  }
}

/** Болезнь лечат здесь целиком: её отделение, приёмное для привезённых скорой, все места и всё лечение тактики. */
function treatsHere(db: ContentDb, c: Condition, p: StudyPlace): boolean {
  if (!p.departments.includes(c.department)) return false;
  if (c.arrival === 'ambulance' && p.bedside.length === 0) return false;
  const t = c.treatment;
  if (!t) return true;
  return settingsOf(t).every(s => settingHere(p, s)) && treatmentsOf(t).every(tx => bedsideLack(db, tx, placeVenue(p)) === undefined);
}

/**
 * Где разобрать случай этой болезни (spec 2026-10-study-case): с ней не приходят — нигде. Терапия, с которой приходят
 * сами, лечат дома и без аппаратов у постели, — амбулатория; иначе — первая больница глав, где её лечат целиком; такой нет —
 * последняя, самая большая.
 */
export function studyPlace(db: ContentDb, id: Id): StudyPlace | undefined {
  let byId = chosen.get(db);
  if (!byId) chosen.set(db, (byId = new Map()));
  if (!byId.has(id)) byId.set(id, choose(db, id) ?? null);
  return byId.get(id) ?? undefined;
}

function choose(db: ContentDb, id: Id): StudyPlace | undefined {
  const c = db.conditions[id];
  if (!c?.presenting) return undefined;
  const [clinic, ...hospitals] = studyVenues(db).map(v => venueOf(db, v));
  const home = c.treatment?.setting.default === 'home';
  const free = !c.treatment || treatmentsOf(c.treatment).every(tx => bedsideLack(db, tx, placeVenue(clinic)) === undefined);
  if (home && free && c.arrival !== 'ambulance' && clinic.departments.includes(c.department)) return clinic;
  return hospitals.find(p => treatsHere(db, c, p)) ?? hospitals[hospitals.length - 1];
}

/** Больной из статьи: типичный для болезни человек, в отделениях этой больницы; зёрна — подряд от `seed`. */
export function studyPatient(db: ContentDb, id: Id, place: StudyPlace, seed: number, season: Season): Patient {
  const c = db.conditions[id];
  return typicalPatient(db, k => (seed + k * 7_919) >>> 0, { department: c.department, departments: place.departments, season, primary: id }, 64);
}
