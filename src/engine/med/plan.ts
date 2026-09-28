// План лечения и его проверка (`docs/04-medical-model.md` §8). План оценивается по правде:
// роль каждого назначения при настоящем основном заболевании, где на самом деле надо
// лечить и какие противопоказания нарушены — и знал ли о них врач.
import type { ContentDb, Id, Setting } from '../../content/types';
import { knownFacts } from './infer';
import type { Observation, Patient } from './types';

export interface Plan {
  treatments: Id[];
  setting: Setting;
}

/** Роль назначения при состоянии; не названное в тактике — «не показано». */
export type TxRole = 'firstLine' | 'acceptable' | 'supportive' | 'notIndicated' | 'harmful';
const ROLES: TxRole[] = ['firstLine', 'acceptable', 'supportive', 'notIndicated', 'harmful'];

/** Насколько серьёзна помощь: чем выше, тем срочнее и сложнее. */
export const SETTING_ORDER: Record<Setting, number> = { home: 0, ward: 1, admit: 1, ambulance: 2, surgery: 3, transfer: 3 };

/**
 * Что закрывает выбор врача (spec 2026-09-chapter-2, «Место лечения»): «Вызвать скорую» везёт
 * в больницу, где сделают нужное, — и операцию, и центр; своя палата — стационар сразу, но не
 * операцию и не центр.
 */
const COVERS: Record<Setting, readonly Setting[]> = {
  home: ['home'],
  ward: ['ward'],
  ambulance: ['ambulance', 'surgery', 'transfer'],
  admit: ['ward', 'ambulance'],
  surgery: ['surgery'],
  transfer: ['ambulance', 'surgery', 'transfer'],
};

/** Подходит ли выбор к тому, что нужно пациенту: да, меньше нужного, больше нужного. */
export function settingFit(need: Setting, chosen: Setting): 'ok' | 'under' | 'over' {
  if (COVERS[chosen].includes(need)) return 'ok';
  return SETTING_ORDER[chosen] < SETTING_ORDER[need] ? 'under' : 'over';
}

/**
 * Что есть в больнице: свободная своя койка — стационар свой (часть 26); работает операционная с
 * бригадой и аппаратами для нужной операции и есть койка после неё — операция своя (часть 28).
 */
export interface Venue {
  ward?: boolean;
  or?: boolean;
}

/**
 * Что выбрать при такой нужде здесь: в амбулатории — направить или скорая, со своей палатой — в
 * неё, со своей операционной — оперировать; центра, которого в районе нет, — скорая.
 */
export function choiceFor(need: Setting, venue: Venue = {}): Setting {
  if (need === 'home') return 'home';
  if (need === 'ward' || need === 'ambulance') return venue.ward ? 'admit' : need;
  if (need === 'surgery' && venue.or) return 'surgery';
  return 'ambulance';
}

export interface Violation {
  tx: Id;
  /** противопоказание: фактор риска (аллергия) или состояние */
  by: Id;
  level: 'relative' | 'absolute';
  /** врач знал о противопоказании (пациент сказал) */
  known: boolean;
  /** врач спрашивал об этом */
  asked: boolean;
}

export interface PlanEval {
  primary: Id;
  roles: { tx: Id; role: TxRole }[];
  setting: { chosen: Setting; recommended: Setting };
  /** противопоказания, которые у пациента на самом деле есть */
  violations: Violation[];
  /** есть ли в плане лечение, действующее на причину основного состояния */
  effective: boolean;
  /** назначено лечение с противопоказаниями, а о них не спросили — даже если их нет */
  unaskedRisk: Id[];
  /** к препарату выбора есть противопоказание, о котором врач знает, — замена оправдана */
  firstLineBlocked: boolean;
  /** что сделать до приезда скорой: первая линия состояния, которое лечат не дома (ОКС) */
  preHospital: Id[];
}

export function primaryOf(patient: Patient) {
  return patient.truth.conditions.find(c => c.role === 'primary') ?? patient.truth.conditions[0];
}

export function txRole(db: ContentDb, condId: Id, tx: Id): TxRole {
  // своя операция болезни — первая линия (часть 28); в тактике её нет: до приезда скорой её не сделать
  if (db.conditions[condId]?.surgery?.tx === tx) return 'firstLine';
  const t = db.conditions[condId]?.treatment;
  if (!t) return 'notIndicated';
  return ROLES.find(role => t[role].includes(tx)) ?? 'notIndicated';
}

/** Где на самом деле надо лечить: место по умолчанию, по тяжести случая, при красном флаге. */
export function recommendedSetting(db: ContentDb, patient: Patient): Setting {
  const primary = primaryOf(patient);
  const cond = db.conditions[primary.id];
  const rule = cond.treatment?.setting;
  if (!rule) return 'home';
  let best: Setting = rule.default;
  const raise = (s: Setting | undefined) => {
    if (s && SETTING_ORDER[s] > SETTING_ORDER[best]) best = s;
  };
  if (rule.param) raise(rule.param.map[primary.params[rule.param.name]]);
  const has = new Set(patient.truth.findings.map(f => f.f));
  if (rule.redFlag && (cond.redFlags ?? []).some(f => has.has(f))) raise(rule.redFlag);
  for (const r of rule.risks ?? []) if (patient.truth.risks.includes(r.id)) raise(r.setting);
  return best;
}

/**
 * Может ли у пациента быть этот фактор риска — по полу и возрасту из базы. О беременности
 * не спрашивают мужчину и женщину 64 лет, и оценка не ставит этого в вину (отзыв на 0.0.8:
 * мужчине — «не спросили о беременности»).
 */
export function possibleFor(db: ContentDb, id: Id, patient: Pick<Patient, 'sex' | 'age'>): boolean {
  const r = db.risks[id];
  if (!r) return true;
  return r.p[patient.sex] > 0 && patient.age >= (r.ageMin ?? 0) && patient.age <= (r.ageMax ?? 200);
}

/** Признаки, которыми противопоказание становится известно врачу (ответ на вопрос). */
function tellingFindings(db: ContentDb, id: Id): Id[] {
  return (db.risks[id]?.findings ?? db.conditions[id]?.findings ?? []).map(l => l.f).filter(f => f.startsWith('hx.'));
}

export function evaluatePlan(db: ContentDb, patient: Patient, plan: Plan, observations: readonly Observation[]): PlanEval {
  const primary = primaryOf(patient).id;
  const known = knownFacts(db, observations);
  const knownIds = new Set([...known.risks, ...known.conditions]);
  const truly = new Set([...patient.truth.risks, ...patient.truth.conditions.map(c => c.id)]);
  const askedF = new Set(observations.map(o => o.f));
  const violations: Violation[] = [];
  const unaskedRisk: Id[] = [];
  for (const tx of plan.treatments) {
    for (const k of db.treatments[tx]?.contraindications ?? []) {
      const asked = tellingFindings(db, k.id).some(f => askedF.has(f));
      if (!asked && possibleFor(db, k.id, patient) && !unaskedRisk.includes(k.id)) unaskedRisk.push(k.id);
      if (truly.has(k.id)) violations.push({ tx, by: k.id, level: k.level, known: knownIds.has(k.id), asked });
    }
  }
  const effective = plan.treatments.some(tx => db.treatments[tx]?.effects.some(e => e.on === primary && e.kind === 'cure'));
  const tactics = db.conditions[primary].treatment;
  const firstLineBlocked = (tactics?.firstLine ?? [])
    .some(tx => db.treatments[tx]?.contraindications.some(k => knownIds.has(k.id)));
  return {
    primary,
    roles: plan.treatments.map(tx => ({ tx, role: txRole(db, primary, tx) })),
    setting: { chosen: plan.setting, recommended: recommendedSetting(db, patient) },
    violations,
    effective,
    unaskedRisk: unaskedRisk.sort(),
    firstLineBlocked,
    preHospital: tactics && tactics.setting.default !== 'home' ? tactics.firstLine : [],
  };
}
