// Первые меры у скорой (spec 2026-10-first-measures, часть 95): кислород, инфузия, глюкоза, давящая повязка. Медсестра
// смотровой делает их сразу, до решения; тяжёлому без нужной меры каждые 20–40 минут хуже на ступень, после последней —
// остановка. Ступени не хранятся: их считают по времени от того, как больного положили в смотровую (`bayT`), до минуты
// меры. Монитор — то, что намерил фельдшер, со сдвигами ступеней и мер; выводу он не виден (ADR 0009).
import type { ContentDb, Id, Measure } from '../../content/types';
import { Rng } from '../core/rng';
import { type TxRole, txRole } from '../med/plan';
import type { Observation, Patient } from '../med/types';
import type { ShiftPatient, ShiftState } from './types';

const GIVEN: readonly TxRole[] = ['firstLine', 'acceptable', 'supportive', 'require', 'beforeTransfer'];

/** Чьё число у признака: низкое давление меряют тем же тонометром, что высокое (`value.of`). */
export const valueKey = (db: ContentDb, f: Id): Id => db.findings[f]?.value?.of ?? f;

/** Мера по назначению. */
export const measureOf = (db: ContentDb, tx: Id): Measure | undefined => Object.values(db.measures).find(m => m.tx === tx);

/**
 * Тяжёлому нужна эта мера: признак есть у правды, его число не выше порога, а роль назначения у основной болезни — одна
 * из разрешённых (инфузия при застое в лёгких вредна — давление ниже 90 лечат в «Решении»). С `seen` — и в листе передачи
 * (`sheet`, что намерил фельдшер): ошибка его измерения часов не запускает — опасности, которой не видно, игра не
 * засчитывает.
 */
export function severeFor(db: ContentDb, m: Measure, patient: Patient, sheet: readonly Observation[] = []): boolean {
  if (!patient.truth.findings.some(x => x.f === m.severe.f)) return false;
  if (m.severe.max !== undefined) {
    const v = patient.truth.values[valueKey(db, m.severe.f)];
    if (v === undefined || v > m.severe.max) return false;
  }
  if (m.severe.seen && !sheet.some(o => o.f === m.severe.f && o.shown && (m.severe.max === undefined || (o.value !== undefined && o.value <= m.severe.max)))) return false;
  const primary = patient.truth.conditions[0];
  return (m.severe.roles ?? GIVEN).includes(txRole(db, primary.id, m.tx, primary.params));
}

/** Лист передачи: что намерил фельдшер при поступлении. */
export const sheetOf = (p: Pick<ShiftPatient, 'results'>): Observation[] => p.results.find(r => r.exam === 'exam.vitals')?.obs ?? [];

/** Первые меры, без которых этому больному хуже по часам: привезён скорой и лежит в смотровой. По порядку мер. */
export function needsOf(db: ContentDb, p: ShiftPatient): Measure[] {
  if (p.kind !== 'ambulance' || p.bayT === undefined) return [];
  const sheet = sheetOf(p);
  return Object.values(db.measures).filter(m => severeFor(db, m, p.patient, sheet));
}

/** Шаг ухудшения без меры, секунд: у каждого больного и каждой меры свой, из своей ветви. */
export function stepSeconds(s: Pick<ShiftState, 'meta'>, p: Pick<ShiftPatient, 'id'>, m: Measure): number {
  return Rng.seeded(s.meta.seed).fork(`worse:${p.id}:${m.id}`).range(m.every[0], m.every[1]) * 60;
}

/** Когда медсестра сделала меру; не назначена — undefined. */
export const measureDone = (p: Pick<ShiftPatient, 'measures'>, tx: Id): number | undefined => p.measures?.find(x => x.tx === tx)?.done;

/** Последняя ступень — остановка: ступеней в записи и ещё одна. */
export const arrestStep = (m: Measure) => m.steps.length + 1;

/**
 * Сколько ступеней у нужды к минуте `t`: часы идут от `bayT` до того, что раньше, — мера сделана, приём закрыт; дальше
 * остановки не считают.
 */
export function stepsAt(s: Pick<ShiftState, 'meta'>, p: ShiftPatient, m: Measure, t: number): number {
  if (p.bayT === undefined) return 0;
  const end = Math.min(t, measureDone(p, m.tx) ?? Infinity, p.closed?.at ?? Infinity);
  if (end <= p.bayT) return 0;
  return Math.min(arrestStep(m), Math.floor((end - p.bayT) / stepSeconds(s, p, m)));
}

/** Монитор у койки: числа, признаки ступеней, что сняла мера. */
export interface BayVitals {
  /** число по признаку-владельцу числа (`valueKey`): сатурация, верхнее давление, пульс, дыхание, сахар */
  values: Record<Id, number>;
  /** с поступления: насколько число сдвинулось — для стрелки */
  delta: Record<Id, number>;
  /** признаки ступеней, которые сейчас есть: спутанность, оглушение, кома */
  added: Id[];
  /** мера сняла признаки (пришёл в себя после глюкозы) */
  cleared: boolean;
}

/**
 * Монитор к минуте `t`: что намерил фельдшер (лист передачи), со сдвигами ступеней тех нужд, чья мера ещё не сделана или
 * не отменяет случившееся (повязка), и с целью сделанной меры (сатурация 94 %). Правды он не открывает: без листа
 * передачи чисел нет.
 */
export function bayVitals(db: ContentDb, s: Pick<ShiftState, 'meta' | 't'>, p: ShiftPatient, t = s.t): BayVitals {
  const base: Record<Id, number> = {};
  for (const r of p.results) {
    if (r.exam !== 'exam.vitals') continue;
    for (const o of r.obs) if (o.value !== undefined) base[valueKey(db, o.f)] ??= o.value;
  }
  const values = { ...base };
  const added = new Set<Id>();
  let cleared = false;
  const primary = p.patient.truth.conditions[0].id;
  for (const m of needsOf(db, p)) {
    const done = measureDone(p, m.tx);
    const given = done !== undefined && done <= t;
    const k = Math.min(m.steps.length, stepsAt(s, p, m, t));
    if (!(given && m.effect.undo)) {
      for (const st of m.steps.slice(0, k)) {
        for (const [f, d] of Object.entries(st.change)) {
          const key = valueKey(db, f);
          if (values[key] !== undefined) values[key] = round1(values[key] + d);
        }
        for (const f of st.add) added.add(f);
      }
    }
    if (given) {
      for (const [f, to] of Object.entries({ ...m.effect.to, ...(m.effect.toFor?.[primary] ?? {}) })) {
        const key = valueKey(db, f);
        if (values[key] !== undefined && values[key] < to) values[key] = to;
      }
      if (m.effect.clears.length > 0 && t >= done! + m.effect.after * 60) {
        for (const f of m.effect.clears) added.delete(f);
        cleared = true;
      }
    }
  }
  const delta: Record<Id, number> = {};
  for (const [key, v] of Object.entries(values)) if (base[key] !== undefined && v !== base[key]) delta[key] = round1(v - base[key]);
  return { values, delta, added: [...added], cleared };
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** «Код синий» без успеха (часть 95): бригада у койки 10 минут, потом приём закрывается смертью — как на карте с 0.6.10. */
export const CODE_SECONDS = 10 * 60;

/** Застой в лёгких и отёки (spec 2026-10-first-measures): с ними инфузия при низком давлении вредна (RCUK, «C»). */
const CONGESTION: readonly Id[] = ['sym.orthopnea', 'sign.leg_edema_bilateral', 'sign.neck_veins_distended', 'sign.crackles_bilateral', 'sign.crackles_diffuse', 'img.cxr_congestion', 'img.cxr_edema'];
/** Лёгкие послушали: известно, есть ли хрипы. */
const LUNGS: readonly Id[] = ['sign.crackles_bilateral', 'sign.crackles_diffuse'];

/**
 * Какие первые меры разумный врач даст по известному (spec 2026-10-first-measures, «Разумный врач»): сатурация 91 % и
 * ниже — кислород; давление ниже 90 — инфузия, если застоя не видно: при боли в груди — нет (шок бывает сердечный), при
 * одышке — когда послушал лёгкие, а при дыхании Куссмауля — сразу; гипогликемия по глюкометру — глюкоза; большая рана с
 * кровопотерей — давящая повязка.
 * Правда ему не видна — только жалобы и результаты.
 */
export function measuresDue(db: ContentDb, complaints: readonly Id[], obs: readonly { f: Id; shown: boolean; value?: number }[]): Id[] {
  const shown = (f: Id) => obs.some(o => o.f === f && o.shown);
  const checked = (f: Id) => obs.some(o => o.f === f);
  const out: Id[] = [];
  const spo2 = obs.filter(o => o.f === 'vital.spo2_low' && o.value !== undefined).at(-1)?.value;
  if (spo2 !== undefined && spo2 <= 91) out.push('tx.oxygen_mask');
  const chest = complaints.some(f => f.startsWith('sym.chest_pain'));
  // одышка при дыхании Куссмауля — ацидоз, а не застой: раствор — сразу
  const breath = complaints.includes('sym.dyspnea') && !shown('sign.kussmaul');
  if (shown('vital.bp_low') && !chest && !CONGESTION.some(shown) && (!breath || LUNGS.some(checked))) out.push('tx.iv_fluids');
  if (shown('lab.glucose_low')) out.push('tx.dextrose_iv');
  if (shown('sign.wound_large')) out.push('tx.pressure_dressing');
  return out.filter(tx => measureOf(db, tx) !== undefined);
}
