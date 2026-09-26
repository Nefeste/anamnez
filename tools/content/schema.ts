// Схема исходных записей медицинской базы (YAML в content/, `docs/05-content.md` §4).
// Строгие объекты: опечатка в имени поля — ошибка сборки, а не молча пропущенное поле.
import { z } from 'zod';

export const BANDS = {
  always: 9500,
  usually: 7500,
  often: 5000,
  sometimes: 2500,
  rarely: 800,
  very_rarely: 200,
  never: 0,
} as const;
export type Band = keyof typeof BANDS;

/** Распространённость → относительный вес основного заболевания. */
export const PREVALENCE = {
  very_common: 1000,
  common: 300,
  uncommon: 100,
  rare: 30,
  very_rare: 10,
} as const;

const band = z.enum(Object.keys(BANDS) as [Band, ...Band[]]);
/** Вероятность: полоса или точное число в процентах (тогда в записи нужен источник). */
const probability = z.union([band, z.strictObject({ pct: z.number().min(0).max(100) })]);

const text = z.strictObject({ ru: z.string().min(1), en: z.string().optional() });
const texts = z.array(text).min(1);
const review = z.enum(['draft', 'checked', 'reviewed']);
const source = z.strictObject({
  kind: z.enum(['guideline', 'textbook', 'paper', 'review', 'dataset', 'score']),
  title: z.string().min(1),
  org: z.string().optional(),
  year: z.number().int().optional(),
  url: z.string().optional(),
  note: z.string().optional(),
});
const weights = z.record(z.string(), z.number().int().positive());
const attrSpec = z.union([
  z.string().regex(/^\$[a-z_]+$/, 'ссылка на параметр пишется как $имя'),
  weights,
]);
const link = z.strictObject({
  f: z.string(),
  band: probability,
  stages: z.array(z.string()).optional(),
  when: z.record(z.string(), z.array(z.string())).optional(),
  attrs: z.record(z.string(), attrSpec).optional(),
});
const riskMultiplier = z.strictObject({ id: z.string(), x: z.number().positive() });
const season = z.strictObject({ winter: z.number(), spring: z.number(), summer: z.number(), autumn: z.number() });

export const conditionSchema = z.strictObject({
  id: z.string().regex(/^cond\.[a-z0-9_]+$/),
  name: text,
  icd10: z.string().optional(),
  department: z.string(),
  group: z.string().regex(/^grp\.[a-z0-9_]+$/).optional(),
  kind: z.enum(['disease', 'injury', 'syndrome', 'state']),
  severity: z.enum(['minor', 'moderate', 'serious', 'critical']),
  presenting: z.boolean().default(true),
  epidemiology: z.strictObject({
    prevalence: z.enum(Object.keys(PREVALENCE) as [keyof typeof PREVALENCE, ...(keyof typeof PREVALENCE)[]]),
    age: z.strictObject({ min: z.number().int(), max: z.number().int().optional(), peak: z.tuple([z.number(), z.number()]).optional() }),
    sex: z.strictObject({ m: z.number(), f: z.number() }).optional(),
    season: season.optional(),
    risks: z.array(riskMultiplier).optional(),
    requires: z.array(z.string()).optional(),
    chronic: z.strictObject({ band: probability, ageMin: z.number().int().optional(), risks: z.array(riskMultiplier).optional() }).optional(),
  }),
  params: z.record(z.string(), weights).optional(),
  course: z.strictObject({
    stages: z.array(z.strictObject({ id: z.string(), days: z.tuple([z.number(), z.number()]), needs: z.literal('treatment').optional() })).min(1),
    /** в какие дни болезни обычно обращаются */
    presentation: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
    selfLimiting: z.boolean().optional(),
  }),
  findings: z.array(link).min(3),
  confirm: z.union([z.array(z.string()).min(1), z.literal('clinical')]),
  redFlags: z.array(z.string()).optional(),
  texts: z.strictObject({ summary: text }),
  pearls: z.array(text).optional(),
  simplified: z.string().optional(),
  sources: z.array(source).min(1),
  review,
});

export const findingSchema = z.strictObject({
  id: z.string().regex(/^(sym|sign|vital|lab|img|ecg|hx)\.[a-z0-9_]+$/),
  name: text,
  leak: probability,
  salience: z.number().int().min(0).max(3).default(0),
  redFlag: z.boolean().optional(),
  attrs: z.record(z.string(), z.record(z.string(), text)).optional(),
  value: z.strictObject({
    unit: z.string(),
    ref: z.tuple([z.number(), z.number()]),
    present: z.tuple([z.number(), z.number()]),
    absent: z.tuple([z.number(), z.number()]),
    decimals: z.number().int().min(0).max(3),
  }).optional(),
  texts: z.strictObject({ complaint: texts.optional(), present: texts, absent: texts.optional() }),
  sources: z.array(source).optional(),
  review,
});

const accuracy = z.number().min(50).max(100);
export const examSchema = z.strictObject({
  id: z.string().regex(/^exam\.[a-z0-9_]+$/),
  name: text,
  kind: z.enum(['ask', 'physical', 'bedside', 'lab', 'rapid', 'functional', 'imaging']),
  room: z.string().optional(),
  time: z.strictObject({ procedure: z.number().int().min(0), report: z.number().int().min(0).optional(), turnaround: z.number().int().min(0).optional() }),
  cost: z.number().int().min(0),
  discomfort: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  radiation: z.enum(['none', 'low', 'medium', 'high']).optional(),
  /** чувствительность и специфичность — в процентах */
  checks: z.array(z.strictObject({ f: z.string(), sens: accuracy, spec: accuracy })).min(1),
  texts: z.strictObject({ summary: text }),
  sources: z.array(source).min(1),
  review,
});

export const riskSchema = z.strictObject({
  id: z.string().regex(/^risk\.[a-z0-9_]+$/),
  name: text,
  prevalence: z.strictObject({ m: z.number().min(0).max(100), f: z.number().min(0).max(100) }),
  ageMin: z.number().int().optional(),
  findings: z.array(link),
  sources: z.array(source).min(1),
  review,
});

export const versionSchema = z.strictObject({ contentVersion: z.number().int().min(1) });

export type ConditionSrc = z.infer<typeof conditionSchema>;
export type FindingSrc = z.infer<typeof findingSchema>;
export type ExamSrc = z.infer<typeof examSchema>;
export type RiskSrc = z.infer<typeof riskSchema>;
export type LinkSrc = z.infer<typeof link>;
export type ProbabilitySrc = z.infer<typeof probability>;
