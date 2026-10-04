// План лечения и его проверка (`docs/04-medical-model.md` §8). План оценивается по правде:
// роль каждого назначения при настоящем основном заболевании, где на самом деле надо
// лечить и какие противопоказания нарушены — и знал ли о них врач.
import { type ContentDb, type Effect, type Id, membersOf, type Setting, type Tactics } from '../../content/types';
import { knownFacts } from './infer';
import type { ActiveCondition, Observation, Patient } from './types';

export interface Plan {
  treatments: Id[];
  setting: Setting;
}

/**
 * Роль назначения при состоянии; не названное в тактике — «не показано». `prevent` — обязательная
 * профилактика (часть 32г-2): анатоксин столбнячный, вакцина от бешенства; `require` — обязательно
 * при лечении здесь (часть 38б): кислород через маску при сатурации ниже порога рекомендации;
 * `beforeTransfer` — обязательно и при переводе, до него (часть 39а): тромболизис в окне.
 */
export type TxRole = 'firstLine' | 'acceptable' | 'supportive' | 'notIndicated' | 'harmful' | 'prevent' | 'require' | 'beforeTransfer';
type ListRole = Exclude<TxRole, 'prevent' | 'require' | 'beforeTransfer'>;
const ROLES: ListRole[] = ['firstLine', 'acceptable', 'supportive', 'notIndicated', 'harmful'];

/** Насколько серьёзна помощь: чем выше, тем срочнее и сложнее. */
export const SETTING_ORDER: Record<Setting, number> = { home: 0, ward: 1, admit: 1, ambulance: 2, icu: 2, surgery: 3, transfer: 3 };

/**
 * Что закрывает выбор врача (spec 2026-09-chapter-2, «Место лечения»): «Вызвать скорую» везёт
 * в больницу, где сделают нужное, — и операцию, и центр, и палату интенсивной терапии; своя
 * палата — стационар сразу, но не операцию, не центр и не ПИТ; своя ПИТ — и палату, и срочный
 * стационар (spec 2026-10-chapter-3, часть 38а).
 */
const COVERS: Record<Setting, readonly Setting[]> = {
  home: ['home'],
  ward: ['ward'],
  ambulance: ['ambulance', 'surgery', 'transfer', 'icu'],
  admit: ['ward', 'ambulance'],
  surgery: ['surgery'],
  transfer: ['ambulance', 'surgery', 'transfer', 'icu'],
  icu: ['ward', 'ambulance', 'icu'],
};

/**
 * Подходит ли выбор к тому, что нужно пациенту: да, меньше нужного, больше нужного. `also` — ещё
 * места, которые у этого больного не ошибка (часть 32б): перелом ключицы со смещением — операция
 * или повязка дома.
 */
export function settingFit(need: Setting, chosen: Setting, also: readonly Setting[] = []): 'ok' | 'under' | 'over' {
  if (COVERS[chosen].includes(need) || also.some(s => COVERS[chosen].includes(s))) return 'ok';
  return SETTING_ORDER[chosen] < SETTING_ORDER[need] ? 'under' : 'over';
}

/**
 * Что есть в больнице: свободная своя койка — стационар свой (часть 26); работает операционная с
 * бригадой и аппаратами для нужной операции и есть койка после неё — операция своя (часть 28);
 * свободная койка палаты интенсивной терапии под монитором — ПИТ своя (часть 38а).
 */
export interface Venue {
  ward?: boolean;
  or?: boolean;
  icu?: boolean;
  /**
   * аппараты у постели этого больного (spec 2026-10-chapter-3, часть 39а): лежит в смотровой
   * приёмного под монитором с дефибриллятором — тромболизис можно; нет — в кабинете врача его нет
   */
  bedside?: readonly Id[];
}

/** Какого аппарата у постели не хватает лечению у постели (часть 39а); всё есть — undefined. */
export function bedsideLack(db: ContentDb, tx: Id, venue: Venue = {}): Id | undefined {
  return db.treatments[tx]?.bedside?.equipment.find(e => venue.bedside?.includes(e) !== true);
}

/** Можно ли назначить здесь: лечению у постели (часть 39а) нужны его аппараты у постели больного. */
export function txAvailable(db: ContentDb, tx: Id, venue: Venue = {}): boolean {
  return bedsideLack(db, tx, venue) === undefined;
}

/**
 * Что выбрать при такой нужде здесь: в амбулатории — направить или скорая, со своей палатой — в
 * неё, со своей операционной — оперировать, со своей ПИТ — в неё; центра, которого в районе нет, и
 * ПИТ, которой в больнице нет, — скорая.
 */
export function choiceFor(need: Setting, venue: Venue = {}): Setting {
  if (need === 'home') return 'home';
  if (need === 'icu') return venue.icu ? 'icu' : 'ambulance';
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
  /** `also` — ещё места, которые у этого больного не ошибка (часть 32б) */
  setting: { chosen: Setting; recommended: Setting; also?: Setting[] };
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
  /** обязательная профилактика по правде о пациенте, которой нет в плане (часть 32г-2) */
  preventMissing: Id[];
  /** обязательное при лечении здесь по правде о пациенте, чего нет в плане (часть 38б) */
  requireMissing: Id[];
  /** при каких значениях оно обязательно — для строки разбора: «при сатурации ниже 90 %» */
  requireWhen: Record<Id, Record<string, string[]>>;
  /**
   * обязательное и при переводе, чего нет в плане, хотя здесь оно было возможно (часть 39а):
   * тромболизис при инфаркте с подъёмом ST в первые 12 часов, если больной лежит под монитором
   */
  beforeTransferMissing: Id[];
  /** при каких значениях оно обязательно — для строки разбора */
  beforeTransferWhen: Record<Id, Record<string, string[]>>;
  /** назначено без своих спутников (часть 39а): тромболизис — без клопидогрела или эноксапарина */
  companionsMissing: { tx: Id; of: Id }[];
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
 * Обязательная профилактика при этих значениях скрытых параметров (часть 32г-2): общая и из
 * подошедших записей `byParam`; без параметров — вся, какая бывает при этом состоянии.
 */
export function preventOf(t: Tactics | undefined, params?: Record<string, string>): Id[] {
  if (!t) return [];
  const over = (t.byParam ?? []).filter(b => !params || whenHolds(b.when, params));
  return [...new Set([...(t.prevent ?? []), ...over.flatMap(b => b.prevent ?? [])])];
}

/**
 * Обязательное при лечении здесь (часть 38б): общее и из подошедших записей `byParam`; без
 * параметров — только общее: при других значениях у того же лечения может быть другая роль
 * (кислород у ОКС при сатурации от 90 % — «не нужно»). Каждое — группа: одно лечение или «одно из»
 * (часть 39в: антикоагулянт при ОКС без подъёма ST — фондапаринукс, эноксапарин или гепарин).
 */
export function requireOf(t: Tactics | undefined, params?: Record<string, string>): Id[][] {
  return requireListOf(t, params).map(g => (typeof g === 'string' ? [g] : g));
}

/** То же списком записи: лечение — строкой, группа — списком (для `tacticsFor`). */
function requireListOf(t: Tactics | undefined, params?: Record<string, string>): (Id | Id[])[] {
  if (!t) return [];
  const over = params ? (t.byParam ?? []).filter(b => whenHolds(b.when, params)) : [];
  const all = [...(t.require ?? []), ...over.flatMap(b => b.require ?? [])];
  const key = (g: Id | Id[]) => (typeof g === 'string' ? g : g.join());
  return all.filter((g, i) => all.findIndex(x => key(x) === key(g)) === i);
}

/**
 * Обязательное и при переводе (часть 39а): общее и из подошедших записей `byParam`; без параметров —
 * только общее, как у `requireOf`.
 */
export function beforeTransferOf(t: Tactics | undefined, params?: Record<string, string>): Id[] {
  if (!t) return [];
  const over = params ? (t.byParam ?? []).filter(b => whenHolds(b.when, params)) : [];
  return [...new Set([...(t.beforeTransfer ?? []), ...over.flatMap(b => b.beforeTransfer ?? [])])];
}

/**
 * Что сделать до приезда скорой (часть 27; 32д-2) — хоть одно из этого: названное в подошедших
 * записях `byParam` (обширный ожог — капельница до перевода, хотя место по умолчанию — дом); без
 * них у того, что лечат не дома, — первая линия, кроме операции: её до приезда скорой не сделать.
 */
export function preHospitalOf(db: ContentDb, t: Tactics | undefined, params: Record<string, string>): Id[] {
  if (!t) return [];
  const own = (t.byParam ?? []).filter(b => whenHolds(b.when, params)).flatMap(b => b.preHospital ?? []);
  if (own.length > 0) return [...new Set(own)];
  return t.setting.default !== 'home' ? tacticsFor(t, params).firstLine.filter(tx => db.treatments[tx]?.kind !== 'surgery') : [];
}

/**
 * Роль назначения при состоянии. `params` — скрытые параметры болезни у этого больного (часть 32):
 * тактика по ним сильнее общей — у перелома со смещением репозиция — первая линия.
 */
export function txRole(db: ContentDb, condId: Id, tx: Id, params?: Record<string, string>): TxRole {
  const t = db.conditions[condId]?.treatment;
  if (preventOf(t, params).includes(tx)) return 'prevent';
  if (requireOf(t, params).some(g => g.includes(tx))) return 'require';
  if (beforeTransferOf(t, params).includes(tx)) return 'beforeTransfer';
  const x = params && t?.byParam?.find(b => whenHolds(b.when, params) && ROLES.some(role => b[role].includes(tx)));
  if (x) return ROLES.find(role => x[role].includes(tx))!;
  // своя операция болезни — первая линия (часть 28); в тактике её нет: до приезда скорой её не сделать.
  // Операция по параметру (часть 32б) — своя при этих значениях; без значений — любая из своих
  const s = db.conditions[condId]?.surgery;
  if (s && (params ? surgeryFor(db, condId, params) === tx : s.tx === tx || s.byParam?.some(b => b.tx === tx) === true)) return 'firstLine';
  if (!t) return 'notIndicated';
  return ROLES.find(role => t[role].includes(tx)) ?? 'notIndicated';
}

/**
 * Операция, которой лечат это состояние при таких значениях скрытых параметров (часть 32б): у
 * перелома шейки бедра без смещения — винты, со смещением — эндопротез; нет записи — не оперируют.
 */
export function surgeryFor(db: ContentDb, condId: Id, params: Record<string, string> = {}): Id | undefined {
  const s = db.conditions[condId]?.surgery;
  return s?.byParam?.find(b => whenHolds(b.when, params))?.tx ?? s?.tx;
}

/** Все операции состояния — главная и по параметру (часть 32б). */
export function surgeriesOf(db: ContentDb, condId: Id): Id[] {
  const s = db.conditions[condId]?.surgery;
  return s ? [...new Set([s.tx, ...(s.byParam ?? []).map(b => b.tx)])] : [];
}

type SettingRule = Tactics['setting'];

/** Запись «после обследования» (часть 40), если пришёл результат одного из её обследований. */
function afterOf(rule: SettingRule, done: (exam: Id) => boolean): SettingRule['after'] {
  return rule.after?.exams.some(done) ? rule.after : undefined;
}

/**
 * Где лечить по записи места: по умолчанию, по скрытому параметру, при красном флаге и факторе
 * риска — что выше. Пришёл результат обследования из `after` (часть 40) — вместо места по
 * параметру и красного флага его место и его признаки: после КТ без крови сотрясение лечат дома,
 * а оглушённого — в стационаре (734_2, приложение Б). Правда о больном или то, что знает врач, —
 * решает тот, кто спрашивает.
 */
export function settingOf(rule: SettingRule, redFlags: readonly Id[], o: { params: Record<string, string>; has: (f: Id) => boolean; risk: (id: Id) => boolean; done: (exam: Id) => boolean }): Setting {
  let best: Setting = rule.default;
  const raise = (s: Setting | undefined) => {
    if (s && SETTING_ORDER[s] > SETTING_ORDER[best]) best = s;
  };
  const after = afterOf(rule, o.done);
  if (after) {
    raise(after.setting);
    if (after.flags?.any.some(o.has)) raise(after.flags.setting);
  } else {
    if (rule.param) raise(rule.param.map[o.params[rule.param.name]]);
    if (rule.redFlag && redFlags.some(o.has)) raise(rule.redFlag);
  }
  for (const r of rule.risks ?? []) if (o.risk(r.id)) raise(r.setting);
  return best;
}

/**
 * Ещё места, которые у этого больного не ошибка, — по правде о его скрытых параметрах (часть 32б).
 * Послабление — только к месту по параметру: красный флаг или фактор риска из правила места его
 * отменяют (кожа натянута над отломком ключицы — только операция, `853_1`, раздел 6). После
 * обследования из `after` (часть 40) отменяют его признаки: судороги после КТ без крови — не довод.
 * `done` — обследования, результат которых пришёл.
 */
export function alsoSettings(db: ContentDb, patient: Patient, done: readonly Id[] = []): Setting[] {
  const primary = primaryOf(patient);
  const cond = db.conditions[primary.id];
  const rule = cond?.treatment?.setting;
  if (!rule?.also) return [];
  const has = new Set(patient.truth.findings.map(f => f.f));
  const after = afterOf(rule, e => done.includes(e));
  if (after ? after.flags?.any.some(f => has.has(f)) : rule.redFlag && (cond.redFlags ?? []).some(f => has.has(f))) return [];
  if ((rule.risks ?? []).some(r => patient.truth.risks.includes(r.id))) return [];
  return [...new Set(rule.also.filter(a => whenHolds(a.when, primary.params)).flatMap(a => a.settings))];
}

/**
 * Тактика при таких значениях скрытых параметров (часть 32): роли из подошедших записей `byParam`
 * поверх общих списков; типичное назначение — их или общее. Без параметров — общая тактика.
 */
export function tacticsFor(t: Tactics, params: Record<string, string> = {}): Tactics {
  const over = (t.byParam ?? []).filter(b => whenHolds(b.when, params));
  if (over.length === 0) return t;
  // обязательное по параметру (часть 38б) и до перевода (часть 39а) тоже названо: из общих списков оно уходит
  const named = new Set(over.flatMap(b => [...ROLES.flatMap(role => b[role]), ...membersOf(b.require), ...(b.beforeTransfer ?? [])]));
  const lists = Object.fromEntries(ROLES.map(role => [role, [...new Set([...over.flatMap(b => b[role]), ...t[role].filter(id => !named.has(id))])]])) as Record<ListRole, Id[]>;
  const plan = over.find(b => b.plan)?.plan ?? t.plan?.filter(id => lists.firstLine.includes(id) || lists.acceptable.includes(id) || lists.supportive.includes(id));
  const prevent = preventOf(t, params);
  const require = requireListOf(t, params);
  const beforeTransfer = beforeTransferOf(t, params);
  const preHospital = [...new Set(over.flatMap(b => b.preHospital ?? []))];
  return {
    ...lists, setting: t.setting, ...(plan && plan.length > 0 ? { plan } : {}), ...(prevent.length > 0 ? { prevent } : {}),
    ...(require.length > 0 ? { require } : {}), ...(beforeTransfer.length > 0 ? { beforeTransfer } : {}), ...(preHospital.length > 0 ? { preHospital } : {}),
  };
}

/**
 * Где на самом деле надо лечить: место по умолчанию, по тяжести случая, при красном флаге; после
 * обследования из `after` (часть 40) — его место. `done` — обследования, результат которых пришёл.
 */
export function recommendedSetting(db: ContentDb, patient: Patient, done: readonly Id[] = []): Setting {
  const primary = primaryOf(patient);
  const cond = db.conditions[primary.id];
  const rule = cond.treatment?.setting;
  if (!rule) return 'home';
  const has = new Set(patient.truth.findings.map(f => f.f));
  return settingOf(rule, cond.redFlags ?? [], { params: primary.params, has: f => has.has(f), risk: id => patient.truth.risks.includes(id), done: e => done.includes(e) });
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

export function evaluatePlan(db: ContentDb, patient: Patient, plan: Plan, observations: readonly Observation[], venue: Venue = {}): PlanEval {
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
  // место — по пришедшим результатам (часть 40): после КТ без крови сотрясение лечат дома
  const done = [...new Set(observations.map(o => o.exam))];
  const also = alsoSettings(db, patient, done);
  const firstLineBlocked = (tactics?.firstLine ?? [])
    .some(tx => db.treatments[tx]?.contraindications.some(k => knownIds.has(k.id)));
  return {
    primary,
    roles: plan.treatments.map(tx => ({ tx, role: txRole(db, primary, tx, params) })),
    setting: { chosen: plan.setting, recommended: recommendedSetting(db, patient, done), ...(also.length > 0 ? { also } : {}) },
    violations,
    effective,
    unaskedRisk: unaskedRisk.sort(),
    firstLineBlocked,
    preHospital: preHospitalOf(db, base, params),
    // профилактику, противопоказанную тем, о чём врач знает (аллергия на пенициллины), в вину не ставим
    preventMissing: preventOf(base, params).filter(tx => !plan.treatments.includes(tx) && !db.treatments[tx]?.contraindications.some(k => knownIds.has(k.id))).sort(),
    // из группы хватит одного (часть 39в); противопоказанное тем, о чём врач знает, в вину не ставим —
    // из группы называем первое, что можно
    requireMissing: requireOf(base, params).flatMap(g => {
      const can = g.filter(tx => !db.treatments[tx]?.contraindications.some(k => knownIds.has(k.id)));
      return can.length > 0 && !g.some(tx => plan.treatments.includes(tx)) ? [can[0]] : [];
    }).sort(),
    requireWhen: Object.fromEntries((base?.byParam ?? []).filter(b => whenHolds(b.when, params)).flatMap(b => membersOf(b.require).map(tx => [tx, b.when] as const)).reverse()),
    // до перевода (часть 39а) — то, что здесь можно было сделать: тромболизис у постели под монитором
    beforeTransferMissing: beforeTransferOf(base, params)
      .filter(tx => !plan.treatments.includes(tx) && txAvailable(db, tx, venue) && !db.treatments[tx]?.contraindications.some(k => knownIds.has(k.id))).sort(),
    beforeTransferWhen: Object.fromEntries((base?.byParam ?? []).filter(b => whenHolds(b.when, params)).flatMap(b => (b.beforeTransfer ?? []).map(tx => [tx, b.when] as const)).reverse()),
    // спутники (часть 39а): тромболизис без клопидогрела и антикоагулянта — неполное лечение; из группы
    // хватит одного, а противопоказанное тем, о чём врач знает, в вину не ставим
    companionsMissing: plan.treatments.flatMap(of => (db.treatments[of]?.companions ?? []).flatMap(g => {
      const group = typeof g === 'string' ? [g] : g;
      const can = group.filter(tx => !db.treatments[tx]?.contraindications.some(k => knownIds.has(k.id)));
      return can.length > 0 && !group.some(tx => plan.treatments.includes(tx)) ? [{ tx: can[0], of }] : [];
    })),
  };
}
