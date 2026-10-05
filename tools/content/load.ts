// Сборка медицинской базы из YAML в память: схема, ссылки, полосы → числа
// (`docs/05-content.md` §6, `docs/07-data-model.md` §1). Используют build.ts, тесты и
// «виртуальный врач» — все читают одну и ту же базу.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { parse } from 'yaml';
import type { z } from 'zod';
import { type AttrSpec, beyond, byParams, type Cell, type Condition, type ContentDb, type Equipment, type Exam, type Finding, type Link, membersOf, type Preset, type Risk, type RoomType, type RulePoints, type StaffRole, type Treatment } from '../../src/content/types';
import { planOf, presetHospital } from '../../src/engine/hospital/build';
import { problemsOf } from '../../src/engine/hospital/requirements';
import { ALLERGY_EXAM } from '../../src/engine/career/achievements';
import { fingerprint } from '../../src/engine/core/hash';
import { P_ONE } from '../../src/engine/core/rng';
import { SETTING_ORDER } from '../../src/engine/med/plan';
import { findBrand } from './brands';
import {
  BANDS, type ChapterSrc, chapterSchema, type CharacterSrc, characterSchema, type ConditionSrc, conditionSchema, type EconomySrc, economySchema, type EquipmentSrc, equipmentSchema, type ExamSrc, examSchema, type FindingSrc, findingSchema,
  type LinkSrc, PREVALENCE, type PresetSrc, presetSchema, type ProbabilitySrc, type RiskSrc, type RoleSrc, riskSchema, roleSchema, type RoomSrc, roomSchema,
  type TipSrc, tipSchema, type TreatmentSrc, treatmentSchema, versionSchema, type AchievementSrc, achievementSchema, type ScoreSrc, scoreSchema,
  type RuleSrc, ruleSchema, type TargetSrc, targetSchema,
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
  tariffs: { oms: { minor: 0, moderate: 0, serious: 0, critical: 0 }, omsWard: { minor: 0, moderate: 0, serious: 0, critical: 0 }, omsOperation: 0, omsIcu: 0, omsQuality: { A: 0, B: 0, C: 0, D: 0 }, omsUnconfirmed: 0, omsExam: 0, dms: { visit: 0, price: 0 }, self: { visit: 0, price: 0 } },
  level: { base: 100, rooms: {} },
  payers: { dms: [0, 0, 0], self: [0, 0, 0] },
  consumables: { ask: 0, physical: 0, bedside: 0, lab: 0, rapid: 0, functional: 0, imaging: 0 },
  interest: 0,
  ward: { bedDay: 0, interrupted: 0 },
  icu: { bedDay: 0 },
  transfer: { hours: 2, pci: 1 },
  ambulance: { perDay: [0, 0], weight: { minor: 0, moderate: 0, serious: 0, critical: 0 }, severe: 0 },
  reputation: { start: 50, pull: 1, waitShort: 0, waitShortMin: 0, waitLong: 0, waitLongMin: 0, noToilet: 0, died: 0 },
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
      // «-$side» — сторона напротив (часть 41в): гематома — в полушарии, противоположном слабости
      out.attrs[name] = (typeof spec !== 'string' ? { dist: spec } : spec.startsWith('-') ? { param: spec.slice(2), opposite: true } : { param: spec.slice(1) }) satisfies AttrSpec;
    }
  }
  return out;
}

/** Записи «без лечения» списком (часть 41б): одна запись — список из неё. */
function untreatedList<T>(u: T | T[] | undefined): T[] {
  return u === undefined ? [] : Array.isArray(u) ? u : [u];
}

/**
 * Сколько баллов можно набрать по шкале правила (часть 41б): пункт с «не считается при» — не вместе
 * с теми пунктами. Перебор наборов: пунктов у шкал — до десятка.
 */
function pointsMax(p: RulePoints, sex?: 'm' | 'f'): number {
  let best = 0;
  for (let mask = 0; mask < 1 << p.items.length; mask++) {
    const on = p.items.filter((_, i) => mask & (1 << i));
    if (on.some(i => (i.unless ?? []).some(u => on.some(o => o.f === u)))) continue;
    best = Math.max(best, on.reduce((a, i) => a + i.w, 0));
  }
  // возраст — наибольшая полоса, пол (часть 42а) — свой, а без пола — больший из двух
  const sexW = sex ? (p.sex?.[sex] ?? 0) : Math.max(0, ...Object.values(p.sex ?? {}));
  return best + Math.max(0, ...(p.age ?? []).map(a => a.w)) + sexW;
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
  const rules: Record<string, RuleSrc> = {};
  const targets: Record<string, TargetSrc> = {};
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
    } else if (top === 'rules') {
      const x = check(ruleSchema);
      if (x) { expectId(x.id, 'rule'); put(rules, x); }
    } else if (top === 'targets') {
      const x = check(targetSchema);
      if (x) { expectId(x.id, 'target'); put(targets, x); }
    } else {
      errors.push(`${rel}: файл вне известных разделов (conditions, findings, exams, risks, treatments, hospital/rooms, hospital/equipment, hospital/roles, hospital/presets, hospital/economy.yaml, campaign/characters, campaign/chapters, campaign/tips, achievements, scores, rules, targets)`);
    }
  }
  if (!contentVersion) errors.push('version.yaml: нет contentVersion');
  if (!economy) errors.push('hospital/economy.yaml: нет баланса больницы');

  // --- ссылки ---
  const hasF = (id: string) => id in findings;
  /** условие по скрытому параметру болезни (часть 30в): параметр объявлен, значения — из его списка */
  const checkWhen = (owner: string, what: string, when: Record<string, string[]> | undefined, params?: Record<string, Record<string, number>>) => {
    for (const [param, values] of Object.entries(when ?? {})) {
      if (!params?.[param]) errors.push(`${owner}: ${what} — условие по необъявленному параметру ${param}`);
      else for (const v of values) if (!(v in params[param])) errors.push(`${owner}: ${what} — у параметра ${param} нет значения ${v}`);
    }
  };
  /** бывают ли оба условия сразу: по каждому общему параметру есть общее значение */
  const overlaps = (a: Record<string, string[]> | undefined, b: Record<string, string[]> | undefined) =>
    Object.entries(a ?? {}).every(([param, values]) => !b?.[param] || values.some(v => b[param].includes(v)));
  const checkLinks = (owner: string, links: LinkSrc[], params?: Record<string, Record<string, number>>, stages?: string[]) => {
    for (const l of links) {
      if (!hasF(l.f)) { errors.push(`${owner}: признак ${l.f} не найден`); continue; }
      for (const [attr, spec] of Object.entries(l.attrs ?? {})) {
        if (!findings[l.f].attrs?.[attr]) errors.push(`${owner}: у признака ${l.f} нет атрибута ${attr}`);
        if (typeof spec === 'string') {
          // сторона напротив (часть 41в) — только у стороны: справа и слева
          const opposite = spec.startsWith('-');
          const param = spec.slice(opposite ? 2 : 1);
          if (!params?.[param]) errors.push(`${owner}: параметр ${param} не объявлен`);
          else if (opposite && Object.keys(params[param]).some(v => v !== 'right' && v !== 'left')) errors.push(`${owner}: сторона напротив — у параметра ${param}, а его значения не справа и слева`);
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
    // производные параметры (часть 32г): значения «no» и «yes», правило есть, а признаки от
    // параметра не зависят — он сам считается по признакам; порог на измерении (часть 38б) — на
    // числе признака, и порог внутри его диапазонов, иначе ответ всегда один
    for (const [name, d] of Object.entries(c.derived ?? {})) {
      const p = c.params?.[name];
      if (!p) errors.push(`${owner}: производный параметр ${name} не объявлен в params — нужны доли для вывода`);
      else if (Object.keys(p).sort().join() !== 'no,yes') errors.push(`${owner}: у производного параметра ${name} значения — no и yes`);
      if (typeof d === 'string') {
        if (!rules[d]) errors.push(`${owner}: правило ${d} параметра ${name} не найдено`);
      } else if ('rule' in d) {
        // по баллам шкалы (часть 41б): у правила есть баллы, и порог можно набрать
        const pts = rules[d.rule]?.points;
        if (!pts) errors.push(`${owner}: параметр ${name} — по баллам ${d.rule}, а у него нет баллов`);
        else if (d.from > pointsMax(pts)) errors.push(`${owner}: параметр ${name} — от ${d.from} баллов, а у ${d.rule} их не больше ${pointsMax(pts)}`);
      } else if ('has' in d) {
        // по признаку (часть 44а): признак есть в базе, и какое-то обследование его проверяет — иначе врач не узнает
        if (!findings[d.has]) errors.push(`${owner}: параметр ${name} — по признаку ${d.has}, а его нет`);
        else if (!Object.values(exams).some(e => e.checks.some(k => k.f === d.has))) errors.push(`${owner}: параметр ${name} — по признаку ${d.has}, а его не проверяет ни одно обследование`);
      } else if ('all' in d || 'any' in d) {
        // по другим параметрам (части 41а и 43в): они объявлены, значения у них есть, и сами они — не такие же
        for (const [other, values] of Object.entries('all' in d ? d.all : d.any)) {
          const q = c.params?.[other];
          if (other === name || !q) errors.push(`${owner}: параметр ${name} — по параметру ${other}, а его нет или это он сам`);
          else for (const v of values) if (!(v in q)) errors.push(`${owner}: параметр ${name} — по ${other}=${v}, а такого значения нет`);
          const od = c.derived?.[other];
          if (byParams(od)) errors.push(`${owner}: параметр ${name} — по ${other}, а тот сам по параметрам`);
        }
      } else {
        const v = findings[d.f]?.value;
        if (!v) errors.push(`${owner}: порог параметра ${name} — на ${d.f}, а у него нет числа`);
        else {
          const lo = Math.min(v.present[0], v.absent[0]);
          const hi = Math.max(v.present[1], v.absent[1]);
          // ниже порога или (часть 43в) выше — бывает не у всех и не ни у кого: «ниже» нижнего края и «выше» верхнего — никогда
          const at = d.below ?? d.above ?? NaN;
          const inside = d.below !== undefined ? at > lo && at <= hi : at >= lo && at < hi;
          if (!inside) errors.push(`${owner}: порог ${at} параметра ${name} вне диапазонов ${d.f} (${lo}–${hi})`);
          // с ходом времени (часть 41а) — только часы: к ним прибавляются часы от прихода до решения
          if (d.clock && v.unit !== 'ч') errors.push(`${owner}: порог параметра ${name} идёт со временем, а ${d.f} — не в часах`);
        }
      }
      for (const l of c.findings) {
        if (l.when?.[name]) errors.push(`${owner}: признак ${l.f} зависит от производного параметра ${name}, а тот — от признаков`);
        if (Object.values(l.attrs ?? {}).includes(`$${name}`)) errors.push(`${owner}: атрибут признака ${l.f} — из производного параметра ${name}, а тот — от признаков`);
      }
    }
    // часы от начала (часть 39а): число — у признака в часах, который есть у каждого такого больного,
    // интервалы — по возрастанию, внутри его диапазона «есть», и в каждом есть целый час от одного
    const onset = c.course.onset;
    if (onset) {
      const v = findings[onset.f]?.value;
      if (!v || v.unit !== 'ч') errors.push(`${owner}: часы от начала — на ${onset.f}, а у него нет числа в часах`);
      else if (onset.hours.some(([h], i) => h <= (i === 0 ? v.present[0] : onset.hours[i - 1][0])) || onset.hours[onset.hours.length - 1][0] > v.present[1]) {
        errors.push(`${owner}: интервалы часов от начала — по возрастанию и внутри ${v.present[0]}–${v.present[1]} ч`);
      } else if (onset.hours.some(([h], i) => h - 1 < Math.max(1, i === 0 ? 0 : onset.hours[i - 1][0]))) {
        errors.push(`${owner}: в интервале часов от начала нет целого часа от одного — больной назвал бы «0 ч»`);
      }
      if (!c.findings.some(l => l.f === onset.f && prob(l.band) === P_ONE && !l.when && !l.stages)) errors.push(`${owner}: часы от начала — на ${onset.f}, а он есть не у каждого такого больного`);
    }
    for (const r of c.epidemiology.risks ?? []) if (!(r.id in risks) && !(r.id in conditions)) errors.push(`${owner}: фактор ${r.id} не найден`);
    for (const r of c.epidemiology.chronic?.risks ?? []) if (!(r.id in risks)) errors.push(`${owner}: фактор ${r.id} не найден`);
    for (const r of c.epidemiology.requires ?? []) if (!conditions[r]?.epidemiology.chronic) errors.push(`${owner}: требуемое ${r} не найдено или не хроническое`);
    for (const r of c.epidemiology.excludes ?? []) if (!conditions[r]?.epidemiology.chronic) errors.push(`${owner}: исключающее ${r} не найдено или не хроническое`);
    if (c.confirm !== 'clinical') for (const e of c.confirm) if (!(e in exams)) errors.push(`${owner}: подтверждающее обследование ${e} не найдено`);
    for (const f of c.redFlags ?? []) if (!hasF(f)) errors.push(`${owner}: красный флаг ${f} не найден`);
    // чего при состоянии не бывает (часть 39а): признак есть в базе, а сама запись его не вызывает
    for (const f of c.masks ?? []) {
      if (!hasF(f)) errors.push(`${owner}: гасит признак ${f}, а его нет`);
      else if (c.findings.some(l => l.f === f)) errors.push(`${owner}: признак ${f} и вызывает, и гасит`);
    }
    // исход перевода по часам (часть 39б): параметры объявлены, у каждого класса границы, часы по
    // возрастанию, доля потери не убывает, тромболизис — лечение базы, часы от начала известны
    if (c.reperfusion) {
      const r = c.reperfusion;
      checkWhen(owner, 'исход перевода', r.when, c.params);
      const by = c.params?.[r.by];
      if (!by) errors.push(`${owner}: исход перевода — по необъявленному параметру ${r.by}`);
      else {
        for (const v of Object.keys(by)) if (!r.death[v]) errors.push(`${owner}: исход перевода — нет смертности для ${r.by}=${v}`);
        for (const v of Object.keys(r.death)) if (!(v in by)) errors.push(`${owner}: исход перевода — смертность для ${r.by}=${v}, а такого значения нет`);
      }
      for (const [v, [lo, hi]] of Object.entries(r.death)) if (lo > hi) errors.push(`${owner}: исход перевода — у ${r.by}=${v} нижняя граница выше верхней`);
      if (r.loss.some(([h, x], i) => i > 0 && (h <= r.loss[i - 1][0] || x < r.loss[i - 1][1]))) errors.push(`${owner}: исход перевода — часы потери по возрастанию, доля не убывает`);
      if (!(r.lysis.tx in treatments)) errors.push(`${owner}: исход перевода — тромболизис ${r.lysis.tx} не найден`);
      if (!c.course.onset) errors.push(`${owner}: исход перевода по часам, а часов от начала у болезни нет (course.onset)`);
    }
    // фибрилляция желудочков (часть 39б): параметры объявлены, часы от начала известны
    if (c.arrest) {
      checkWhen(owner, 'фибрилляция желудочков', c.arrest.when, c.params);
      if (!c.course.onset) errors.push(`${owner}: фибрилляция желудочков по часам от начала, а их у болезни нет (course.onset)`);
    }
    // только со скорой (часть 41а): скорая такое везёт — у болезни есть тактика и тяжесть, которую возят
    if (c.arrival === 'ambulance' && (c.checkup || !c.treatment || c.severity === 'minor')) errors.push(`${owner}: приходят только со скорой, а скорая такое не везёт (профосмотр, без тактики или лёгкое)`);
    // острый период проходит в стационаре (часть 41а): к сроку стационара, и это не «проходит само»
    if (c.course.settles && !c.course.stay) errors.push(`${owner}: острый период проходит в стационаре, а срока стационара (course.stay) нет`);
    if (c.course.settles && c.course.selfLimiting) errors.push(`${owner}: и «проходит само», и «острый период проходит в стационаре» — что-то одно`);
    // с чем спутать по рекомендации (часть 33б): то, с чем приходят, и не сама болезнь
    for (const d of c.differential ?? []) if (d === c.id || !conditions[d]?.presenting) errors.push(`${owner}: с чем спутать — ${d} не найдено, не приходят с ним или это оно само`);
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
      // ещё места, которые не ошибка (часть 32б): при этих значениях место не то же, что главное
      for (const [i, x] of (t.setting.also ?? []).entries()) {
        const what = `ещё место №${i + 1}`;
        if (Object.keys(x.when).length === 0) errors.push(`${owner}: ${what} — без условия`);
        checkWhen(owner, what, x.when, c.params);
        const main = t.setting.param && Object.keys(x.when).length === 1 && x.when[t.setting.param.name]
          ? x.when[t.setting.param.name].map(v => t.setting.param!.map[v])
          : [];
        for (const s of x.settings) if (main.includes(s)) errors.push(`${owner}: ${what} — ${s} и так место при этих значениях`);
      }
      for (const r of t.setting.risks ?? []) if (!(r.id in risks)) errors.push(`${owner}: место лечения зависит от неизвестного фактора ${r.id}`);
      // место после обследования (часть 40): обследование есть, признаки у болезни бывают, а до
      // обследования место от чего-то зависит — иначе менять нечего
      const after = t.setting.after;
      if (after) {
        for (const id of after.exams) if (!(id in exams)) errors.push(`${owner}: место после ${id} — такого обследования нет`);
        for (const f of after.flags?.any ?? []) if (!c.findings.some(l => l.f === f)) errors.push(`${owner}: место после обследования — по признаку ${f}, а у болезни его нет`);
        if (!t.setting.param && !t.setting.redFlag) errors.push(`${owner}: место после обследования, а до него оно не зависит ни от параметра, ни от красного флага`);
      }
      // без аппаратов у постели (часть 42б): аппараты есть в каталоге, место — выше обычного
      const without = t.setting.without;
      if (without) {
        for (const id of without.equipment) if (!equipment[id]) errors.push(`${owner}: место без аппарата ${id} у постели — такого аппарата нет`);
        if (SETTING_ORDER[without.setting] <= SETTING_ORDER[t.setting.default]) errors.push(`${owner}: место без аппаратов у постели — ${without.setting}, не выше обычного ${t.setting.default}`);
      }
      if (t.setting.default === 'home' && t.firstLine.length === 0) errors.push(`${owner}: лечат дома, а первой линии нет`);
      for (const id of t.plan ?? []) if (![...t.firstLine, ...t.acceptable, ...t.supportive].includes(id)) errors.push(`${owner}: в типичном назначении ${id} — не из первой линии, допустимых или облегчающих`);
      // тактика и действие лечения не спорят: то, что лечит причину, не бывает «не показано»,
      // а то, что само не проходит, первая линия лечит
      const cures = (id: string) => treatments[id]?.effects.some(e => e.on === owner && e.kind === 'cure') === true;
      for (const id of [...t.notIndicated, ...t.harmful]) if (cures(id)) errors.push(`${owner}: ${id} действует на причину, а в тактике — «не показано» или «вредно»`);
      if (c.presenting && !c.course.selfLimiting && t.setting.default === 'home' && !t.firstLine.some(cures)) errors.push(`${owner}: само не проходит, а первая линия не действует на причину`);
      // тактика по скрытому параметру (часть 32): условие по объявленному параметру, лечения есть
      // и не повторяются; типичное назначение — из показанного при этих значениях; что при них
      // действует на причину — не «не показано» и не «вредно»
      for (const [i, x] of (t.byParam ?? []).entries()) {
        const what = `тактика по параметру №${i + 1}`;
        if (Object.keys(x.when).length === 0) errors.push(`${owner}: ${what} — без условия`);
        checkWhen(owner, what, x.when, c.params);
        const own = new Set<string>();
        for (const id of [x.firstLine, x.acceptable, x.supportive, x.notIndicated, x.harmful].flat()) {
          if (!(id in treatments)) errors.push(`${owner}: ${what} — лечение ${id} не найдено`);
          if (own.has(id)) errors.push(`${owner}: ${what} — лечение ${id} стоит в двух списках`);
          own.add(id);
        }
        const shown = (id: string) => [x.firstLine, x.acceptable, x.supportive].some(l => l.includes(id)) || (!own.has(id) && [t.firstLine, t.acceptable, t.supportive].some(l => l.includes(id)));
        for (const id of x.plan ?? []) if (!shown(id)) errors.push(`${owner}: ${what} — в типичном назначении ${id} — не из первой линии, допустимых или облегчающих`);
        for (const id of x.plan ?? []) if (treatments[id]?.kind === 'surgery') errors.push(`${owner}: ${what} — операцию ${id} выбирают «В операционную», а не в назначении`);
        const curesHere = (id: string) => treatments[id]?.effects.some(e => e.on === owner && e.kind === 'cure' && overlaps(e.when, x.when)) === true;
        for (const id of [...x.notIndicated, ...x.harmful]) if (curesHere(id)) errors.push(`${owner}: ${what} — ${id} при этих значениях действует на причину, а стоит «не показано» или «вредно»`);
        // до приезда скорой (часть 32д-2): показанное при этих значениях, не операция, есть в
        // типичном назначении — и только там, где лечат не дома
        if (x.preHospital) {
          for (const id of x.preHospital) {
            if (!(id in treatments)) errors.push(`${owner}: ${what} — до приезда скорой: лечение ${id} не найдено`);
            else if (treatments[id].kind === 'surgery') errors.push(`${owner}: ${what} — до приезда скорой операцию ${id} не сделать`);
            else if (!shown(id)) errors.push(`${owner}: ${what} — до приезда скорой: ${id} не из первой линии, допустимых или облегчающих`);
          }
          const planHere = x.plan ?? t.plan ?? t.firstLine;
          if (!x.preHospital.some(id => planHere.includes(id))) errors.push(`${owner}: ${what} — в типичном назначении нет ничего из того, что делают до приезда скорой`);
          const p = t.setting.param;
          const away = p !== undefined && (x.when[p.name] ?? []).length > 0 && x.when[p.name].every(v => (p.map[v] ?? t.setting.default) !== 'home');
          if (!away && t.setting.default === 'home') errors.push(`${owner}: ${what} — до приезда скорой: при этих значениях лечат дома`);
        }
      }
      // обязательная профилактика (часть 32г-2): лечение есть; роль у него одна — «профилактика»,
      // ни в каком списке тактики его нет, иначе роль при одних значениях спорила бы с другой
      const roled = new Set([...lists.flat(), ...(t.byParam ?? []).flatMap(x => [x.firstLine, x.acceptable, x.supportive, x.notIndicated, x.harmful].flat())]);
      for (const [what, ids] of [['профилактика', t.prevent ?? []], ...(t.byParam ?? []).map((x, i) => [`профилактика тактики по параметру №${i + 1}`, x.prevent ?? []] as const)] as const) {
        for (const id of ids) {
          if (!(id in treatments)) errors.push(`${owner}: ${what} — лечение ${id} не найдено`);
          if (roled.has(id)) errors.push(`${owner}: ${what} — ${id} стоит и в списке тактики`);
        }
        if (new Set(ids).size !== ids.length) errors.push(`${owner}: ${what} — лечение повторяется`);
      }
      // обязательное при лечении здесь (часть 38б): лечение есть и не операция; общее — ни в каком
      // списке тактики, по параметру — не в списках той же записи (при других значениях роль своя:
      // кислород при сатурации от 90 % у ОКС — «не нужно»)
      // обязательное и при переводе (часть 39а) — так же: тромболизис при инфаркте в окне
      // группа «одно из» (часть 39в) — каждое из группы так же
      const requires = [['обязательное', membersOf(t.require), roled] as const, ['обязательное до перевода', membersOf(t.beforeTransfer), roled] as const, ...(t.byParam ?? []).flatMap((x, i) => {
        const own = new Set([x.firstLine, x.acceptable, x.supportive, x.notIndicated, x.harmful].flat());
        return [
          [`обязательное тактики по параметру №${i + 1}`, membersOf(x.require), own] as const,
          [`обязательное до перевода тактики по параметру №${i + 1}`, membersOf(x.beforeTransfer), own] as const,
        ];
      })];
      for (const [what, ids, other] of requires) {
        for (const id of ids) {
          if (!(id in treatments)) errors.push(`${owner}: ${what} — лечение ${id} не найдено`);
          else if (treatments[id].kind === 'surgery') errors.push(`${owner}: ${what} — операцию ${id} выбирают местом, а не назначением`);
          if (other.has(id)) errors.push(`${owner}: ${what} — ${id} стоит и в списке тактики`);
        }
        if (new Set(ids).size !== ids.length) errors.push(`${owner}: ${what} — лечение повторяется`);
      }
    }
    // с чем приходят — узнаётся по нескольким признакам; хроническому фону хватит одного (часть 30)
    if (c.presenting && c.findings.length < 3) errors.push(`${owner}: у болезни, с которой приходят, меньше трёх признаков`);
    // операция (spec 2026-09-chapter-2, часть 28): вида «операция» и действует на причину
    if (c.surgery) {
      const op = treatments[c.surgery.tx];
      if (!op) errors.push(`${owner}: операция ${c.surgery.tx} не найдена`);
      else if (op.kind !== 'surgery') errors.push(`${owner}: ${c.surgery.tx} — не операция (kind: surgery)`);
      else if (!op.effects.some(e => e.on === owner && e.kind === 'cure')) errors.push(`${owner}: операция ${c.surgery.tx} не действует на причину`);
      // осложнённая стадия (часть 28б): у операции — свои доли для неё
      else if (c.complication && !op.surgery?.complicated) errors.push(`${owner}: у болезни есть осложнённая стадия, а у операции ${c.surgery.tx} нет долей для неё (complicated)`);
      // срок после наблюдения в палате (часть 30в) — у того, что лечат и без операции, и дольше экстренного
      const x = c.surgery;
      if (x.observe !== undefined && (x.window === undefined || x.observe <= x.window)) errors.push(`${owner}: срок после наблюдения (observe) должен быть больше срока экстренной операции`);
      if (x.window === undefined && (x.from !== undefined || c.complication)) errors.push(`${owner}: срок от начала болезни и осложнённая стадия — только со сроком операции (window)`);
      if (x.observe !== undefined && x.from === 'onset') errors.push(`${owner}: срок после наблюдения (observe) считается от поступления, а срок операции — от начала болезни`);
      if (x.stay && x.stay[0] > x.stay[1]) errors.push(`${owner}: срок стационара после операции — от большего к меньшему`);
      // операция по скрытому параметру (часть 32б): своя операция, вида «операция», при этих
      // значениях действует на причину
      for (const [i, b] of (x.byParam ?? []).entries()) {
        const what = `операция по параметру №${i + 1}`;
        if (Object.keys(b.when).length === 0) errors.push(`${owner}: ${what} — без условия`);
        checkWhen(owner, what, b.when, c.params);
        const alt = treatments[b.tx];
        if (!alt) errors.push(`${owner}: ${what} — операция ${b.tx} не найдена`);
        else if (alt.kind !== 'surgery') errors.push(`${owner}: ${what} — ${b.tx} не операция (kind: surgery)`);
        else if (!alt.effects.some(e => e.on === owner && e.kind === 'cure' && overlaps(e.when, b.when))) errors.push(`${owner}: ${what} — ${b.tx} при этих значениях не действует на причину`);
        else if (c.complication && !alt.surgery?.complicated) errors.push(`${owner}: ${what} — у болезни есть осложнённая стадия, а у операции ${b.tx} нет долей для неё (complicated)`);
        if (b.tx === x.tx) errors.push(`${owner}: ${what} — та же операция, что и без условия`);
      }
    }
    if (c.complication) {
      const x = c.complication;
      if ((x.early && prob(x.early.p) >= 10000) || (x.later && prob(x.later.p) >= 10000)) errors.push(`${owner}: доля осложнённой стадии за отрезок должна быть меньше 100 %`);
      if (x.stay && x.stay[0] > x.stay[1]) errors.push(`${owner}: срок стационара в осложнённой стадии — от большего к меньшему`);
      checkWhen(owner, 'осложнённая стадия', x.when, c.params);
    }
    if (!c.course.selfLimiting && c.presenting && !c.course.untreated) warnings.push(`${owner}: не проходит само, но не сказано, что будет без лечения`);
    // течение по скрытому параметру (часть 30д): параметр объявлен, значения — из его списка
    if (typeof c.course.selfLimiting === 'object') checkWhen(owner, 'проходит само', c.course.selfLimiting.when, c.params);
    // списком (часть 41б): у каждой записи — свои значения параметров; другая болезнь — из базы, с
    // ней приходят, и это не сама болезнь
    const untreated = untreatedList(c.course.untreated);
    for (const u of untreated) {
      checkWhen(owner, 'без лечения', u.when, c.params);
      if (u.as !== undefined && (u.as === c.id || !conditions[u.as]?.presenting)) errors.push(`${owner}: без лечения возвращаются с ${u.as}, а такой болезни нет, с ней не приходят или это она сама`);
    }
    if (untreated.length > 1 && untreated.slice(0, -1).some(u => !u.when)) errors.push(`${owner}: в списке «без лечения» запись без условия — только последняя`);
  }
  for (const t of Object.values(treatments)) {
    for (const e of t.effects) {
      if (!(e.on in conditions)) errors.push(`${t.id}: действует на неизвестное состояние ${e.on}`);
      else checkWhen(t.id, `действие на ${e.on}`, e.when, conditions[e.on].params);
      // вред при болезни (часть 41в): в её тактике это лечение — «вредно», иначе разбор и течение спорят
      const x = conditions[e.on]?.treatment;
      if (e.kind === 'harm' && x && !x.harmful.includes(t.id) && !(x.byParam ?? []).some(b => b.harmful.includes(t.id))) {
        errors.push(`${t.id}: вредит при ${e.on}, а в её тактике оно не «вредно»`);
      }
      // вред — другая болезнь (часть 42а): с ней возвращаются, как без лечения с `untreated.as`
      if (e.as !== undefined && (e.kind !== 'harm' || e.as === e.on || !conditions[e.as]?.presenting)) {
        errors.push(`${t.id}: при ${e.on} вредит болезнью ${e.as}, а это не вред, такой болезни нет, с ней не приходят или это она сама`);
      }
    }
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
        else if (!equipment[id].rooms.includes(t.surgery.room)) errors.push(`${t.id}: аппарат ${id} стоит в ${equipment[id].rooms.join(', ')}, а операция — в ${t.surgery.room}`);
      }
      if (room && room.sizes.some(z => z.slots.length < t.surgery!.equipment.length)) errors.push(`${t.id}: в ${t.surgery.room} не у всех размеров хватит мест под аппараты операции`);
    }
    for (const k of t.contraindications) if (!(k.id in risks) && !(k.id in conditions)) errors.push(`${t.id}: противопоказание ${k.id} не найдено`);
    // у постели (часть 39а): аппараты есть в каталоге больницы
    for (const id of t.bedside?.equipment ?? []) if (!equipment[id]) errors.push(`${t.id}: аппарат у постели ${id} не найден`);
    // спутники (часть 39а): есть, не операции, не само лечение и без повторов
    const companions = (t.companions ?? []).flat();
    for (const id of companions) {
      if (!(id in treatments)) errors.push(`${t.id}: спутник ${id} не найден`);
      else if (id === t.id || treatments[id].kind === 'surgery') errors.push(`${t.id}: спутник ${id} — само лечение или операция`);
    }
    if (new Set(companions).size !== companions.length) errors.push(`${t.id}: спутники повторяются`);
    // спутники при болезнях (часть 42б): спутники есть, болезни есть и не повторяются, лечение при них действует —
    // с частью 43а и облегчением: нитроглицерин в вену при расслоении аорты снижает давление, а причину не лечит
    if (t.companionsFor) {
      if (companions.length === 0) errors.push(`${t.id}: спутники нужны при ${t.companionsFor.join(', ')}, а спутников нет`);
      if (new Set(t.companionsFor).size !== t.companionsFor.length) errors.push(`${t.id}: болезни спутников повторяются`);
      for (const id of t.companionsFor) {
        if (!(id in conditions)) errors.push(`${t.id}: спутники при ${id} — такой болезни нет`);
        else if (!t.effects.some(e => e.on === id && e.kind !== 'harm')) errors.push(`${t.id}: спутники при ${id}, а при ней лечение не действует`);
      }
    }
  }
  for (const r of Object.values(risks)) checkLinks(r.id, r.findings);
  const revealedBy: Record<string, string[]> = {};
  for (const e of Object.values(exams)) {
    for (const [i, ch] of e.checks.entries()) {
      if (!hasF(ch.f)) errors.push(`${e.id}: проверяемый признак ${ch.f} не найден`);
      (revealedBy[ch.f] ??= []).push(e.id);
      // уточнение (часть 41в): признак, после которого проверяют, — раньше в этом же обследовании и
      // без своего уточнения: иначе неясно, что было показано
      if (ch.given !== undefined) {
        const j = e.checks.findIndex(c => c.f === ch.given);
        if (j < 0 || j >= i) errors.push(`${e.id}: ${ch.f} уточняет ${ch.given}, а его это обследование не проверяет раньше`);
        else if (e.checks[j].given !== undefined) errors.push(`${e.id}: ${ch.f} уточняет ${ch.given}, а тот сам — уточнение`);
      }
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
  // порог на чужом измерении (часть 33б): то измерение — число, само не порог, в тех же единицах и с
  // той же точностью; диапазон «есть» — вне его диапазонов; в обследовании — только вместе с ним, и
  // точность выведена из его измерения: чувствительность — его специфичность, специфичность — 100
  for (const f of Object.values(findings)) {
    const of = f.value?.of;
    if (f.value?.implies && !of) errors.push(`${f.id}: «не снимает» — только у порога на чужом измерении`);
    if (!of) continue;
    const base = findings[of]?.value;
    if (!base) { errors.push(`${f.id}: измерение ${of} не найдено или без числа`); continue; }
    if (base.of) errors.push(`${f.id}: ${of} — сам порог на чужом измерении`);
    if (base.unit !== f.value!.unit || base.decimals !== f.value!.decimals) errors.push(`${f.id}: единица и точность числа — не те, что у ${of}`);
    const [lo, hi] = f.value!.present;
    if ([base.present, base.absent].some(([a, b]) => lo <= b && a <= hi)) errors.push(`${f.id}: диапазон «есть» пересекается с диапазонами ${of}`);
    // не снимает того (часть 42б): «есть» — дальше от нормы по ту же сторону, и у болезни с ним есть и то
    // измерение — пульс 150 и чаще бывает только с «чаще 100», иначе вывод не узнает в частом пульсе её
    if (f.value!.implies) {
      if (!beyond(f.value!, base)) errors.push(`${f.id}: не снимает ${of}, а «есть» — не дальше от нормы по ту же сторону`);
      for (const c of Object.values(conditions)) {
        if (c.findings.some(l => l.f === f.id) && !c.findings.some(l => l.f === of)) errors.push(`${c.id}: признак ${f.id} не снимает ${of}, а его у болезни нет`);
      }
    }
    for (const e of Object.values(exams)) {
      const mine = e.checks.find(c => c.f === f.id);
      if (!mine) continue;
      const theirs = e.checks.find(c => c.f === of);
      if (!theirs) errors.push(`${e.id}: ${f.id} — только вместе с ${of}: число одно`);
      else if (mine.sens !== theirs.spec || mine.spec !== 100) errors.push(`${e.id}: у ${f.id} точность — из измерения ${of}: чувствительность ${theirs.spec}, специфичность 100`);
    }
  }
  // атрибут для старых записей (часть 39а): у признака такой атрибут есть, и значение в нём описано
  for (const f of Object.values(findings)) for (const [attr, v] of Object.entries(f.fallback ?? {})) {
    if (!f.attrs?.[attr]?.[v]) errors.push(`${f.id}: для старых записей ${attr}=${v}, а в атрибутах признака такого нет`);
  }
  // признак-последователь (часть 39а): ведущие есть; с частью 43б — и цепочкой (одышка — за внезапной одышкой,
  // время начала — за одышкой), но не по кругу: сам за собой признак не следует ни прямо, ни через других
  for (const f of Object.values(findings)) for (const id of f.follows ?? []) if (!findings[id]) errors.push(`${f.id}: следует за признаком ${id}, а его нет`);
  const leadsTo = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (findings[from]?.follows ?? []).some(id => leadsTo(id, to, seen));
  };
  for (const f of Object.values(findings)) for (const id of f.follows ?? []) {
    if (id === f.id) errors.push(`${f.id}: следует сам за собой`);
    else if (leadsTo(id, f.id)) errors.push(`${f.id}: следует сам за собой — через ${id}`);
  }
  // обследование только при жалобе (часть 32г): жалоба — признак с текстом жалобы
  for (const x of Object.values(exams)) for (const f of x.complaints ?? []) if (!findings[f]?.texts.complaint) errors.push(`${x.id}: жалоба ${f} не найдена или без текста жалобы`);
  // каждому с жалобой (часть 32г-2): жалоба есть, и обследование ей предлагается
  for (const x of Object.values(exams)) for (const f of x.routineFor ?? []) {
    if (!findings[f]?.texts.complaint) errors.push(`${x.id}: жалоба ${f} для обязательного обследования не найдена или без текста жалобы`);
    if (x.complaints && !x.complaints.includes(f)) errors.push(`${x.id}: обязательно при жалобе ${f}, а при ней не предлагается`);
  }
  // каждому, у кого увидели (часть 42б): признак есть, и его открывает другое обследование (у жалоб —
  // `routineFor`)
  for (const x of Object.values(exams)) for (const f of x.routineSeen ?? []) {
    if (!findings[f]) errors.push(`${x.id}: обязательно, если видно ${f}, а такого признака нет`);
    else if (x.checks.some(c => c.f === f)) errors.push(`${x.id}: обязательно, если видно ${f}, а его открывает само это обследование`);
    else if (!Object.values(exams).some(e => e.checks.some(c => c.f === f))) errors.push(`${x.id}: обязательно, если видно ${f}, а его не открывает ни одно обследование`);
  }
  // правила решения (часть 32): жалобы — признаки с жалобой, признаки и обследования есть, и
  // обследование правила открывает хоть один признак болезней, о которых оно
  for (const x of Object.values(rules)) {
    for (const f of x.complaints) if (!findings[f]?.texts.complaint) errors.push(`${x.id}: жалоба ${f} не найдена или без текста жалобы`);
    for (const f of x.any) if (!hasF(f)) errors.push(`${x.id}: признак ${f} не найден`);
    // часть 41б: у правила есть основные признаки или баллы; пункты шкалы — признаки базы, каждый
    // один раз, «не считается при» — другие её пункты; порог можно набрать, возраст — пунктом шкалы
    if (x.any.length === 0 && !x.points) errors.push(`${x.id}: у правила нет ни основных признаков, ни баллов`);
    if (x.points) {
      const items = x.points.items.map(i => i.f);
      for (const f of items) if (!hasF(f)) errors.push(`${x.id}: пункт ${f} не найден`);
      if (new Set(items).size !== items.length) errors.push(`${x.id}: пункт шкалы повторяется`);
      for (const i of x.points.items) for (const u of i.unless ?? []) if (u === i.f || !items.includes(u)) errors.push(`${x.id}: пункт ${i.f} не считается при ${u}, а это не другой пункт шкалы`);
      for (const f of items) if (x.any.includes(f) || (x.requires ?? []).includes(f) || (x.excludes ?? []).includes(f)) errors.push(`${x.id}: ${f} — и пункт шкалы, и признак правила`);
      if (x.points.from > pointsMax(x.points)) errors.push(`${x.id}: порог ${x.points.from} больше, чем можно набрать (${pointsMax(x.points)})`);
      // часть 42а: полосы возраста — по возрастанию; порог у пола можно набрать этим полом
      const bands = x.points.age ?? [];
      if (bands.some((a, i) => i > 0 && a.from <= bands[i - 1].from)) errors.push(`${x.id}: полосы возраста шкалы — не по возрастанию`);
      for (const [sex, n] of Object.entries(x.points.fromSex ?? {}) as ['m' | 'f', number][]) {
        if (n > pointsMax(x.points, sex)) errors.push(`${x.id}: порог ${n} для пола ${sex} больше, чем можно набрать (${pointsMax(x.points, sex)})`);
      }
      if (x.minor) errors.push(`${x.id}: у шкалы с баллами дополнительные признаки — её пункты`);
      if (x.age) errors.push(`${x.id}: у шкалы с баллами возраст — её пункт (points.age)`);
    }
    // часть 32г: дополнительные признаки, возраст и круг применимости
    for (const f of [...(x.minor?.any ?? []), ...(x.requires ?? []), ...(x.excludes ?? [])]) if (!hasF(f)) errors.push(`${x.id}: признак ${f} не найден`);
    // часть 33а: признак, при котором правило не применяют, не может его же и выполнять
    for (const f of x.excludes ?? []) if (x.any.includes(f) || (x.minor?.any ?? []).includes(f) || (x.requires ?? []).includes(f)) errors.push(`${x.id}: ${f} — и в правиле, и среди признаков, при которых его не применяют`);
    for (const f of x.minor?.any ?? []) if (x.any.includes(f)) errors.push(`${x.id}: ${f} — и основной, и дополнительный признак`);
    // часть 39а: «только применимым» — без круга применимости ждать нечего
    if (x.onlyIfApplies && !x.requires) errors.push(`${x.id}: пункты проверяют только применимым, а круга применимости (requires) нет`);
    if (x.minor && x.minor.count > x.minor.any.length + (x.age?.minor ? 1 : 0)) errors.push(`${x.id}: дополнительных признаков меньше, чем их нужно (${x.minor.count})`);
    if (x.age?.minor && !(x.age.minor[0] < x.age.minor[1])) errors.push(`${x.id}: возраст дополнительного признака — от меньшего к большему`);
    if (x.age?.minor && !x.minor) errors.push(`${x.id}: возраст как дополнительный признак без дополнительных признаков`);
    if (x.age?.main !== undefined && x.age.minor && x.age.main < x.age.minor[1]) errors.push(`${x.id}: основной возраст (старше ${x.age.main}) пересекается с дополнительным`);
    // часть 32д: «55 лет и старше» — `from`; «старше 60» — `main`; вместе — нет
    if (x.age?.main !== undefined && x.age.from !== undefined) errors.push(`${x.id}: возраст — либо «старше» (main), либо «и старше» (from)`);
    if (x.age?.from !== undefined && x.age.minor && x.age.from <= x.age.minor[1]) errors.push(`${x.id}: основной возраст (${x.age.from} и старше) пересекается с дополнительным`);
    if ((x.requires || x.excludes) && !x.texts.na) errors.push(`${x.id}: у правила с кругом применимости нужен текст «не применяется» (texts.na)`);
    if (!x.requires && !x.excludes && x.texts.na) errors.push(`${x.id}: текст «не применяется» без круга применимости (requires или excludes)`);
    if (x.exams.length === 0 && !x.texts.exam && !x.decides && !x.place) errors.push(`${x.id}: обследования правила в игре нет — нужен текст о нём (texts.exam)`);
    // правило о месте (часть 43б) — без обследования и лечения; место решает производный параметр болезни
    if (x.place && (x.exams.length > 0 || x.texts.exam || x.decides)) errors.push(`${x.id}: правило о месте лечения — без обследования и лечения`);
    if (x.place && !Object.values(conditions).some(c => Object.values(c.derived ?? {}).some(d => (typeof d === 'string' ? d : 'rule' in d ? d.rule : undefined) === x.id))) errors.push(`${x.id}: правило о месте лечения, а производного параметра по нему нет ни у одной болезни`);
    // правило о лечении (часть 39а): лечение есть, обследования и текста о нём нет
    if (x.decides && !(x.decides in treatments)) errors.push(`${x.id}: лечение ${x.decides} не найдено`);
    if (x.decides && (x.exams.length > 0 || x.texts.exam)) errors.push(`${x.id}: правило о лечении ${x.decides} — без обследования`);
    if (x.exams.length > 0 && x.texts.exam) errors.push(`${x.id}: текст об обследовании (texts.exam) — только если его в игре нет`);
    for (const id of x.about) if (!conditions[id]?.presenting) errors.push(`${x.id}: болезнь ${id} не найдена или с ней не приходят`);
    for (const id of x.exams) {
      if (!exams[id]) { errors.push(`${x.id}: обследование ${id} не найдено`); continue; }
      const about = new Set(x.about.flatMap(c => conditions[c]?.findings.map(l => l.f) ?? []));
      // или ищет то, чего ни у одной болезни базы нет (часть 40): КТ при травме головы исключает
      // кровь внутри черепа, а при сотрясении изменений на КТ не бывает. С частью 41в кровь на КТ — у
      // кровоизлияний в мозг, а у болезней правила её не бывает по записи (masks)
      const anywhere = (f: string) => Object.values(conditions).some(c => c.findings.some(l => l.f === f));
      const masked = new Set(x.about.flatMap(c => conditions[c]?.masks ?? []));
      if (!exams[id].checks.some(ch => about.has(ch.f) || masked.has(ch.f) || !anywhere(ch.f))) errors.push(`${x.id}: ${id} не проверяет ни одного признака ${x.about.join(', ')}`);
    }
  }
  // сроки (spec 2026-10-chapter-3, часть 37): жалоба — признак с жалобой, обследования есть; срок у
  // лежащих — в смотровой приёмного, и хоть одно из обследований там делают у постели не дольше срока
  for (const x of Object.values(targets)) {
    for (const f of x.complaints) if (!findings[f]?.texts.complaint) errors.push(`${x.id}: жалоба ${f} не найдена или без текста жалобы`);
    // часть 39б: находка, назначение — из базы
    for (const f of x.findings) if (!findings[f]) errors.push(`${x.id}: находка ${f} не найдена`);
    for (const id of x.treatments) if (!treatments[id]) errors.push(`${x.id}: лечение ${id} не найдено`);
    for (const id of x.exams) if (!exams[id]) errors.push(`${x.id}: обследование ${id} не найдено`);
    if (x.room && !rooms[x.room]) errors.push(`${x.id}: помещение ${x.room} не найдено`);
    else if (x.room && !rooms[x.room].emergency) errors.push(`${x.id}: срок у лежащих — только в смотровой приёмного, а ${x.room} не она`);
    else if (x.room && x.exams.length > 0 && !x.exams.some(id => exams[id]?.bedside?.room === x.room && exams[id].bedside!.time.procedure <= x.minutes)) {
      errors.push(`${x.id}: в ${x.room} ни одно из обследований срока не делают у постели за ${x.minutes} минут`);
    }
  }
  checkWho({ conditions, findings, exams, risks }, errors);
  checkHospital({ rooms, equipment, roles, exams, conditions, treatments }, errors);

  // --- сборка ---
  const rects = (list: [number, number, number, number][]): Cell[] =>
    list.flatMap(([x0, y0, x1, y1]) => Array.from({ length: (y1 - y0 + 1) * (x1 - x0 + 1) }, (_, i) => [x0 + (i % (x1 - x0 + 1)), y0 + Math.floor(i / (x1 - x0 + 1))] as Cell));
  const db: ContentDb = {
    contentVersion, hash: '', conditions: {}, findings: {}, exams: {}, risks: {}, treatments: {}, rooms: {}, equipment: {}, roles: {}, presets: {},
    characters: Object.fromEntries(Object.values(characters).sort((a, b) => (a.id < b.id ? -1 : 1)).map(c => [c.id, c])),
    // заданный пациент строкой — пришедший сам с этой болезнью
    chapters: Object.fromEntries(Object.values(chapters).sort((a, b) => a.order - b.order).map(c => [c.id, { ...c, tutorial: c.tutorial.map(t => (typeof t === 'string' ? { condition: t } : t)) }])),
    tips: Object.fromEntries(Object.values(tips).sort((a, b) => a.order - b.order).map(t => [t.id, t])),
    achievements: Object.fromEntries(Object.values(achievements).sort((a, b) => a.order - b.order).map(a => [a.id, a])),
    scores: Object.fromEntries(Object.values(scores).sort((a, b) => (a.id < b.id ? -1 : 1)).map(x => [x.id, x])),
    rules: Object.fromEntries(Object.values(rules).sort((a, b) => (a.id < b.id ? -1 : 1)).map(x => [x.id, x])),
    targets: Object.fromEntries(Object.values(targets).sort((a, b) => (a.id < b.id ? -1 : 1)).map(x => [x.id, x])),
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
    if (c.arrival) out.arrival = c.arrival;
    if (c.group) out.group = c.group;
    if (c.system) out.system = c.system;
    if (e.sex) out.sex = e.sex;
    if (e.season) out.season = e.season;
    if (e.risks) out.risks = e.risks;
    if (e.requires) out.requires = e.requires;
    if (e.excludes) out.excludes = e.excludes;
    if (e.chronic) out.chronic = { p: prob(e.chronic.band), ...(e.chronic.ageMin ? { ageMin: e.chronic.ageMin } : {}), ...(e.chronic.risks ? { risks: e.chronic.risks } : {}) };
    if (c.params) out.params = c.params;
    if (c.derived) out.derived = c.derived;
    if (c.course.presentation) out.presentation = c.course.presentation;
    if (c.course.onset) out.onset = c.course.onset;
    if (c.redFlags) out.redFlags = c.redFlags;
    if (c.masks) out.masks = c.masks;
    if (c.reperfusion) {
      const r = c.reperfusion;
      out.reperfusion = {
        when: r.when, by: r.by, loss: r.loss,
        death: Object.fromEntries(Object.entries(r.death).map(([v, [lo, hi]]) => [v, [Math.round(lo * 100), Math.round(hi * 100)]])),
        lysis: { tx: r.lysis.tx, p: Math.round(r.lysis.pct * 100), hours: r.lysis.hours },
      };
    }
    if (c.arrest) out.arrest = { when: c.arrest.when, perHour: Math.round(c.arrest.perHour * 100), hours: c.arrest.hours };
    if (c.differential) out.differential = c.differential;
    if (c.course.selfLimiting) {
      out.selfLimiting = true;
      if (typeof c.course.selfLimiting === 'object') out.selfLimitingWhen = c.course.selfLimiting.when;
    }
    if (c.course.untreated) {
      out.untreated = untreatedList(c.course.untreated).map(u => ({ p: prob(u.band), days: u.days, ...(u.when ? { when: u.when } : {}), ...(u.as ? { as: u.as } : {}) }));
    }
    if (c.course.stay) out.stay = c.course.stay;
    if (c.course.settles) out.settles = true;
    if (c.surgery) {
      const x = c.surgery;
      out.surgery = {
        tx: x.tx,
        ...(x.byParam ? { byParam: x.byParam } : {}),
        ...(x.window !== undefined ? { window: x.window } : {}),
        ...(x.from === 'onset' ? { from: 'onset' as const } : {}),
        ...(x.observe !== undefined ? { observe: x.observe } : {}),
        ...(x.stay ? { stay: x.stay } : {}),
      };
    }
    if (c.complication) {
      const x = c.complication;
      out.complication = {
        name: x.name,
        ...(x.early ? { early: { hours: x.early.hours, p: prob(x.early.p) } } : {}),
        ...(x.later ? { later: { every: x.later.every, p: prob(x.later.p) } } : {}),
        ...(x.after !== undefined ? { after: x.after } : {}),
        ...(x.when ? { when: x.when } : {}),
        ...(x.stay ? { stay: x.stay } : {}),
      };
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
    if (f.fallback) out.fallback = f.fallback;
    if (f.follows) out.follows = f.follows;
    if (f.evidence === false) out.evidence = false;
    if (f.value) out.value = f.value;
    db.findings[f.id] = out;
  }
  for (const e of Object.values(exams).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const out: Exam = {
      id: e.id, name: e.name, kind: e.kind, time: e.time, cost: e.cost, discomfort: e.discomfort,
      checks: e.checks.map(c => ({ f: c.f, sens: Math.round(c.sens * 100), spec: Math.round(c.spec * 100), ...(c.given ? { given: c.given } : {}) })),
      texts: e.texts, sources: e.sources, review: e.review,
    };
    if (e.room) out.room = e.room;
    if (e.equipment) out.equipment = e.equipment;
    if (e.collect) out.collect = e.collect;
    if (e.radiation) out.radiation = e.radiation;
    if (e.routine) out.routine = true;
    if (e.routineFor) out.routineFor = e.routineFor;
    if (e.routineSeen) out.routineSeen = e.routineSeen;
    if (e.bedside) out.bedside = e.bedside;
    if (e.repeat) out.repeat = e.repeat;
    if (e.sex) out.sex = e.sex;
    if (e.ageMin !== undefined) out.ageMin = e.ageMin;
    if (e.ageMax !== undefined) out.ageMax = e.ageMax;
    if (e.complaints) out.complaints = e.complaints;
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
      effects: t.effects.map(e => ({ on: e.on, kind: e.kind, p: prob(e.band), days: e.days, ...(e.when ? { when: e.when } : {}), ...(e.as ? { as: e.as } : {}) })),
      contraindications: t.contraindications.map(k => ({ id: k.id, level: k.level, reaction: prob(k.reaction) })),
      texts: t.texts, sources: t.sources, review: t.review,
    };
    if (t.class) out.class = t.class;
    if (t.route) out.route = t.route;
    if (t.bedside) out.bedside = t.bedside;
    if (t.companions) out.companions = t.companions;
    if (t.companionsFor) out.companionsFor = t.companionsFor;
    if (t.surgery) {
      const x = t.surgery;
      out.surgery = {
        room: x.room, team: x.team, equipment: x.equipment, minutes: x.minutes, complications: prob(x.complications),
        ...(x.death ? { death: prob(x.death) } : {}),
        ...(x.complicated ? { complicated: { complications: prob(x.complicated.complications), ...(x.complicated.death ? { death: prob(x.complicated.death) } : {}) } } : {}),
        ...(x.delay ? { delay: prob(x.delay) } : {}),
      };
    }
    db.treatments[t.id] = out;
  }
  const sortedIds = (xs: string[]) => [...xs].sort();
  const examIds = Object.keys(exams).sort();
  for (const r of Object.values(rooms).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const out: RoomType = {
      id: r.id, name: r.name, gen: r.gen, staff: r.staff, needsEquipment: r.needsEquipment, seats: r.seats, beds: r.beds, emergency: r.emergency, icu: r.icu,
      ...(r.admits ? { admits: r.admits } : {}),
      sizes: r.sizes.map(z => ({
        id: z.id, w: z.w, h: z.h, cost: z.cost, upkeep: z.upkeep, door: { x: z.door.x, width: z.door.width },
        objects: z.objects.map(([kind, x, y]) => ({ kind, x, y })), slots: z.slots, staff: z.staff,
        ...(z.patient ? { patient: z.patient } : {}),
        seats: r.seats ? z.objects.filter(([kind]) => kind === 'chair').length : 0,
        beds: r.beds || r.emergency || r.icu ? z.objects.filter(([kind]) => kind === 'bed').length : 0,
        places: z.places,
      })),
      equipment: sortedIds(Object.values(equipment).filter(e => e.rooms.includes(r.id)).map(e => e.id)),
      exams: examIds.filter(id => exams[id].room === r.id),
      collects: examIds.filter(id => exams[id].collect === r.id),
      texts: r.texts,
    };
    db.rooms[r.id] = out;
  }
  for (const e of Object.values(equipment).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const out: Equipment = {
      id: e.id, name: e.name, gen: e.gen, rooms: e.rooms, sprite: e.sprite, price: e.price, upkeep: e.upkeep,
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
      const departments = new Set([...conditions.map(x => x.department), ...Object.values(db.chapters).map(ch => ch.department), ...Object.values(db.rooms).flatMap(r => r.admits ?? [])]);
      for (const d of departments) {
        const carried = conditions.some(x => x.department === d && x.presenting && !x.checkup && x.treatment && x.weight > 0 && db.economy.ambulance.weight[x.severity] > 0);
        if (!carried) errors.push(`${d}: скорой некого везти — нет болезни отделения с тяжестью, которую везут (hospital/economy.yaml, ambulance.weight)`);
      }
    }
    // помещение принимает отделение (часть 30): у отделения есть с чем прийти
    for (const r of Object.values(db.rooms)) {
      for (const d of r.admits ?? []) if (!Object.values(db.conditions).some(x => x.presenting && x.department === d)) errors.push(`${r.id}: принимает ${d}, а болезней этого отделения в базе нет`);
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
    // заданные пациенты — из отделений больницы главы: своё и то, что принимают её помещения
    // (смотровая приёмного — хирургию и травму); скорая — если есть смотровая; параметры — из записи
    const preset = db.presets[c.preset];
    const departments = [c.department, ...new Set((preset?.rooms ?? []).flatMap(r => db.rooms[r.type]?.admits ?? []))];
    const emergency = (preset?.rooms ?? []).some(r => db.rooms[r.type]?.emergency);
    for (const t of c.tutorial) {
      const cond = db.conditions[t.condition];
      if (!cond) at(`болезнь обучения ${t.condition} не найдена`);
      else if (!cond.presenting || !departments.includes(cond.department)) at(`болезнь обучения ${t.condition} — не из приёма отделения ${departments.join(', ')}`);
      if (t.ambulance && !emergency) at(`болезнь обучения ${t.condition}: скорая, а смотровой приёмного в больнице главы нет`);
      for (const [name, value] of Object.entries(t.params ?? {})) {
        if (cond && cond.params?.[name]?.[value] === undefined) at(`болезнь обучения ${t.condition}: параметра ${name} со значением ${value} у болезни нет`);
      }
      // возраст — внутри возраста болезни
      const age = cond?.age;
      if (t.age && (t.age[0] > t.age[1] || (age && (t.age[1] < age.min || (age.max !== undefined && t.age[0] > age.max))))) {
        at(`болезнь обучения ${t.condition}: возраст ${t.age.join('–')} — мимо возраста болезни`);
      }
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
    if (t.chapter && !db.chapters[t.chapter]) at(`глава ${t.chapter} не найдена`);
    // подсказка о скорой и об обходе — в главе, где они есть
    if ((t.when === 'ambulance' || t.when === 'rounds') && !t.chapter) at(`подсказка «${t.when}» — только с главой (chapter)`);
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
      else if (!equipment[id].rooms.includes(e.room!)) errors.push(`${e.id}: аппарат ${id} стоит в ${equipment[id].rooms.join(', ')}, а обследование — в ${e.room}`);
    }
    if (e.room && rooms[e.room]?.needsEquipment && !e.equipment) errors.push(`${e.id}: в ${e.room} без аппарата не работают — укажите equipment`);
    // у постели (часть 37): в смотровой приёмного, аппаратом, который там стоит
    if (e.bedside) {
      const b = e.bedside;
      if (!rooms[b.room]) errors.push(`${e.id}: у постели — в ${b.room}, а такого помещения нет`);
      else if (!rooms[b.room].emergency) errors.push(`${e.id}: у постели — только в смотровой приёмного, а ${b.room} не она`);
      for (const id of b.equipment) {
        if (!equipment[id]) errors.push(`${e.id}: аппарат у постели ${id} не найден`);
        else if (!equipment[id].rooms.includes(b.room)) errors.push(`${e.id}: аппарат у постели ${id} стоит в ${equipment[id].rooms.join(', ')}, а не в ${b.room}`);
      }
      if (e.kind !== 'functional' && e.kind !== 'imaging') errors.push(`${e.id}: у постели — то, что иначе делают в своём кабинете в очереди (функциональное или снимок)`);
    }
    // повторный забор (часть 39в): у анализа, его проверки — из проверок обследования, и не все:
    // первый забор что-то показывает сам
    if (e.repeat) {
      const own = new Set(e.checks.map(c => c.f));
      if (e.kind !== 'lab') errors.push(`${e.id}: повторный забор — у анализа (kind: lab)`);
      for (const f of e.repeat.checks) if (!own.has(f)) errors.push(`${e.id}: повторный забор проверяет ${f}, а обследование — нет`);
      if (e.repeat.checks.length >= own.size) errors.push(`${e.id}: повторный забор проверяет всё — первому нечего показать`);
    }
  }
  // пациент приходит туда, где берут материал, и туда, где обследование делают с ним самим
  const visited = new Set(exList.flatMap(e => (e.collect ? [e.collect] : e.room ? [e.room] : [])));
  for (const r of Object.values(rooms)) {
    for (const role of r.staff) if (!roles[role]) errors.push(`${r.id}: должность ${role} не найдена`);
    if ((r.needsEquipment || r.icu) && !Object.values(equipment).some(e => e.rooms.includes(r.id))) errors.push(`${r.id}: без аппарата не работает, а аппаратов для него в каталоге нет`);
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
      // в смотровой приёмного пациент лежит на койке: кровь на тропонин берут у постели (часть 39в)
      else if (visited.has(r.id) && !r.emergency) errors.push(`${at}: сюда приходят пациенты, а места для пациента нет`);
      if (r.seats && !z.objects.some(([kind]) => kind === 'chair')) errors.push(`${at}: зона ожидания без стульев`);
      if (r.beds && !z.objects.some(([kind]) => kind === 'bed')) errors.push(`${at}: палата без коек`);
      if (r.emergency && !z.objects.some(([kind]) => kind === 'bed')) errors.push(`${at}: смотровая приёмного без мест для скорой`);
      if (r.beds && r.emergency) errors.push(`${at}: помещение — или палата, или смотровая приёмного`);
      // палата интенсивной терапии (часть 38а): койка работает с монитором на своём месте — мест
      // под аппараты не меньше, чем коек
      if (r.icu && (r.beds || r.emergency)) errors.push(`${at}: палата интенсивной терапии — не палата и не смотровая приёмного`);
      const beds = z.objects.filter(([kind]) => kind === 'bed').length;
      if (r.icu && beds === 0) errors.push(`${at}: палата интенсивной терапии без коек`);
      if (r.icu && z.slots.length < beds) errors.push(`${at}: коек ${beds}, а мест под мониторы — ${z.slots.length}`);
    }
  }
  for (const e of Object.values(equipment)) {
    if (new Set(e.rooms).size < e.rooms.length) errors.push(`${e.id}: помещение повторяется`);
    for (const room of e.rooms) {
      if (!rooms[room]) errors.push(`${e.id}: помещение ${room} не найдено`);
      else if (rooms[room].sizes.some(z => z.slots.length === 0)) errors.push(`${e.id}: в ${room} не у всех размеров есть место под аппарат`);
      if (e.slot !== undefined && rooms[room]?.sizes.some(z => e.slot! >= z.slots.length)) errors.push(`${e.id}: места ${e.slot} под аппарат нет у всех размеров ${room}`);
    }
    if (e.upgradeOf && !e.rooms.every(room => equipment[e.upgradeOf!]?.rooms.includes(room))) errors.push(`${e.id}: улучшает ${e.upgradeOf} — такого аппарата в том же помещении нет`);
    // палата интенсивной терапии (часть 38а) работает от монитора: у её аппаратов место — по койке
    if (e.slot !== undefined && e.rooms.some(room => rooms[room]?.icu)) errors.push(`${e.id}: в палате интенсивной терапии аппарат встаёт к своей койке — своего места у него нет`);
    // аппаратом делают обследование или операцию (операционный стол, наркозный аппарат — часть 28)
    const used = exList.some(x => x.equipment?.includes(e.id) || x.bedside?.equipment.includes(e.id)) || Object.values(c.treatments).some(t => t.surgery?.equipment.includes(e.id));
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
