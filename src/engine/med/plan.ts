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

export const SETTING_ORDER: Record<Setting, number> = { home: 0, ward: 1, ambulance: 2 };

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
}

export function primaryOf(patient: Patient) {
  return patient.truth.conditions.find(c => c.role === 'primary') ?? patient.truth.conditions[0];
}

export function txRole(db: ContentDb, condId: Id, tx: Id): TxRole {
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
  return best;
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
      if (!asked && !unaskedRisk.includes(k.id)) unaskedRisk.push(k.id);
      if (truly.has(k.id)) violations.push({ tx, by: k.id, level: k.level, known: knownIds.has(k.id), asked });
    }
  }
  const effective = plan.treatments.some(tx => db.treatments[tx]?.effects.some(e => e.on === primary && e.kind === 'cure'));
  const firstLineBlocked = (db.conditions[primary].treatment?.firstLine ?? [])
    .some(tx => db.treatments[tx]?.contraindications.some(k => knownIds.has(k.id)));
  return {
    primary,
    roles: plan.treatments.map(tx => ({ tx, role: txRole(db, primary, tx) })),
    setting: { chosen: plan.setting, recommended: recommendedSetting(db, patient) },
    violations,
    effective,
    unaskedRisk: unaskedRisk.sort(),
    firstLineBlocked,
  };
}
