// Сборка медицинской базы из YAML в память: схема, ссылки, полосы → числа
// (`docs/05-content.md` §6, `docs/07-data-model.md` §1). Используют build.ts, тесты и
// «виртуальный врач» — все читают одну и ту же базу.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { parse } from 'yaml';
import type { z } from 'zod';
import type { AttrSpec, Cell, Condition, ContentDb, Equipment, Exam, Finding, Link, Preset, Risk, RoomType, StaffRole, Treatment } from '../../src/content/types';
import { planOf, presetHospital } from '../../src/engine/hospital/build';
import { problemsOf } from '../../src/engine/hospital/requirements';
import { ALLERGY_EXAM } from '../../src/engine/career/achievements';
import { fingerprint } from '../../src/engine/core/hash';
import { findBrand } from './brands';
import {
  BANDS, type ChapterSrc, chapterSchema, type CharacterSrc, characterSchema, type ConditionSrc, conditionSchema, type EconomySrc, economySchema, type EquipmentSrc, equipmentSchema, type ExamSrc, examSchema, type FindingSrc, findingSchema,
  type LinkSrc, PREVALENCE, type PresetSrc, presetSchema, type ProbabilitySrc, type RiskSrc, type RoleSrc, riskSchema, roleSchema, type RoomSrc, roomSchema,
  type TipSrc, tipSchema, type TreatmentSrc, treatmentSchema, versionSchema, type AchievementSrc, achievementSchema, type ScoreSrc, scoreSchema,
} from './schema';

export const CONTENT_DIR = join(import.meta.dir, '../../content');

/** Баланс, пока economy.yaml не прочитан (ошибка сборки всё равно будет). */
export const NO_ECONOMY: ContentDb['economy'] = {
  corridor: { cost: 0, upkeep: 0 }, refund: 0,
  staff: {
    candidates: [0, 0], skills: [1, 1, 1, 1, 1], speed: [100, 100, 100, 100, 100], reading: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]], surgery: [100, 100, 100, 100, 100], growthDays: 1, noTrait: 1,
    traits: { careful: { weight: 0 }, fast: { weight: 0 }, novice: { weight: 0 }, experienced: { weight: 0 } },
    doctor: { threshold: [90, 90, 90, 90, 90], minGain: [20, 20, 20, 20, 20], forget: [0, 0, 0, 0, 0] },
  },
  tariffs: { oms: { minor: 0, moderate: 0, serious: 0, critical: 0 }, omsWard: { minor: 0, moderate: 0, serious: 0, critical: 0 }, omsOperation: 0, omsQuality: { A: 0, B: 0, C: 0, D: 0 }, omsUnconfirmed: 0, omsExam: 0, dms: { visit: 0, price: 0 }, self: { visit: 0, price: 0 } },
  level: { base: 100, rooms: {} },
  payers: { dms: [0, 0, 0], self: [0, 0, 0] },
  consumables: { ask: 0, physical: 0, bedside: 0, lab: 0, rapid: 0, functional: 0, imaging: 0 },
  interest: 0,
  ward: { bedDay: 0, interrupted: 0 },
  ambulance: { perDay: [0, 0], weight: { minor: 0, moderate: 0, serious: 0, critical: 0 }, severe: 0 },
  reputation: { start: 50, pull: 1, waitShort: 0, waitShortMin: 0, waitLong: 0, waitLongMin: 0, noToilet: 0 },
  flow: 0,
  sandbox: { plot: [8, 8], entrance: [0, 1], corridor: [], budgets: { modest: 0, normal: 0, generous: 0 }, clinicShare: 0 },
};

export interface BuildResult {
  db: ContentDb;
  errors: string[];
  warnings: string[];
  files: number;
}

function yamlFiles(dir: string): string[] {
  return readdirSync(dir).sort().flatMap(n => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return yamlFiles(p);
    return n.endsWith('.yaml') ? [p] : [];
  });
}

const prob = (p: ProbabilitySrc): number => (typeof p === 'string' ? BANDS[p] : Math.round(p.pct * 100));

function compileLink(l: LinkSrc): Link {
  const out: Link = { f: l.f, p: prob(l.band) };
  if (l.stages) out.stages = l.stages;
  if (l.when) out.when = l.when;
  if (l.attrs) {
    out.attrs = {};
    for (const [name, spec] of Object.entries(l.attrs)) {
      out.attrs[name] = (typeof spec === 'string' ? { param: spec.slice(1) } : { dist: spec }) satisfies AttrSpec;
    }
  }
  return out;
}

export function buildDb(dir = CONTENT_DIR): BuildResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const files = yamlFiles(dir);
  const conditions: Record<string, ConditionSrc> = {};
  const findings: Record<string, FindingSrc> = {};
  const exams: Record<string, ExamSrc> = {};
  const risks: Record<string, RiskSrc> = {};
  const treatments: Record<string, TreatmentSrc> = {};
  const rooms: Record<string, RoomSrc> = {};
  const equipment: Record<string, EquipmentSrc> = {};
  const roles: Record<string, RoleSrc> = {};
  const presets: Record<string, PresetSrc> = {};
  const characters: Record<string, CharacterSrc> = {};
  const chapters: Record<string, ChapterSrc> = {};
  const tips: Record<string, TipSrc> = {};
  const achievements: Record<string, AchievementSrc> = {};
  const scores: Record<string, ScoreSrc> = {};
  let economy: EconomySrc | undefined;
  let contentVersion = 0;

  for (const file of files) {
    const rel = relative(dir, file);
    const top = rel.split('/')[0];
    let raw: unknown;
    const source = readFileSync(file, 'utf8');
    const brand = findBrand(source);
    if (brand) errors.push(`${rel}: торговое название «${brand}» — только МНН или группа (ADR 0012)`);
    try {
      raw = parse(source);
    } catch (e) {
      errors.push(`${rel}: не разбирается как YAML: ${(e as Error).message}`);
      continue;
    }
    const check = <S extends z.ZodType>(schema: S): z.infer<S> | undefined => {
      const r = schema.safeParse(raw);
      if (!r.success) {
        for (const issue of r.error.issues) errors.push(`${rel}: ${issue.path.join('.') || '(запись)'}: ${issue.message}`);
        return undefined;
      }
      return r.data;
    };
    const name = basename(file, '.yaml');
    const expectId = (id: string, prefix: string) => {
      if (id !== `${prefix}.${name}`) errors.push(`${rel}: идентификатор ${id} не совпадает с именем файла (ожидается ${prefix}.${name})`);
    };
    const put = <T extends { id: string }>(map: Record<string, T>, rec: T) => {
      if (map[rec.id]) errors.push(`${rel}: идентификатор ${rec.id} уже есть`);
      map[rec.id] = rec;
    };
    if (rel === 'version.yaml') {
      contentVersion = check(versionSchema)?.contentVersion ?? 0;
    } else if (top === 'conditions') {
      const c = check(conditionSchema);
      if (c) { expectId(c.id, 'cond'); put(conditions, c); }
    } else if (top === 'findings') {
      const f = check(findingSchema);
      if (f) { expectId(f.id, rel.split('/')[1]); put(findings, f); }
    } else if (top === 'exams') {
      const e = check(examSchema);
      if (e) { expectId(e.id, 'exam'); put(exams, e); }
    } else if (top === 'risks') {
      const r = check(riskSchema);
      if (r) { expectId(r.id, 'risk'); put(risks, r); }
    } else if (top === 'treatments') {
      const t = check(treatmentSchema);
      if (t) { expectId(t.id, 'tx'); put(treatments, t); }
    } else if (top === 'hospital' && rel.split('/')[1] === 'rooms') {
      const r = check(roomSchema);
      if (r) { expectId(r.id, 'room'); put(rooms, r); }
    } else if (top === 'hospital' && rel.split('/')[1] === 'equipment') {
      const e = check(equipmentSchema);
      if (e) { expectId(e.id, 'eq'); put(equipment, e); }
    } else if (top === 'hospital' && rel.split('/')[1] === 'roles') {
      const r = check(roleSchema);
      if (r) { expectId(r.id, 'role'); put(roles, r); }
    } else if (top === 'hospital' && rel.split('/')[1] === 'presets') {
      const p = check(presetSchema);
      if (p) { expectId(p.id, 'preset'); put(presets, p); }
    } else if (rel === 'hospital/economy.yaml') {
      economy = check(economySchema);
    } else if (top === 'campaign' && rel.split('/')[1] === 'characters') {
      const c = check(characterSchema);
      if (c) { expectId(c.id, 'char'); put(characters, c); }
    } else if (top === 'campaign' && rel.split('/')[1] === 'chapters') {
      const c = check(chapterSchema);
      if (c) { expectId(c.id, 'chapter'); put(chapters, c); }
    } else if (top === 'campaign' && rel.split('/')[1] === 'tips') {
      const t = check(tipSchema);
      if (t) { expectId(t.id, 'tip'); put(tips, t); }
    } else if (top === 'achievements') {
      const a = check(achievementSchema);
      if (a) { expectId(a.id, 'ach'); put(achievements, a); }
    } else if (top === 'scores') {
      const x = check(scoreSchema);
      if (x) { expectId(x.id, 'score'); put(scores, x); }
    } else {
      errors.push(`${rel}: файл вне известных разделов (conditions, findings, exams, risks, treatments, hospital/rooms, hospital/equipment, hospital/roles, hospital/presets, hospital/economy.yaml, campaign/characters, campaign/chapters, campaign/tips, achievements, scores)`);
    }
  }
  if (!contentVersion) errors.push('version.yaml: нет contentVersion');
  if (!economy) errors.push('hospital/economy.yaml: нет баланса больницы');

  // --- ссылки ---
  const hasF = (id: string) => id in findings;
  const checkLinks = (owner: string, links: LinkSrc[], params?: Record<string, Record<string, number>>, stages?: string[]) => {
    for (const l of links) {
      if (!hasF(l.f)) { errors.push(`${owner}: признак ${l.f} не найден`); continue; }
      for (const [attr, spec] of Object.entries(l.attrs ?? {})) {
        if (!findings[l.f].attrs?.[attr]) errors.push(`${owner}: у признака ${l.f} нет атрибута ${attr}`);
        if (typeof spec === 'string') {
          const param = spec.slice(1);
          if (!params?.[param]) errors.push(`${owner}: параметр ${param} не объявлен`);
          else for (const v of Object.keys(params[param])) if (!findings[l.f].attrs?.[attr]?.[v]) errors.push(`${owner}: значение ${param}=${v} не описано в атрибуте ${l.f}.${attr}`);
        } else {
          for (const v of Object.keys(spec)) if (!findings[l.f].attrs?.[attr]?.[v]) errors.push(`${owner}: значение ${v} не описано в атрибуте ${l.f}.${attr}`);
        }
      }
      for (const [param, values] of Object.entries(l.when ?? {})) {
        if (!params?.[param]) errors.push(`${owner}: условие по необъявленному параметру ${param}`);
        else for (const v of values) if (!(v in params[param])) errors.push(`${owner}: у параметра ${param} нет значения ${v}`);
      }
      for (const s of l.stages ?? []) if (stages && !stages.includes(s)) errors.push(`${owner}: стадия ${s} не объявлена`);
      if (typeof l.band !== 'string' && !l.note) warnings.push(`${owner}: точная частота ${l.f} = ${l.band.pct} % — проверьте, что источник её называет, и запишите откуда (note)`);
      if (typeof l.band === 'string' && l.note) errors.push(`${owner}: у ${l.f} пояснение (note) — только у точной частоты`);
    }
  };
  for (const c of Object.values(conditions)) {
    const owner = c.id;
    checkLinks(owner, c.findings, c.params, c.course.stages.map(s => s.id));
    for (const r of c.epidemiology.risks ?? []) if (!(r.id in risks) && !(r.id in conditions)) errors.push(`${owner}: фактор ${r.id} не найден`);
    for (const r of c.epidemiology.chronic?.risks ?? []) if (!(r.id in risks)) errors.push(`${owner}: фактор ${r.id} не найден`);
    for (const r of c.epidemiology.requires ?? []) if (!conditions[r]?.epidemiology.chronic) errors.push(`${owner}: требуемое ${r} не найдено или не хроническое`);
    for (const r of c.epidemiology.excludes ?? []) if (!conditions[r]?.epidemiology.chronic) errors.push(`${owner}: исключающее ${r} не найдено или не хроническое`);
    if (c.confirm !== 'clinical') for (const e of c.confirm) if (!(e in exams)) errors.push(`${owner}: подтверждающее обследование ${e} не найдено`);
    for (const f of c.redFlags ?? []) if (!hasF(f)) errors.push(`${owner}: красный флаг ${f} не найден`);
    if (!c.presenting && !c.epidemiology.chronic) errors.push(`${owner}: не бывает ни основным, ни хроническим`);
    // тактика: у всего, с чем приходят, и только из существующих лечений, без повторов
    const t = c.treatment;
    if (c.presenting && !t) errors.push(`${owner}: нет тактики (treatment) — с этим состоянием приходят`);
    if (c.presenting && !c.system) errors.push(`${owner}: не указана система органов (system) — без неё болезнь не попадёт в список диагнозов`);
    if (t) {
      const lists = [t.firstLine, t.acceptable, t.supportive, t.notIndicated, t.harmful];
      const seen = new Set<string>();
      for (const id of lists.flat()) {
        if (!(id in treatments)) errors.push(`${owner}: лечение ${id} не найдено`);
        if (seen.has(id)) errors.push(`${owner}: лечение ${id} стоит в двух списках тактики`);
        seen.add(id);
      }
      if (t.setting.param) {
        const p = c.params?.[t.setting.param.name];
        if (!p) errors.push(`${owner}: место лечения зависит от необъявленного параметра ${t.setting.param.name}`);
        else for (const v of Object.keys(p)) if (!t.setting.param.map[v]) errors.push(`${owner}: для ${t.setting.param.name}=${v} не сказано, где лечить`);
      }
      if (t.setting.redFlag && !c.redFlags?.length) errors.push(`${owner}: место при красном флаге задано, а красных флагов нет`);
      for (const r of t.setting.risks ?? []) if (!(r.id in risks)) errors.push(`${owner}: место лечения зависит от неизвестного фактора ${r.id}`);
      if (t.setting.default === 'home' && t.firstLine.length === 0) errors.push(`${owner}: лечат дома, а первой линии нет`);
      for (const id of t.plan ?? []) if (![...t.firstLine, ...t.acceptable, ...t.supportive].includes(id)) errors.push(`${owner}: в типичном назначении ${id} — не из первой линии, допустимых или облегчающих`);
      // тактика и действие лечения не спорят: то, что лечит причину, не бывает «не показано»,
      // а то, что само не проходит, первая линия лечит
      const cures = (id: string) => treatments[id]?.effects.some(e => e.on === owner && e.kind === 'cure') === true;
      for (const id of [...t.notIndicated, ...t.harmful]) if (cures(id)) errors.push(`${owner}: ${id} действует на причину, а в тактике — «не показано» или «вредно»`);
      if (c.presenting && !c.course.selfLimiting && t.setting.default === 'home' && !t.firstLine.some(cures)) errors.push(`${owner}: само не проходит, а первая линия не действует на причину`);
    }
    // операция (spec 2026-09-chapter-2, часть 28): вида «операция» и действует на причину
    if (c.surgery) {
      const op = treatments[c.surgery.tx];
      if (!op) errors.push(`${owner}: операция ${c.surgery.tx} не найдена`);
      else if (op.kind !== 'surgery') errors.push(`${owner}: ${c.surgery.tx} — не операция (kind: surgery)`);
      else if (!op.effects.some(e => e.on === owner && e.kind === 'cure')) errors.push(`${owner}: операция ${c.surgery.tx} не действует на причину`);
      // осложнённая стадия (часть 28б): у операции — свои доли для неё
      else if (c.complication && !op.surgery?.complicated) errors.push(`${owner}: у болезни есть осложнённая стадия, а у операции ${c.surgery.tx} нет долей для неё (complicated)`);
    }
    if (c.complication) {
      const x = c.complication;
      if (prob(x.early.p) >= 10000 || prob(x.later.p) >= 10000) errors.push(`${owner}: доля осложнённой стадии за отрезок должна быть меньше 100 %`);
      if (x.stay && x.stay[0] > x.stay[1]) errors.push(`${owner}: срок стационара в осложнённой стадии — от большего к меньшему`);
    }
    if (!c.course.selfLimiting && c.presenting && !c.course.untreated) warnings.push(`${owner}: не проходит само, но не сказано, что будет без лечения`);
  }
  for (const t of Object.values(treatments)) {
    for (const e of t.effects) if (!(e.on in conditions)) errors.push(`${t.id}: действует на неизвестное состояние ${e.on}`);
    // операция: помещение, бригада из его штата и аппараты из этого помещения
    if ((t.kind === 'surgery') !== (t.surgery !== undefined)) errors.push(`${t.id}: у операции (kind: surgery) должен быть блок surgery, и только у неё`);
    if (t.surgery) {
      const room = rooms[t.surgery.room];
      if (!room) errors.push(`${t.id}: помещение ${t.surgery.room} не найдено`);
      for (const r of t.surgery.team) {
        if (!roles[r]) errors.push(`${t.id}: должность ${r} не найдена`);
        else if (room && !room.staff.includes(r)) errors.push(`${t.id}: ${r} — не из штата ${t.surgery.room}`);
      }
      for (const id of t.surgery.equipment) {
        if (!equipment[id]) errors.push(`${t.id}: аппарат ${id} не найден`);
        else if (equipment[id].room !== t.surgery.room) errors.push(`${t.id}: аппарат ${id} стоит в ${equipment[id].room}, а операция — в ${t.surgery.room}`);
      }
      if (room && room.sizes.some(z => z.slots.length < t.surgery!.equipment.length)) errors.push(`${t.id}: в ${t.surgery.room} не у всех размеров хватит мест под аппараты операции`);
    }
    for (const k of t.contraindications) if (!(k.id in risks) && !(k.id in conditions)) errors.push(`${t.id}: противопоказание ${k.id} не найдено`);
  }
  for (const r of Object.values(risks)) checkLinks(r.id, r.findings);
  const revealedBy: Record<string, string[]> = {};
  for (const e of Object.values(exams)) {
    for (const ch of e.checks) {
      if (!hasF(ch.f)) errors.push(`${e.id}: проверяемый признак ${ch.f} не найден`);
      (revealedBy[ch.f] ??= []).push(e.id);
    }
  }
  for (const f of Object.keys(findings)) {
    if (!revealedBy[f]) errors.push(`${f}: ни одно обследование его не открывает`);
    else revealedBy[f].sort();
  }
  // шкалы по витальным: признак с числом, полосы подряд без щелей и перекрытий, края открыты
  for (const x of Object.values(scores)) {
    for (const par of x.params) {
      const spec = findings[par.f]?.value;
      if (!spec) { errors.push(`${x.id}: признак ${par.f} не найден или без числового значения`); continue; }
      const step = 10 ** -spec.decimals;
      const [first, last] = [par.points[0], par.points[par.points.length - 1]];
      if (first[0] !== null || last[1] !== null) errors.push(`${x.id}: ${par.f} — первая полоса без нижней границы, последняя — без верхней`);
      par.points.forEach(([lo, hi], i) => {
        if (lo !== null && hi !== null && lo > hi) errors.push(`${x.id}: ${par.f} — полоса ${lo}–${hi} наоборот`);
        const next = par.points[i + 1];
        if (next && (hi === null || next[0] === null || Math.abs(next[0] - hi - step) > step / 2)) errors.push(`${x.id}: ${par.f} — после ${hi} следующая полоса должна начинаться с ${hi === null ? '?' : Number((hi + step).toFixed(spec.decimals))}`);
      });
    }
    if (!(x.levels.medium < x.levels.high)) errors.push(`${x.id}: средний уровень ответа должен быть ниже высокого`);
  }
  checkWho({ conditions, findings, exams, risks }, errors);
  checkHospital({ rooms, equipment, roles, exams, conditions, treatments }, errors);

  // --- сборка ---
  const rects = (list: [number, number, number, number][]): Cell[] =>
    list.flatMap(([x0, y0, x1, y1]) => Array.from({ length: (y1 - y0 + 1) * (x1 - x0 + 1) }, (_, i) => [x0 + (i % (x1 - x0 + 1)), y0 + Math.floor(i / (x1 - x0 + 1))] as Cell));
  const db: ContentDb = {
    contentVersion, hash: '', conditions: {}, findings: {}, exams: {}, risks: {}, treatments: {}, rooms: {}, equipment: {}, roles: {}, presets: {},
    characters: Object.fromEntries(Object.values(characters).sort((a, b) => (a.id < b.id ? -1 : 1)).map(c => [c.id, c])),
    chapters: Object.fromEntries(Object.values(chapters).sort((a, b) => a.order - b.order).map(c => [c.id, c])),
    tips: Object.fromEntries(Object.values(tips).sort((a, b) => a.order - b.order).map(t => [t.id, t])),
    achievements: Object.fromEntries(Object.values(achievements).sort((a, b) => a.order - b.order).map(a => [a.id, a])),
    scores: Object.fromEntries(Object.values(scores).sort((a, b) => (a.id < b.id ? -1 : 1)).map(x => [x.id, x])),
    economy: economy
      ? { ...economy, sandbox: { ...economy.sandbox, corridor: rects(economy.sandbox.corridor) } }
      : NO_ECONOMY,
    revealedBy,
  };
  for (const c of Object.values(conditions).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const e = c.epidemiology;
    const out: Condition = {
      id: c.id, name: c.name, department: c.department, kind: c.kind, severity: c.severity, presenting: c.presenting,
      weight: PREVALENCE[e.prevalence],
      age: { min: e.age.min, max: e.age.max ?? 100, ...(e.age.peak ? { peak: e.age.peak } : {}) },
      stages: c.course.stages, findings: c.findings.map(compileLink), confirm: c.confirm,
      texts: c.texts, sources: c.sources, review: c.review,
    };
    if (c.icd10) out.icd10 = c.icd10;
    if (c.checkup) out.checkup = true;
    if (c.group) out.group = c.group;
    if (c.system) out.system = c.system;
    if (e.sex) out.sex = e.sex;
    if (e.season) out.season = e.season;
    if (e.risks) out.risks = e.risks;
    if (e.requires) out.requires = e.requires;
    if (e.excludes) out.excludes = e.excludes;
    if (e.chronic) out.chronic = { p: prob(e.chronic.band), ...(e.chronic.ageMin ? { ageMin: e.chronic.ageMin } : {}), ...(e.chronic.risks ? { risks: e.chronic.risks } : {}) };
    if (c.params) out.params = c.params;
    if (c.course.presentation) out.presentation = c.course.presentation;
    if (c.redFlags) out.redFlags = c.redFlags;
    if (c.course.selfLimiting) out.selfLimiting = true;
    if (c.course.untreated) out.untreated = { p: prob(c.course.untreated.band), days: c.course.untreated.days };
    if (c.course.stay) out.stay = c.course.stay;
    if (c.surgery) out.surgery = c.surgery;
    if (c.complication) {
      const x = c.complication;
      out.complication = { name: x.name, early: { hours: x.early.hours, p: prob(x.early.p) }, later: { every: x.later.every, p: prob(x.later.p) }, ...(x.stay ? { stay: x.stay } : {}) };
    }
    if (c.treatment) out.treatment = c.treatment;
    if (c.pearls) out.pearls = c.pearls;
    db.conditions[c.id] = out;
  }
  for (const f of Object.values(findings).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const out: Finding = { id: f.id, name: f.name, kind: f.id.split('.')[0] as Finding['kind'], leak: prob(f.leak), salience: f.salience, texts: f.texts, review: f.review };
    if (f.redFlag) out.redFlag = true;
    if (f.triage) out.triage = f.triage;
    if (f.attrs) out.attrs = f.attrs;
    if (f.value) out.value = f.value;
    db.findings[f.id] = out;
  }
  for (const e of Object.values(exams).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const out: Exam = {
      id: e.id, name: e.name, kind: e.kind, time: e.time, cost: e.cost, discomfort: e.discomfort,
      checks: e.checks.map(c => ({ f: c.f, sens: Math.round(c.sens * 100), spec: Math.round(c.spec * 100) })),
      texts: e.texts, sources: e.sources, review: e.review,
    };
    if (e.room) out.room = e.room;
    if (e.equipment) out.equipment = e.equipment;
    if (e.collect) out.collect = e.collect;
    if (e.radiation) out.radiation = e.radiation;
    if (e.routine) out.routine = true;
    if (e.sex) out.sex = e.sex;
    if (e.ageMin !== undefined) out.ageMin = e.ageMin;
    if (e.ageMax !== undefined) out.ageMax = e.ageMax;
    db.exams[e.id] = out;
  }
  for (const r of Object.values(risks).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const out: Risk = { id: r.id, name: r.name, p: { m: Math.round(r.prevalence.m * 100), f: Math.round(r.prevalence.f * 100) }, findings: r.findings.map(compileLink), sources: r.sources, review: r.review };
    if (r.ageMin) out.ageMin = r.ageMin;
    if (r.ageMax) out.ageMax = r.ageMax;
    db.risks[r.id] = out;
  }
  for (const t of Object.values(treatments).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const out: Treatment = {
      id: t.id, name: t.name, kind: t.kind, cost: t.cost,
      effects: t.effects.map(e => ({ on: e.on, kind: e.kind, p: prob(e.band), days: e.days })),
      contraindications: t.contraindications.map(k => ({ id: k.id, level: k.level, reaction: prob(k.reaction) })),
      texts: t.texts, sources: t.sources, review: t.review,
    };
    if (t.class) out.class = t.class;
    if (t.route) out.route = t.route;
    if (t.surgery) {
      const x = t.surgery;
      out.surgery = {
        room: x.room, team: x.team, equipment: x.equipment, minutes: x.minutes, complications: prob(x.complications),
        ...(x.death ? { death: prob(x.death) } : {}),
        ...(x.complicated ? { complicated: { complications: prob(x.complicated.complications), ...(x.complicated.death ? { death: prob(x.complicated.death) } : {}) } } : {}),
      };
    }
    db.treatments[t.id] = out;
  }
  const sortedIds = (xs: string[]) => [...xs].sort();
  const examIds = Object.keys(exams).sort();
  for (const r of Object.values(rooms).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const out: RoomType = {
      id: r.id, name: r.name, gen: r.gen, staff: r.staff, needsEquipment: r.needsEquipment, seats: r.seats, beds: r.beds, emergency: r.emergency,
      sizes: r.sizes.map(z => ({
        id: z.id, w: z.w, h: z.h, cost: z.cost, upkeep: z.upkeep, door: { x: z.door.x, width: z.door.width },
        objects: z.objects.map(([kind, x, y]) => ({ kind, x, y })), slots: z.slots, staff: z.staff,
        ...(z.patient ? { patient: z.patient } : {}),
        seats: r.seats ? z.objects.filter(([kind]) => kind === 'chair').length : 0,
        beds: r.beds || r.emergency ? z.objects.filter(([kind]) => kind === 'bed').length : 0,
        places: z.places,
      })),
      equipment: sortedIds(Object.values(equipment).filter(e => e.room === r.id).map(e => e.id)),
      exams: examIds.filter(id => exams[id].room === r.id),
      collects: examIds.filter(id => exams[id].collect === r.id),
      texts: r.texts,
    };
    db.rooms[r.id] = out;
  }
  for (const e of Object.values(equipment).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const out: Equipment = {
      id: e.id, name: e.name, gen: e.gen, room: e.room, sprite: e.sprite, price: e.price, upkeep: e.upkeep,
      breakdown: Math.round(e.breakdown * 100), speed: e.speed, quality: e.quality,
      exams: examIds.filter(id => exams[id].equipment?.includes(e.id)), texts: e.texts,
    };
    if (e.upgradeOf) out.upgradeOf = e.upgradeOf;
    if (e.slot !== undefined) out.slot = e.slot;
    db.equipment[e.id] = out;
  }
  for (const r of Object.values(roles).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const out: StaffRole = {
      id: r.id, name: r.name, gen: r.gen, hire: r.hire, salary: r.salary,
      ...(r.stands ? { stands: r.stands } : {}), ...(r.needs ? { needs: r.needs } : {}), ...(r.reads ? { reads: true as const } : {}),
      // встающий на чужое место работает там же, где та должность
      rooms: Object.keys(rooms).sort().filter(id => rooms[id].staff.includes(r.stands ?? r.id)), texts: r.texts,
    };
    db.roles[r.id] = out;
  }
  for (const p of Object.values(presets).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const out: Preset = {
      id: p.id, name: p.name, plot: p.plot, entrance: p.entrance, corridor: rects(p.corridor),
      rooms: p.rooms.map(r => ({ type: r.type, size: r.size, x: r.x, y: r.y, rot: r.rot, ...(r.door !== undefined ? { door: r.door } : {}), equipment: r.equipment })),
      decor: p.decor.map(([kind, x, y]) => ({ kind, x, y })), staff: p.staff,
    };
    db.presets[p.id] = out;
  }
  if (errors.length === 0) {
    checkPresets(db, errors);
    checkCampaign(db, errors);
    checkAchievements(db, errors);
    // скорая везёт болезнь отделения (engine.ts, ambulancePatient): раз смотровую приёмного
    // можно построить, у каждого отделения должно быть кого везти — иначе день не начнётся
    if (Object.values(db.rooms).some(r => r.emergency)) {
      const conditions = Object.values(db.conditions);
      const departments = new Set([...conditions.map(x => x.department), ...Object.values(db.chapters).map(ch => ch.department)]);
      for (const d of departments) {
        const carried = conditions.some(x => x.department === d && x.presenting && !x.checkup && x.treatment && x.weight > 0 && db.economy.ambulance.weight[x.severity] > 0);
        if (!carried) errors.push(`${d}: скорой некого везти — нет болезни отделения с тяжестью, которую везут (hospital/economy.yaml, ambulance.weight)`);
      }
    }
    // готовая амбулатория помещается на участок песочницы, вход песочницы — в краю
    const sb = db.economy.sandbox;
    for (const p of Object.values(db.presets)) {
      if (p.plot[0] > sb.plot[0] || p.plot[1] > sb.plot[1]) errors.push(`${p.id}: участок ${p.plot.join(' × ')} больше участка песочницы`);
      else errors.push(...presetHospital(db, p, sb.plot).failed.map(f => `${p.id}: на участке песочницы помещение ${f.room} — ${f.error.kind}`));
    }
    for (const r of Object.keys(db.economy.level.rooms)) if (!db.rooms[r]) errors.push(`hospital/economy.yaml: уровень ОМС — помещение ${r} не найдено`);
    const [ex, ey] = sb.entrance;
    if (!(ex === 0 || ey === 0 || ex === sb.plot[0] - 1 || ey === sb.plot[1] - 1)) errors.push(`hospital/economy.yaml: вход песочницы (${ex}, ${ey}) — не в краю участка`);
  }
  db.hash = fingerprint({ ...db, hash: '' });
  return { db, errors, warnings, files: files.length };
}

/**
 * Кампания (spec 2026-09-campaign): главы ссылаются на готовую больницу, помещения, болезни
 * своего отделения и персонажей; письма «при задании» — на задание этой главы; подсказки — на
 * персонажа, болезнь и статьи энциклопедии.
 */
function checkCampaign(db: ContentDb, errors: string[]) {
  const orders = new Set<number>();
  for (const c of Object.values(db.chapters)) {
    const at = (what: string) => errors.push(`${c.id}: ${what}`);
    if (orders.has(c.order)) at(`порядок ${c.order} уже у другой главы`);
    orders.add(c.order);
    if (!db.presets[c.preset]) at(`готовая больница ${c.preset} не найдена`);
    for (const r of c.build) if (!db.rooms[r]) at(`помещение ${r} не найдено`);
    if (!Object.values(db.conditions).some(x => x.presenting && x.department === c.department)) at(`в отделении ${c.department} нет болезней`);
    for (const t of c.tutorial) {
      const cond = db.conditions[t];
      if (!cond) at(`болезнь обучения ${t} не найдена`);
      else if (!cond.presenting || cond.department !== c.department) at(`болезнь обучения ${t} — не из приёма отделения ${c.department}`);
    }
    const missions = new Set<string>();
    for (const m of c.missions) {
      if (missions.has(m.id)) at(`задание ${m.id} повторяется`);
      missions.add(m.id);
      if (m.kind === 'roomWorks' && !db.rooms[m.room]) at(`задание ${m.id}: помещение ${m.room} не найдено`);
      if (m.kind === 'roomWorks' && !c.build.includes(m.room) && !db.presets[c.preset]?.rooms.some(r => r.type === m.room)) at(`задание ${m.id}: ${m.room} нельзя построить в главе`);
    }
    if (!c.missions.some(m => m.main)) at('нет основных заданий');
    const letters = new Set<string>();
    for (const l of c.letters) {
      if (letters.has(l.id)) at(`письмо ${l.id} повторяется`);
      letters.add(l.id);
      if (!db.characters[l.from]) at(`письмо ${l.id}: персонаж ${l.from} не найден`);
      if (typeof l.when === 'object' && 'mission' in l.when && !missions.has(l.when.mission)) at(`письмо ${l.id}: задания ${l.when.mission} в главе нет`);
    }
  }
  // подсказки наставника: от персонажа, о болезни приёма, со ссылками на статьи энциклопедии
  const tipOrders = new Set<number>();
  for (const t of Object.values(db.tips)) {
    const at = (what: string) => errors.push(`${t.id}: ${what}`);
    if (tipOrders.has(t.order)) at(`порядок ${t.order} уже у другой подсказки`);
    tipOrders.add(t.order);
    if (!db.characters[t.from]) at(`персонаж ${t.from} не найден`);
    if (typeof t.when === 'object' && !db.conditions[t.when.condition]?.presenting) at(`болезнь ${t.when.condition} не найдена или с ней не приходят`);
    for (const id of t.see) if (!(db.conditions[id] || db.findings[id] || db.exams[id] || db.treatments[id] || db.risks[id] || db.rooms[id] || db.equipment[id] || db.roles[id])) at(`статья ${id} не найдена`);
  }
}

/** Достижения (spec 2026-09-campaign, часть 13): отделение, помещение и глава — существующие; порядок не повторяется. */
function checkAchievements(db: ContentDb, errors: string[]) {
  const orders = new Set<number>();
  for (const a of Object.values(db.achievements)) {
    const at = (what: string) => errors.push(`${a.id}: ${what}`);
    if (orders.has(a.order)) at(`порядок ${a.order} уже у другого достижения`);
    orders.add(a.order);
    if (a.kind === 'department' && !Object.values(db.conditions).some(c => c.presenting && c.department === a.department)) at(`в отделении ${a.department} нет болезней`);
    if (a.kind === 'roomWorks' && !db.rooms[a.room]) at(`помещение ${a.room} не найдено`);
    if (a.kind === 'chapter' && !db.chapters[a.chapter]) at(`глава ${a.chapter} не найдена`);
    if (a.kind === 'allergyAsked' && !db.exams[ALLERGY_EXAM]) at(`вопроса об аллергии ${ALLERGY_EXAM} в базе нет`);
  }
}

/**
 * Готовые больницы строятся движком стройки теми же командами, что у игрока (spec
 * 2026-09-own-hospital): что движок не построит, в базу не попадёт. В готовой больнице
 * работает каждое помещение: штат на местах, аппараты стоят, от входа можно дойти.
 */
function checkPresets(db: ContentDb, errors: string[]) {
  for (const p of Object.values(db.presets)) {
    for (const r of p.rooms) {
      if (!db.rooms[r.type]) { errors.push(`${p.id}: помещение ${r.type} не найдено`); return; }
      if (!db.rooms[r.type].sizes.some(z => z.id === r.size)) { errors.push(`${p.id}: у ${r.type} нет размера ${r.size}`); return; }
    }
    const seen = new Set<string>();
    for (const s of p.staff) {
      const room = p.rooms[s.room];
      if (!room) errors.push(`${p.id}: ${s.role} — в помещении ${s.room}, а их ${p.rooms.length}`);
      else if (!db.rooms[room.type].staff.includes(s.role)) errors.push(`${p.id}: ${s.role} не нужен в ${room.type}`);
      if (seen.has(`${s.room}:${s.role}`)) errors.push(`${p.id}: в помещении ${s.room} два человека на ${s.role}`);
      seen.add(`${s.room}:${s.role}`);
    }
    const [w, h] = p.plot;
    const [ex, ey] = p.entrance;
    if (!(ex === 0 || ey === 0 || ex === w - 1 || ey === h - 1)) errors.push(`${p.id}: вход (${ex}, ${ey}) — не в краю участка`);
    for (const [x, y] of p.corridor) if (x < 1 || y < 1 || x > w - 2 || y > h - 2) errors.push(`${p.id}: коридор (${x}, ${y}) — у самого края участка`);
    const corridor = new Set(p.corridor.map(([x, y]) => `${x},${y}`));
    for (const d of p.decor) if (!corridor.has(`${d.x},${d.y}`)) errors.push(`${p.id}: ${d.kind} (${d.x}, ${d.y}) — не в коридоре`);
    const built = presetHospital(db, p);
    for (const f of built.failed) {
      const what = f.cmd === 'room' ? 'не ставится' : f.cmd === 'door' ? 'дверь не туда' : `аппарат ${f.equipment} не ставится`;
      errors.push(`${p.id}: помещение ${f.room} (${p.rooms[f.room].type}) — ${what}: ${f.error.kind}`);
    }
    if (built.failed.length > 0) continue;
    const plan = planOf(db, built.hospital);
    const staffed = (room: string, role: string) => p.staff.some(s => `r${s.room + 1}` === room && s.role === role);
    for (const r of plan.rooms) {
      for (const pr of problemsOf(db, plan, r, staffed)) errors.push(`${p.id}: ${r.type} (${r.id}) не работает: ${pr.kind}${pr.kind === 'noStaff' ? ` ${pr.role}` : ''}`);
    }
  }
}

/**
 * Кому делают обследование — по его признакам. Все признаки бывают только у одного пола — и
 * обследование только для него: мужчине не отвечают «беременности нет, насколько она знает».
 * Возраст обследования — не уже, чем у болезней и факторов, которые дают его признаки: иначе
 * признак некому открыть. Фон популяции (`leak`) бывает у всех.
 */
function checkWho(c: {
  conditions: Record<string, ConditionSrc>; findings: Record<string, FindingSrc>; exams: Record<string, ExamSrc>; risks: Record<string, RiskSrc>;
}, errors: string[]) {
  type Who = { m: boolean; f: boolean; min: number; max: number };
  const sexes: Record<string, { m: boolean; f: boolean }> = {};
  const ages: Record<string, { min: number; max: number }> = {};
  const add = (id: string, w: Who) => {
    const s = sexes[id];
    sexes[id] = { m: (s?.m ?? false) || w.m, f: (s?.f ?? false) || w.f };
    const a = ages[id];
    ages[id] = { min: Math.min(a?.min ?? w.min, w.min), max: Math.max(a?.max ?? w.max, w.max) };
  };
  for (const f of Object.values(c.findings)) if (f.leak !== 'never') sexes[f.id] = { m: true, f: true };
  for (const cond of Object.values(c.conditions)) {
    const sex = cond.epidemiology.sex;
    const w = { m: !sex || sex.m > 0, f: !sex || sex.f > 0, min: cond.epidemiology.age.min, max: cond.epidemiology.age.max ?? 120 };
    for (const l of cond.findings) add(l.f, w);
  }
  for (const r of Object.values(c.risks)) {
    const w = { m: r.prevalence.m > 0, f: r.prevalence.f > 0, min: r.ageMin ?? 0, max: r.ageMax ?? 120 };
    for (const l of r.findings) add(l.f, w);
  }
  for (const e of Object.values(c.exams)) {
    const own = e.checks.map(ch => sexes[ch.f]).filter(x => x !== undefined);
    if (own.length > 0 && !own.some(x => x.m) && e.sex !== 'f') errors.push(`${e.id}: его признаки бывают только у женщин — нужно sex: f`);
    if (own.length > 0 && !own.some(x => x.f) && e.sex !== 'm') errors.push(`${e.id}: его признаки бывают только у мужчин — нужно sex: m`);
    if (e.ageMin !== undefined && e.ageMax !== undefined && e.ageMin > e.ageMax) errors.push(`${e.id}: ageMin больше ageMax`);
    for (const ch of e.checks) {
      const a = ages[ch.f];
      if (!a) continue;
      if (e.ageMin !== undefined && e.ageMin > a.min) errors.push(`${e.id}: признак ${ch.f} бывает с ${a.min} лет, а обследование — с ${e.ageMin}`);
      if (e.ageMax !== undefined && e.ageMax < a.max) errors.push(`${e.id}: признак ${ch.f} бывает до ${a.max} лет, а обследование — до ${e.ageMax}`);
    }
  }
}

/**
 * Каталог больницы (spec 2026-09-own-hospital): ссылки между помещениями, аппаратами,
 * должностями и обследованиями; шаблоны размеров — предметы и места внутри пола, ряд под
 * подпись и проход у двери свободны, двери на нижней стене.
 */
function checkHospital(c: {
  rooms: Record<string, RoomSrc>; equipment: Record<string, EquipmentSrc>; roles: Record<string, RoleSrc>;
  exams: Record<string, ExamSrc>; conditions: Record<string, ConditionSrc>; treatments: Record<string, TreatmentSrc>;
}, errors: string[]) {
  const { rooms, equipment, roles, exams } = c;
  const exList = Object.values(exams);
  for (const e of exList) {
    if (e.room && !rooms[e.room]) errors.push(`${e.id}: помещение ${e.room} не найдено в каталоге больницы`);
    if (e.collect && !rooms[e.collect]) errors.push(`${e.id}: помещение для материала ${e.collect} не найдено`);
    if ((e.equipment || e.collect) && !e.room) errors.push(`${e.id}: аппарат или забор материала есть, а помещения нет`);
    for (const id of e.equipment ?? []) {
      if (!equipment[id]) errors.push(`${e.id}: аппарат ${id} не найден`);
      else if (equipment[id].room !== e.room) errors.push(`${e.id}: аппарат ${id} стоит в ${equipment[id].room}, а обследование — в ${e.room}`);
    }
    if (e.room && rooms[e.room]?.needsEquipment && !e.equipment) errors.push(`${e.id}: в ${e.room} без аппарата не работают — укажите equipment`);
  }
  // пациент приходит туда, где берут материал, и туда, где обследование делают с ним самим
  const visited = new Set(exList.flatMap(e => (e.collect ? [e.collect] : e.room ? [e.room] : [])));
  for (const r of Object.values(rooms)) {
    for (const role of r.staff) if (!roles[role]) errors.push(`${r.id}: должность ${role} не найдена`);
    if (r.needsEquipment && !Object.values(equipment).some(e => e.room === r.id)) errors.push(`${r.id}: без аппарата не работает, а аппаратов для него в каталоге нет`);
    const ids = new Set<string>();
    for (const z of r.sizes) {
      const at = `${r.id} ${z.id}`;
      if (ids.has(z.id)) errors.push(`${at}: размер повторяется`);
      ids.add(z.id);
      const inner = (x: number, y: number) => x >= 1 && y >= 1 && x <= z.w - 2 && y <= z.h - 2;
      const service = (y: number) => y === 1 || y === z.h - 2; // подпись и проход у двери
      const taken = new Map<string, string>();
      for (const [kind, x, y] of z.objects) {
        if (!inner(x, y)) errors.push(`${at}: ${kind} (${x}, ${y}) — вне пола`);
        else if (service(y)) errors.push(`${at}: ${kind} (${x}, ${y}) — в ряду под подпись или в проходе у двери`);
        if (taken.has(`${x},${y}`)) errors.push(`${at}: в (${x}, ${y}) два предмета`);
        taken.set(`${x},${y}`, kind);
      }
      for (const [x, y] of z.slots) {
        if (!inner(x, y) || service(y)) errors.push(`${at}: место под аппарат (${x}, ${y}) — вне пола, в ряду под подпись или в проходе`);
        if (taken.has(`${x},${y}`)) errors.push(`${at}: место под аппарат (${x}, ${y}) занято предметом`);
        taken.set(`${x},${y}`, 'slot');
      }
      if (r.needsEquipment && z.slots.length === 0) errors.push(`${at}: без аппарата не работает, а мест под аппараты нет`);
      if (z.door.x + z.door.width - 1 > z.w - 2) errors.push(`${at}: дверь выходит за стену`);
      // человек садится на стул или кушетку; пациент — ещё и к аппарату
      const spot = (who: string, [x, y]: [number, number], allowed: string[]) => {
        if (!inner(x, y) || y === 1) errors.push(`${at}: место ${who} (${x}, ${y}) — вне пола или в ряду под подпись`);
        const k = taken.get(`${x},${y}`);
        if (k && !allowed.includes(k)) errors.push(`${at}: место ${who} (${x}, ${y}) занято: ${k}`);
      };
      for (const role of r.staff) {
        if (!z.staff[role]) errors.push(`${at}: не сказано, где стоит ${role}`);
      }
      for (const [role, cell] of Object.entries(z.staff)) {
        if (!r.staff.includes(role)) errors.push(`${at}: место для ${role}, а такой должности в помещении нет`);
        spot(role, cell, ['chair']);
      }
      if (z.patient) spot('пациента', z.patient, ['chair', 'couch', 'slot']);
      else if (visited.has(r.id)) errors.push(`${at}: сюда приходят пациенты, а места для пациента нет`);
      if (r.seats && !z.objects.some(([kind]) => kind === 'chair')) errors.push(`${at}: зона ожидания без стульев`);
      if (r.beds && !z.objects.some(([kind]) => kind === 'bed')) errors.push(`${at}: палата без коек`);
      if (r.emergency && !z.objects.some(([kind]) => kind === 'bed')) errors.push(`${at}: смотровая приёмного без мест для скорой`);
      if (r.beds && r.emergency) errors.push(`${at}: помещение — или палата, или смотровая приёмного`);
    }
  }
  for (const e of Object.values(equipment)) {
    if (!rooms[e.room]) errors.push(`${e.id}: помещение ${e.room} не найдено`);
    else if (rooms[e.room].sizes.some(z => z.slots.length === 0)) errors.push(`${e.id}: в ${e.room} не у всех размеров есть место под аппарат`);
    if (e.upgradeOf && equipment[e.upgradeOf]?.room !== e.room) errors.push(`${e.id}: улучшает ${e.upgradeOf} — такого аппарата в том же помещении нет`);
    if (e.slot !== undefined && rooms[e.room]?.sizes.some(z => e.slot! >= z.slots.length)) errors.push(`${e.id}: места ${e.slot} под аппарат нет у всех размеров ${e.room}`);
    // аппаратом делают обследование или операцию (операционный стол, наркозный аппарат — часть 28)
    const used = exList.some(x => x.equipment?.includes(e.id)) || Object.values(c.treatments).some(t => t.surgery?.equipment.includes(e.id));
    if (!used) errors.push(`${e.id}: ни одно обследование и ни одна операция им не делают`);
  }
  for (const r of Object.values(roles)) {
    if (r.salary[0] > r.salary[1]) errors.push(`${r.id}: зарплата при навыке 1 больше, чем при навыке 5`);
    if (r.stands && !roles[r.stands]) errors.push(`${r.id}: встаёт на место ${r.stands} — такой должности нет`);
    if (r.stands && roles[r.stands]?.hire !== false) errors.push(`${r.id}: встать можно только на место врача — должности, которую не нанимают`);
    if (r.needs && !rooms[r.needs]) errors.push(`${r.id}: нужна ${r.needs} — такого помещения нет`);
    else if (r.needs && !rooms[r.needs].sizes.every(z => z.places > 0)) errors.push(`${r.id}: нужна ${r.needs}, а мест для врачей в ней нет`);
    if (!Object.values(rooms).some(x => x.staff.includes(r.stands ?? r.id))) errors.push(`${r.id}: ни одно помещение в нём не нуждается`);
    // описывает снимки (часть 29): там, где он работает, снимки делают
    if (r.reads && !Object.values(rooms).some(x => x.staff.includes(r.id) && exList.some(e => e.room === x.id && e.kind === 'imaging'))) errors.push(`${r.id}: описывает снимки, а там, где он работает, снимков не делают`);
  }
  // снимок помещения описывает один человек — от его навыка точность
  for (const x of Object.values(rooms)) {
    const readers = x.staff.filter(id => roles[id]?.reads);
    if (readers.length > 1) errors.push(`${x.id}: снимки описывают сразу ${readers.join(' и ')} — должен один`);
  }
  // подтверждающее обследование должно быть достижимо: помещение и аппарат есть в каталоге
  for (const cond of Object.values(c.conditions)) {
    if (cond.confirm === 'clinical') continue;
    for (const id of cond.confirm) {
      const e = exams[id];
      if (e?.room && !rooms[e.room]) errors.push(`${cond.id}: подтверждающее ${id} недостижимо — нет помещения ${e.room}`);
    }
  }
}
