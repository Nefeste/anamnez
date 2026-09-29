// План лечения и его проверка (`docs/04-medical-model.md` §8). План оценивается по правде:
// роль каждого назначения при настоящем основном заболевании, где на самом деле надо
// лечить и какие противопоказания нарушены — и знал ли о них врач.
import type { ContentDb, Effect, Id, Setting, Tactics } from '../../content/types';
import { knownFacts } from './infer';
import type { ActiveCondition, Observation, Patient } from './types';

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

/** Совпало ли условие по скрытым параметрам болезни (часть 30в): нет условия — совпало. */
export function whenHolds(when: Record<string, string[]> | undefined, params: Record<string, string>): boolean {
  return !when || Object.entries(when).every(([name, values]) => values.includes(params[name]));
}

/**
 * Что из назначенного действует на причину у этого больного: `cure` на его болезнь — с условием
 * по её скрытым параметрам (часть 30в: неоперативное лечение непроходимости — без ишемии кишки).
 */
export function curesOf(db: ContentDb, condition: Pick<ActiveCondition, 'id' | 'params'>, treatments: readonly Id[]): Effect[] {
  return treatments.flatMap(tx => db.treatments[tx]?.effects.filter(e => e.on === condition.id && e.kind === 'cure' && whenHolds(e.when, condition.params)) ?? []);
}

/**
 * Проходит ли болезнь у этого больного сама: у записи `selfLimiting` может быть условие по
 * скрытому параметру (часть 30д: неосложнённый дивертикулит проходит и без антибиотиков, абсцесс — нет).
 */
export function selfLimits(db: ContentDb, condition: Pick<ActiveCondition, 'id' | 'params'>): boolean {
  const c = db.conditions[condition.id];
  return c?.selfLimiting === true && whenHolds(c.selfLimitingWhen, condition.params);
}

/** Что будет без действенного лечения у этого больного — запись `untreated`, если её условие совпало (часть 30д). */
export function untreatedOf(db: ContentDb, condition: Pick<ActiveCondition, 'id' | 'params'>): { p: number; days: [number, number] } | undefined {
  const u = db.conditions[condition.id]?.untreated;
  return u && whenHolds(u.when, condition.params) ? u : undefined;
}

/**
 * Роль назначения при состоянии. `params` — скрытые параметры болезни у этого больного (часть 32):
 * тактика по ним сильнее общей — у перелома со смещением репозиция — первая линия.
 */
export function txRole(db: ContentDb, condId: Id, tx: Id, params?: Record<string, string>): TxRole {
  const t = db.conditions[condId]?.treatment;
  const x = params && t?.byParam?.find(b => whenHolds(b.when, params) && ROLES.some(role => b[role].includes(tx)));
  if (x) return ROLES.find(role => x[role].includes(tx))!;
  // своя операция болезни — первая линия (часть 28); в тактике её нет: до приезда скорой её не сделать
  if (db.conditions[condId]?.surgery?.tx === tx) return 'firstLine';
  if (!t) return 'notIndicated';
  return ROLES.find(role => t[role].includes(tx)) ?? 'notIndicated';
}

/**
 * Тактика при таких значениях скрытых параметров (часть 32): роли из подошедших записей `byParam`
 * поверх общих списков; типичное назначение — их или общее. Без параметров — общая тактика.
 */
export function tacticsFor(t: Tactics, params: Record<string, string> = {}): Tactics {
  const over = (t.byParam ?? []).filter(b => whenHolds(b.when, params));
  if (over.length === 0) return t;
  const named = new Set(over.flatMap(b => ROLES.flatMap(role => b[role])));
  const lists = Object.fromEntries(ROLES.map(role => [role, [...new Set([...over.flatMap(b => b[role]), ...t[role].filter(id => !named.has(id))])]])) as Record<TxRole, Id[]>;
  const plan = over.find(b => b.plan)?.plan ?? t.plan?.filter(id => lists.firstLine.includes(id) || lists.acceptable.includes(id) || lists.supportive.includes(id));
  return { ...lists, setting: t.setting, ...(plan && plan.length > 0 ? { plan } : {}) };
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
  const effective = curesOf(db, primaryOf(patient), plan.treatments).length > 0;
  const params = primaryOf(patient).params;
  const base = db.conditions[primary].treatment;
  const tactics = base && tacticsFor(base, params);
  const firstLineBlocked = (tactics?.firstLine ?? [])
    .some(tx => db.treatments[tx]?.contraindications.some(k => knownIds.has(k.id)));
  return {
    primary,
    roles: plan.treatments.map(tx => ({ tx, role: txRole(db, primary, tx, params) })),
    setting: { chosen: plan.setting, recommended: recommendedSetting(db, patient) },
    violations,
    effective,
    unaskedRisk: unaskedRisk.sort(),
    firstLineBlocked,
    // до приезда скорой операцию не сделать
    preHospital: tactics && tactics.setting.default !== 'home' ? tactics.firstLine.filter(tx => db.treatments[tx]?.kind !== 'surgery') : [],
  };
}
