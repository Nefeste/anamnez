// Сборка медицинской базы из YAML в память: схема, ссылки, полосы → числа
// (`docs/05-content.md` §6, `docs/07-data-model.md` §1). Используют build.ts, тесты и
// «виртуальный врач» — все читают одну и ту же базу.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { parse } from 'yaml';
import type { z } from 'zod';
import type { AttrSpec, Condition, ContentDb, Exam, Finding, Link, Risk, Treatment } from '../../src/content/types';
import { fingerprint } from '../../src/engine/core/hash';
import { BANDS, type ConditionSrc, conditionSchema, type ExamSrc, examSchema, type FindingSrc, findingSchema, type LinkSrc, PREVALENCE, type ProbabilitySrc, type RiskSrc, riskSchema, type TreatmentSrc, treatmentSchema, versionSchema } from './schema';

export const CONTENT_DIR = join(import.meta.dir, '../../content');

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
  let contentVersion = 0;

  for (const file of files) {
    const rel = relative(dir, file);
    const top = rel.split('/')[0];
    let raw: unknown;
    try {
      raw = parse(readFileSync(file, 'utf8'));
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
    } else {
      errors.push(`${rel}: файл вне известных разделов (conditions, findings, exams, risks, treatments)`);
    }
  }
  if (!contentVersion) errors.push('version.yaml: нет contentVersion');

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
      if (typeof l.band !== 'string') warnings.push(`${owner}: точная частота ${l.f} = ${l.band.pct} % — проверьте, что источник её называет`);
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
    if (!c.course.selfLimiting && c.presenting && !c.course.untreated) warnings.push(`${owner}: не проходит само, но не сказано, что будет без лечения`);
  }
  for (const t of Object.values(treatments)) {
    for (const e of t.effects) if (!(e.on in conditions)) errors.push(`${t.id}: действует на неизвестное состояние ${e.on}`);
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

  // --- сборка ---
  const db: ContentDb = { contentVersion, hash: '', conditions: {}, findings: {}, exams: {}, risks: {}, treatments: {}, revealedBy };
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
    if (c.treatment) out.treatment = c.treatment;
    if (c.pearls) out.pearls = c.pearls;
    db.conditions[c.id] = out;
  }
  for (const f of Object.values(findings).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const out: Finding = { id: f.id, name: f.name, kind: f.id.split('.')[0] as Finding['kind'], leak: prob(f.leak), salience: f.salience, texts: f.texts, review: f.review };
    if (f.redFlag) out.redFlag = true;
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
    if (e.radiation) out.radiation = e.radiation;
    if (e.routine) out.routine = true;
    db.exams[e.id] = out;
  }
  for (const r of Object.values(risks).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const out: Risk = { id: r.id, name: r.name, p: { m: Math.round(r.prevalence.m * 100), f: Math.round(r.prevalence.f * 100) }, findings: r.findings.map(compileLink), review: r.review };
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
    db.treatments[t.id] = out;
  }
  db.hash = fingerprint({ ...db, hash: '' });
  return { db, errors, warnings, files: files.length };
}
