// «Вид» приёма одного пациента — то, что знает врач (`06-architecture.md` §7): жалобы,
// пришедшие результаты, назначенное, подсказки, черновик решения, итог и разбор закрытого
// случая. Общий для прототипа П4 (visit.ts) и смены (session.ts): экраны карты пациента
// работают с любым из них. Правда здесь появляется только в разборе закрытого случая.
import { db } from '@/content';
import { type BodySystem, type Id, type Setting, SYSTEMS } from '@/content/types';
import { fnv1a } from '@/engine/core/hash';
import type { Outcome } from '@/engine/med/course';
import { complaintObservations, examFits } from '@/engine/med/exams';
import { type Belief, contextOf, knownFacts, posterior } from '@/engine/med/infer';
import { bedsideLack, type PlanEval } from '@/engine/med/plan';
import type { ReviewData } from '@/engine/med/review';
import { type CaseScore, type Grade, type ScoreNote, worstGrade } from '@/engine/med/score';
import { ageBand, checkRule, knownOf, rulesFor } from '@/engine/med/rules';
import { complaintText, observationText } from '@/engine/med/text';
import type { Observation, Patient } from '@/engine/med/types';
import type { TargetResult } from '@/engine/shift/targets';
import type { Difficulty } from '@/engine/shift/types';
import type { EcgFindings, Wall } from '@/render/ecg/model';
import type { ChestCtFindings } from '@/render/ct/chestGeometry';
import type { HeadFindings } from '@/render/ct/geometry';
import type { BoneFindings, BoneFracture } from '@/render/xray/boneGeometry';
import { fracturedRibs, type XrayFindings } from '@/render/xray/chestGeometry';
import { T } from '@/i18n';
import { lowerFirst } from '@/i18n/case';

export const DEPARTMENT = 'dept.therapy';

export interface Line {
  f: Id;
  text: string;
  shown: boolean;
  exam: Id | 'complaint';
}

/**
 * Картинка результата — то, что показал снимок или лента, а не правда: ложный результат
 * нарисован так же, как настоящий. Рисует её src/render (ADR 0013).
 */
export type ResultImage =
  /**
   * обзорный снимок груди: инфильтрат, эмфизема; с травмой груди (часть 32в) — воздух и кровь в
   * плевральной полости, переломы рёбер; с частью 43а — расширенное верхнее средостение; с частью 43в — застой
   * или отёк лёгких и большая тень сердца
   */
  | {
    kind: 'xray'; infiltrate?: 'right' | 'left' | 'both'; hyperinflation: boolean;
    pneumothorax?: XrayFindings['pneumothorax']; effusion?: XrayFindings['effusion']; ribFractures?: XrayFindings['ribFractures'];
    wideMediastinum?: boolean; congestion?: 'congestion' | 'edema'; cardiomegaly?: boolean; seed: number;
  }
  /** лента в двенадцати отведениях (spec 2026-10-chapter-3, часть 36): ритм, частота и находки, которые показало обследование */
  | { kind: 'ecg'; seed: number; ecg: EcgFindings }
  /**
   * УЗИ брюшной полости: правая подвздошная область, `appendix` — виден воспалённый отросток (часть
   * 29); или желчный пузырь — `stones` камней, `wall` — утолщённая стенка (часть 30); или левая
   * подвздошная область — `diverticulum`, воспалённый дивертикул (часть 30д); УЗИ почек — почка,
   * `pelvis` — расширенная лоханка (часть 30г); УЗИ вен ноги (часть 33а) — `deep`: тромб в
   * глубокой вене, `superficial` — в подкожной, `tear` — гематома надрыва мышцы; УЗИ артерий ноги
   * (часть 33б) — `arterial`: артерия закрыта тромбом или эмболом
   */
  | {
    kind: 'us'; view: 'appendix' | 'gallbladder' | 'kidney' | 'colon' | 'vein'; appendix?: number; stones?: number; wall?: number; pelvis?: number;
    diverticulum?: number; deep?: number; superficial?: number; tear?: number; arterial?: number; seed: number;
  }
  /** обзорный снимок живота стоя (часть 30б): серп свободного газа под куполом, раздутые петли с уровнями */
  | { kind: 'abdomen'; freeGas: boolean; levels: boolean; seed: number }
  /** снимок костей (часть 32): запястье или голеностоп в двух проекциях — линия перелома и смещение, что нашёл рентгенолог */
  | ({ kind: 'bone'; seed: number } & BoneFindings)
  /** срез головы на КТ (spec 2026-10-chapter-3, часть 40): кровь внутри черепа — светлое пятно, если её показала КТ */
  | { kind: 'head'; seed: number; findings: HeadFindings }
  /** срез груди на КТ-ангиографии (часть 43а): расслоение аорты — тип A или B, если его показала КТ */
  | { kind: 'chestCt'; seed: number; findings: ChestCtFindings };

/** Результаты одного обследования. `fresh` — пришли за последнее действие игрока. */
export interface ResultGroup {
  key: string;
  exam: Id;
  name: string;
  at: string;
  fresh: boolean;
  lines: Line[];
  image?: ResultImage;
}

/** Справка о термине для «Что это?»: только знания из базы, не правда о пациенте. `id` — статья энциклопедии. */
export interface TermInfo {
  id?: Id;
  title: string;
  text: string[];
  list?: { label: string; items: string[] };
}

export interface Decision {
  diagnosis: Id;
  verdict: 'correct' | 'partly' | 'wrong';
  /** настоящая болезнь — для ссылки в энциклопедию из разбора */
  truth: Id;
  truthName: string;
  /** уверенность идеального врача в поставленном диагнозе, 0–10 */
  outOf10: number;
  pearls: string[];
  causes: { finding: string; cause: string }[];
  /** что было дальше: исход за неделю или перевод */
  outcome: string;
  grades: { key: string; label: string; grade: Grade }[];
  overall: Grade;
  notes: string[];
  /** сроки по рекомендации (часть 37): оценка — худшая из сроков, она входит в «Итог»; строки — по каждому */
  targets?: { grade: Grade; lines: string[] };
  plan: { name: string; role: string }[];
  settingName: string;
  rational: string;
  idle: string[];
  timeline: { label: string; truth: number; chosen: number }[];
}

/** Вариант «где лечить» на экране решения: своя палата — со свободными койками (spec 2026-09-chapter-2, часть 26). */
export interface SettingOption {
  key: Setting;
  title: string;
  hint?: string;
  disabled?: boolean;
}

/** Решение до «Завершить приём»: можно менять и дальше обследовать. */
export interface Draft {
  diagnosis?: Id;
  treatments: Id[];
  setting: Setting;
}

export interface VisitView {
  version: number;
  title: string;
  /** для портрета: пол и возраст видны врачу, ключ портрета — не зерно генерации */
  /** кто пациент; жалобы — кому какой расспрос (часть 32г: о травме головы — при травме головы) */
  portrait: { key: number; sex: 'm' | 'f'; age: number; complaints: Id[] };
  clock: string;
  minutesSpent: number;
  money: number;
  complaints: Line[];
  /** все результаты по порядку прихода */
  results: Line[];
  /** те же результаты по обследованиям, новые сверху */
  groups: ResultGroup[];
  /** сколько результатов пришло за последнее действие */
  freshCount: number;
  pending: { exam: Id; name: string; at: string }[];
  meanwhile: string[];
  /** смена: за это время пришёл срочный пациент — звук «срочно», а не «готово» */
  urgent?: boolean;
  done: Id[];
  /** обследования, которых в этой больнице не сделать, — и почему */
  unavailable: Record<Id, string>;
  /** где лечить: варианты этой больницы */
  settings: SettingOption[];
  hints: { id: Id; name: string; outOf10: number }[];
  /** «Студенту» — правила решения к жалобе (часть 32): что говорят по уже проверенному */
  rules: { id: Id; name: string; text: string }[];
  /** из чего выбирают диагноз — болезни отделений этой больницы по системам органов */
  diagnoses: DiagnosisGroup[];
  /**
   * всё лечение базы по алфавиту; warning — противопоказание, о котором врач уже знает; disabled —
   * здесь не назначить (часть 39а: тромболизис без монитора у постели), warning — почему
   */
  treatments: { id: Id; name: string; warning?: string; disabled?: boolean }[];
  /** то же лечение — по группам (антибиотики, обезболивающие…) для экрана решения */
  treatmentGroups: { key: string; title: string; items: VisitView['treatments'] }[];
  draft: Draft;
  /** название выбранного, но ещё не поставленного диагноза */
  draftDiagnosisName?: string;
  /** смена: можно отпустить ждать результатов и принять другого */
  canSendAway?: boolean;
  /** смена: ждать нечего, а ждёт кто-то срочнее — можно попросить подождать (часть 37) */
  canStepOut?: boolean;
  /** смена: что делается у постели и сколько минут (часть 37: ЭКГ в смотровой приёмного) */
  bedside?: Record<Id, number>;
  /** смена: сроки по рекомендации — строками (часть 37) */
  targets?: string[];
  /** смена: повторное обращение — строка для шапки */
  returnNote?: string;
  /** песочница: кто платит и что оплатит — строка для шапки */
  payerNote?: string;
  /** песочница: оплата закрытого приёма — на экране итога */
  payment?: string[];
  /** достижения, полученные этим приёмом, — названия */
  achievements?: string[];
  /** «Случай дня», повтор: чем засчитана первая попытка */
  firstTry?: string;
  /** приём ведёт нанятый врач — карта только для чтения, внизу «Забрать себе» (spec 2026-09-hired-doctors, часть 19) */
  colleague?: { id: string; doctor: string; away?: boolean };
  /** закрытый приём нанятого врача — строка «Приём вёл…»; есть — на экране итога и «лечение врача» */
  byDoctor?: string;
  decision?: Decision;
}

/** Результаты, пришедшие разом: шаг — номер действия игрока, за которое они пришли. */
export interface Arrival {
  exam: Id;
  step: number;
  /** минуты от полуночи — для подписи «в 08:35» */
  at: number;
  obs: Observation[];
  /** повторный забор того же назначения (spec 2026-10-chapter-3, часть 39в): тропонин через час */
  repeat?: true;
}

/** Как назвать результат: повторный забор (часть 39в) — своим именем, «Тропонин через час». */
export const resultName = (exam: Id, repeat?: true): string => (repeat && db.exams[exam].repeat?.name.ru) || db.exams[exam].name.ru;

/** Всё, из чего строится вид приёма: у прототипа и у смены — свои источники. */
export interface CaseInput {
  version: number;
  patient: Patient;
  /** часы — минуты от полуночи */
  clock: number;
  minutesSpent: number;
  money: number;
  step: number;
  arrived: Arrival[];
  pending: { exam: Id; readyAt: number; repeat?: true }[];
  meanwhile: string[];
  urgent?: boolean;
  done: Id[];
  draft: Draft;
  decision?: Decision;
  canSendAway?: boolean;
  canStepOut?: boolean;
  bedside?: Record<Id, number>;
  /** аппараты у постели (часть 39а): лежит в смотровой приёмного — монитор; нет — в кабинете врача ничего */
  bedsideEquipment?: readonly Id[];
  targets?: string[];
  returnNote?: string;
  /** сложность: «Похоже на» — только у «Студента» (03-game-design.md §14); нет — «Студент» (прототип П4) */
  difficulty?: Difficulty;
  /** своя больница: обследования, которых здесь не сделать, — и почему (spec 2026-09-own-hospital) */
  unavailable?: Record<Id, string>;
  /** отделения больницы: из их болезней диагноз и «Похоже на» (часть 30); нет — терапия */
  departments?: readonly Id[];
  /** где лечить — что есть в этой больнице; нет — как в амбулатории: домой, в стационар, скорая */
  settings?: SettingOption[];
  payerNote?: string;
  payment?: string[];
  achievements?: string[];
  colleague?: { id: string; doctor: string; away?: boolean };
  byDoctor?: string;
}

export function hhmm(min: number): string {
  const m = Math.floor(min);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function patientName(p: Patient): string {
  const n = T.names;
  const first = p.sex === 'm' ? n.male : n.female;
  const surname = n.surnames[fnv1a(`${p.seed}:s`) % n.surnames.length];
  return `${p.sex === 'm' ? surname : n.feminine(surname)} ${first[fnv1a(`${p.seed}:f`) % first.length]}`;
}

/** Болезни, из которых выбирают диагноз: отделения больницы (с приёмным — и хирургия, часть 30); нет — терапия. */
export function candidates(departments: readonly Id[] = [DEPARTMENT]): Id[] {
  return Object.keys(db.conditions).filter(id => db.conditions[id].presenting && departments.includes(db.conditions[id].department));
}

/** Жалобы и всё, что пришло, — как для вывода. */
export function observationsOfCase(patient: Patient, arrived: readonly Arrival[]): Observation[] {
  return [...complaintObservations(patient), ...arrived.flatMap(a => a.obs)];
}

export function beliefsOf(patient: Patient, obs: readonly Observation[], departments?: readonly Id[]): Belief[] {
  return posterior(db, candidates(departments), obs, contextOf(db, patient, obs));
}

/** Противопоказание — фактор риска (аллергия) или состояние. */
export function riskName(id: Id): string {
  return db.risks[id]?.name.ru ?? db.conditions[id]?.name.ru ?? id;
}

/** Группа лечения для списка — по классу препарата; без класса — режим и советы. */
const TX_GROUPS: [string, string[]][] = [
  ['antibiotics', ['antibiotic']],
  ['antivirals', ['antiviral']],
  ['pain', ['analgesic', 'antimigraine']],
  ['breathing', ['bronchodilator', 'asthma', 'steroid.systemic']],
  // кислород через маску (spec 2026-10-chapter-3, часть 38б): при низкой сатурации; с частью 43в — маска CPAP
  ['oxygen', ['oxygen']],
  ['nose', ['nasal', 'steroid.intranasal', 'antihistamine']],
  // сердце и сосуды: с частью 33а — антикоагулянты, компрессионный трикотаж и гель при тромбофлебите;
  // с частью 33б — эпинефрин при анафилактическом шоке (АТХ C01CA24 — сердечно-сосудистая система);
  // с частью 39а — тромболизис при инфаркте; с частью 39г — статин (АТХ C10 — сердечно-сосудистая система);
  // с частью 42а — кардиоверсия, амиодарон и верапамил при фибрилляции предсердий; с частью 42в — атропин,
  // допамин и наружная стимуляция при АВ-блокаде; с частью 43в — фуросемид в вену при сердечной недостаточности;
  // с частью 43д — колхицин при перикардите
  ['heart', ['antihypertensive', 'antiplatelet', 'antianginal', 'anticoagulant', 'vascular', 'adrenergic', 'thrombolytic', 'lipid', 'antiarrhythmic', 'anticholinergic', 'diuretic', 'cardiac']],
  ['digestive', ['acid']],
  // растворы для питья и капельница (часть 32д-2): и при кишечной инфекции, и при обширном ожоге
  ['fluids', ['rehydration']],
  // с частью 41в — гемостатики: протромбиновый комплекс, витамин K1, транексамовая кислота
  ['metabolic', ['antidiabetic', 'hormone', 'mineral', 'hemostatic']],
  // травма (часть 32): гипсовая лонгета и закрытая репозиция
  ['trauma', ['immobilization']],
  // травма груди (часть 32в): плевральная пункция и дренирование
  ['drainage', ['drainage']],
  // раны (часть 32г-2): повязка, обработка со швом и без; анатоксин, вакцина, иммуноглобулины
  ['wounds', ['wound']],
  ['vaccines', ['vaccine']],
  // консультация нейрохирурга при кровоизлиянии (часть 41в), в том числе по телемедицине
  ['consult', ['consult']],
];

/** Порядок групп лечения — для решения и энциклопедии. */
export const TX_GROUP_ORDER = [...TX_GROUPS.map(([k]) => k), 'regimen'];

/** Группа по классу лечения; без класса — режим и советы. */
export function txGroupOfClass(cls: string | undefined): string {
  const c = cls ?? '';
  return TX_GROUPS.find(([, prefixes]) => prefixes.some(p => c === p || c.startsWith(`${p}.`)))?.[0] ?? 'regimen';
}

function txGroup(id: Id): string {
  return txGroupOfClass(db.treatments[id].class);
}

function groupTreatments(items: VisitView['treatments']): VisitView['treatmentGroups'] {
  const titles = T.spikes.decision.txGroup;
  return TX_GROUP_ORDER
    .map(key => ({ key, title: titles[key], items: items.filter(x => txGroup(x.id) === key) }))
    .filter(g => g.items.length > 0);
}

/**
 * Лечение по группам с предупреждениями о том, что уже известно, — для смены плана на обходе;
 * `bedside` — аппараты у его койки (часть 39а): в палате монитора нет, в ПИТ — у каждой койки.
 */
export function treatmentGroupsFor(obs: readonly Observation[], bedside: readonly Id[] = []): VisitView['treatmentGroups'] {
  return groupTreatments(treatmentChoices(obs, bedside));
}

export function conditionChoices(departments?: readonly Id[]): { id: Id; name: string }[] {
  return candidates(departments).map(id => ({ id, name: db.conditions[id].name.ru })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

export type DiagnosisGroup = { key: BodySystem; title: string; items: { id: Id; name: string }[] };

/** Диагнозы по системам органов — в порядке SYSTEMS; внутри — по алфавиту. */
export function diagnosisGroups(departments?: readonly Id[]): DiagnosisGroup[] {
  const all = conditionChoices(departments);
  return SYSTEMS
    .map(key => ({ key, title: T.spikes.decision.system[key], items: all.filter(c => db.conditions[c.id].system === key) }))
    .filter(g => g.items.length > 0);
}

/**
 * Выбор лечения: противопоказание, о котором пациент сказал, — предупреждение (`04` §8); лечению
 * у постели нужен его аппарат у постели (часть 39а) — без него кнопка серая, и сказано почему.
 */
function treatmentChoices(obs: readonly Observation[], bedside: readonly Id[] = []): VisitView['treatments'] {
  const known = knownFacts(db, obs);
  const knownIds = new Set([...known.risks, ...known.conditions]);
  // операцию выбирают не здесь, а «В операционную»: какая — по диагнозу (часть 28)
  return Object.values(db.treatments)
    .filter(x => x.kind !== 'surgery')
    .map(x => {
      const lack = bedsideLack(db, x.id, { bedside });
      if (lack) return { id: x.id, name: x.name.ru, warning: T.spikes.patient.noBedside(db.equipment[lack].gen.ru), disabled: true };
      const by = x.contraindications.find(k => knownIds.has(k.id));
      return { id: x.id, name: x.name.ru, warning: by ? T.spikes.patient.contraindicated(riskName(by.id)) : undefined };
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * Стенка инфаркта на ленте — из атрибута находки, как в её строке (часть 39а); у записи до появления
 * стенки — та, что строка называла тогда (`fallback` признака): нижняя.
 */
function wallOf(attr: string | undefined): Wall {
  const wall = attr ?? db.findings['ecg.st_elevation']?.fallback?.wall;
  return wall === 'anterior' || wall === 'lateral' ? wall : 'inferior';
}

/**
 * Снимок, лента и сектор УЗИ — по тому, что показало это обследование; частота на ленте — по
 * пульсу. `patientSeed` — зерно пациента: номера сломанных рёбер одни на обзорном снимке и на
 * снимке рёбер (часть 32в).
 */
function imageOf(exam: Id, obs: readonly Observation[], known: readonly Observation[], seed: number, patientSeed: number): ResultImage | undefined {
  const shown = (f: Id) => obs.find(o => o.f === f && o.shown);
  // сторона находки — из её атрибута, иначе — та, на которую жалуется пациент
  const complaintSide = [...obs, ...known].map(o => o.attrs?.side).find((x): x is 'right' | 'left' => x === 'right' || x === 'left') ?? 'right';
  const sideOf = (f: Id): 'right' | 'left' | undefined => {
    const o = shown(f);
    if (!o) return undefined;
    return o.attrs?.side === 'right' || o.attrs?.side === 'left' ? o.attrs.side : complaintSide;
  };
  if (exam === 'exam.xray_chest') {
    const side = shown('img.cxr_infiltrate')?.attrs?.side;
    // травма груди: смещение средостения — при напряжённом пневмотораксе или массивной крови
    const air = sideOf('img.cxr_pneumothorax');
    const blood = sideOf('img.cxr_hemothorax');
    const shift = shown('img.cxr_mediastinal_shift') !== undefined;
    const ribs = sideOf('img.xr_rib_fracture');
    return {
      kind: 'xray',
      ...(side === 'right' || side === 'left' || side === 'both' ? { infiltrate: side } : {}),
      hyperinflation: shown('img.cxr_hyperinflation') !== undefined,
      ...(air ? { pneumothorax: { side: air, size: shown('img.cxr_pneumothorax_large') ? 'large' : 'small', ...(shift && !blood ? { tension: true } : {}) } } : {}),
      ...(blood ? { effusion: { side: blood, ...(shown('img.cxr_hemothorax_large') || (shift && !air) ? { massive: true } : {}), ...(air ? { air: true } : {}) } } : {}),
      ...(ribs ? { ribFractures: { side: ribs, ribs: fracturedRibs(patientSeed, shown('img.xr_rib_multiple') !== undefined) } } : {}),
      ...(shown('img.cxr_wide_mediastinum') ? { wideMediastinum: true } : {}),
      // сердечная недостаточность (часть 43в): отёк лёгких — с застоем, застой — без него
      ...(shown('img.cxr_edema') ? { congestion: 'edema' as const } : shown('img.cxr_congestion') ? { congestion: 'congestion' as const } : {}),
      ...(shown('img.cxr_cardiomegaly') ? { cardiomegaly: true } : {}),
      seed,
    };
  }
  // КТ-ангиография груди (часть 43а): расслоение — интима в восходящей и нисходящей аорте (тип A) или
  // только в нисходящей (тип B), по виду в строке находки; тромбоэмболия (часть 43б) — тромбы в ветвях
  // лёгочного ствола по стороне в строке; без них — обычный срез
  if (exam === 'exam.cta_chest') {
    const dissection = shown('img.cta_aortic_dissection');
    const pe = shown('img.cta_pe')?.attrs?.side;
    return {
      kind: 'chestCt', seed, findings: {
        ...(dissection ? { dissection: dissection.attrs?.extent === 'b' ? 'b' : 'a' } : {}),
        ...(pe !== undefined ? { pe: pe === 'right' || pe === 'left' ? pe : 'both' } : {}),
      },
    };
  }
  if (exam === 'exam.ecg') {
    const pulse = known.find(o => o.f === 'vital.tachycardia' && o.value !== undefined)?.value;
    const stemi = shown('ecg.st_elevation');
    // фибрилляция или трепетание (часть 42а) — по виду в строке находки: пилообразные волны F; с частью
    // 42б — наджелудочковая тахикардия с узкими комплексами и желудочковая с широкими
    const af = shown('ecg.af');
    // АВ-блокада (часть 42в): Мобитц II или полная — с узким или широким выскальзывающим ритмом
    const avb = shown('ecg.av_block');
    const rhythm: EcgFindings['rhythm'] = af ? (af.attrs?.kind === 'flutter' ? 'flutter' : 'af') : shown('ecg.vt') ? 'vt' : shown('ecg.svt') ? 'svt'
      : avb ? (avb.attrs?.kind === 'mobitz2' ? 'avb2m' : 'avb3') : undefined;
    return {
      kind: 'ecg',
      seed,
      // на ленте — то же, что в строках находок: депрессия ST с инверсией T — в V4–V6
      ecg: {
        // пульс не мерили — у тахикардии и блокады лента со своей частотой, у остальных — 72 в минуту; у Мобитц II
        // 3 : 2 пульс — две трети частоты предсердий
        ...(pulse !== undefined ? { rate: Math.round(rhythm === 'avb2m' ? (pulse * 3) / 2 : pulse) } : rhythm && ['svt', 'vt', 'avb2m', 'avb3'].includes(rhythm) ? {} : { rate: 72 }),
        ...(rhythm ? { rhythm } : {}),
        // полная блокада — узкий или широкий выскальзывающий ритм; при фибрилляции предсердий он ровный
        ...(avb && avb.attrs?.kind !== 'mobitz2' ? { escape: avb.attrs?.kind === 'narrow' ? 'narrow' as const : 'wide' as const } : {}),
        ...(stemi ? { stemi: wallOf(stemi.attrs?.wall) } : {}),
        ...(shown('ecg.st_depression') ? { stDepression: true, tInversion: 'lateral' as const } : {}),
        ...(shown('ecg.lvh') ? { lvh: true } : {}),
        // перикардит (часть 43д): подъём ST почти везде с депрессией PQ; большой выпот — низкий вольтаж и альтернация
        ...(shown('ecg.pericarditis') ? { pericarditis: true } : {}),
        ...(shown('ecg.low_voltage') ? { lowVoltage: true } : {}),
      },
    };
  }
  if (exam === 'exam.xray_abdomen') {
    return { kind: 'abdomen', freeGas: shown('img.xr_free_gas') !== undefined, levels: shown('img.xr_bowel_levels') !== undefined, seed };
  }
  if (exam === 'exam.us_abdomen') {
    // что нашли, то и на картинке: отросток — «мишенью»; иначе желчный пузырь — с камнями и
    // утолщённой стенкой, если их показало УЗИ, или обычный
    if (shown('img.us_appendicitis')) return { kind: 'us', view: 'appendix', appendix: 0.8, seed };
    if (shown('img.us_diverticulitis')) return { kind: 'us', view: 'colon', diverticulum: 0.8, seed };
    return { kind: 'us', view: 'gallbladder', stones: shown('img.us_gallstones') ? 3 : 0, wall: shown('img.us_cholecystitis') ? 0.8 : 0, seed };
  }
  // почка (часть 30г): расширенная лоханка — если её показало УЗИ
  if (exam === 'exam.us_kidney') return { kind: 'us', view: 'kidney', pelvis: shown('img.us_hydronephrosis') ? 0.8 : 0, seed };
  // вены ноги (часть 33а): тромб в глубокой вене — на любом уровне, в подкожной, гематома надрыва
  if (exam === 'exam.us_leg_veins') {
    const deep = shown('img.us_dvt_prox') || shown('img.us_dvt_calf') || shown('img.us_dvt_iliac');
    return { kind: 'us', view: 'vein', deep: deep ? 1 : 0, superficial: shown('img.us_superficial_thrombus') ? 1 : 0, tear: shown('img.us_muscle_tear') ? 0.8 : 0, seed };
  }
  // артерии ноги (часть 33б): тот же срез бедра, в артерии — тромб или эмбол, если его показало УЗИ
  if (exam === 'exam.us_leg_arteries') return { kind: 'us', view: 'vein', arterial: shown('img.us_artery_occluded') ? 1 : 0, seed };
  // КТ головы (часть 40): кровь внутри черепа — светлое пятно в веществе на стороне находки; без
  // неё — обычный срез. С частью 41в — и КТ-ангиография (её первая серия — без контраста): гематома —
  // пятно по объёму, больше 30 см³ — со смещением срединных структур; кровь под паутинной оболочкой —
  // светлые борозды и щели
  if (exam === 'exam.ct_head' || exam === 'exam.cta_head') {
    const hematoma = shown('img.ct_hematoma_large') ?? shown('img.ct_hematoma');
    const sah = shown('img.ct_sah') !== undefined;
    const blood = shown('img.ct_blood') ? sideOf('img.ct_blood') : undefined;
    const side = hematoma ? sideOf(hematoma.f) : !sah ? blood : undefined;
    // площадь пятна на срезе — как объём в степени 2/3; 80 см³ — наибольшее
    const size = hematoma?.value !== undefined ? Math.min(1, Math.max(0.15, (hematoma.value / 80) ** (2 / 3))) : 0.45;
    const shift = hematoma?.value !== undefined && hematoma.value >= 30 ? Math.min(1, (hematoma.value - 20) / 60) : 0;
    return {
      kind: 'head', seed,
      findings: {
        ...(side ? { focus: { density: 'high' as const, shape: 'blob' as const, side, region: 'middle' as const, size } } : {}),
        ...(side && shift > 0 ? { shift } : {}),
        ...(sah ? { sah: 0.7 } : {}),
      },
    };
  }
  // кости (часть 32): что нашёл рентгенолог — линия перелома, смещение, признаки нестабильности;
  // сторона — из жалобы или находки
  const bone = BONE_EXAMS[exam];
  if (bone) {
    const fractures: BoneFracture[] = [];
    for (const [f, fracture] of bone.fractures) if (shown(f)) fractures.push(...fracture);
    // рёбра (часть 32в): номера — от зерна пациента, как на обзорном снимке; три и больше — соседние
    const ribs = fractures.some(x => x.site === 'rib') ? fracturedRibs(patientSeed, shown('img.xr_rib_multiple') !== undefined) : [];
    const all = [...fractures.filter(x => x.site !== 'rib'), ...ribs.map(rib => ({ site: 'rib' as const, rib, displacement: 0.3 }))];
    // одно место — одна запись: сильнее смещение — то, что видно
    const bySite = new Map<string, BoneFracture>();
    for (const x of all) {
      const key = x.rib !== undefined ? `${x.site}${x.rib}` : x.site;
      if ((bySite.get(key)?.displacement ?? -1) < (x.displacement ?? 0)) bySite.set(key, x);
    }
    // выпот в колене (часть 32д) — если его показал снимок
    const effusion = bone.effusion !== undefined && shown(bone.effusion) !== undefined;
    return { kind: 'bone', view: bone.view, side: complaintSide, fractures: [...bySite.values()], ...(effusion ? { effusion } : {}), seed };
  }
  return undefined;
}

/**
 * Снимки костей (часть 32): вид и что рисует каждая находка — линия перелома, смещение (0–1),
 * нестабильный перелом: у лучевой — сильнее смещение, у голеностопа — обе лодыжки и сдвиг таранной;
 * `effusion` — находка выпота в суставе (колено, часть 32д).
 */
const BONE_EXAMS: Record<Id, { view: BoneFindings['view']; fractures: [Id, BoneFracture[]][]; effusion?: Id }> = {
  'exam.xray_wrist': {
    view: 'wrist',
    fractures: [
      ['img.xr_radius_fracture', [{ site: 'radius', displacement: 0 }]],
      ['img.xr_radius_displaced', [{ site: 'radius', displacement: 0.55 }]],
      ['img.xr_radius_unstable', [{ site: 'radius', displacement: 1 }]],
      ['img.xr_ulnar_styloid', [{ site: 'ulnar_styloid', displacement: 0.4 }]],
    ],
  },
  'exam.xray_ankle': {
    view: 'ankle',
    fractures: [
      ['img.xr_ankle_fracture', [{ site: 'fibula', displacement: 0 }]],
      ['img.xr_ankle_unstable', [{ site: 'fibula', displacement: 0.8 }, { site: 'medial_malleolus', displacement: 0.8 }]],
    ],
  },
  // часть 32д: надколенник — поперечная линия; разошлись отломки — верхний ушёл вверх; выпот
  'exam.xray_knee': {
    view: 'knee',
    fractures: [
      ['img.xr_patella_fracture', [{ site: 'patella', displacement: 0 }]],
      ['img.xr_patella_displaced', [{ site: 'patella', displacement: 0.9 }]],
    ],
    effusion: 'img.xr_knee_effusion',
  },
  // часть 32б: основание пятой плюсневой, шейка бедра, ключица — смещение как в прототипах части 31
  'exam.xray_foot': {
    view: 'foot',
    fractures: [
      ['img.xr_mt5_fracture', [{ site: 'mt5', displacement: 0 }]],
      ['img.xr_mt5_displaced', [{ site: 'mt5', displacement: 0.6 }]],
    ],
  },
  'exam.xray_hip': {
    view: 'hip',
    fractures: [
      ['img.xr_femoral_neck_fracture', [{ site: 'femoral_neck', displacement: 0 }]],
      ['img.xr_femoral_neck_displaced', [{ site: 'femoral_neck', displacement: 0.9 }]],
    ],
  },
  'exam.xray_clavicle': {
    view: 'clavicle',
    fractures: [
      ['img.xr_clavicle_fracture', [{ site: 'clavicle', displacement: 0 }]],
      ['img.xr_clavicle_displaced', [{ site: 'clavicle', displacement: 0.9 }]],
    ],
  },
  // часть 32в: снимок рёбер — перелом со ступенькой; сколько рёбер и какие — по зерну пациента
  'exam.xray_ribs': {
    view: 'ribs',
    fractures: [
      ['img.xr_rib_fracture', [{ site: 'rib' }]],
      ['img.xr_rib_multiple', [{ site: 'rib' }]],
    ],
  },
};

/** «Студенту» — до пяти гипотез с частотой (03-game-design.md §14). */
const HINTS = 5;

/**
 * Правила решения к жалобе пациента (часть 32): есть признак правила — что оно велит («Снимок
 * нужен: …»); проверили все и ни одного — «перелом маловероятен»; иначе — что осталось проверить.
 * С части 32г — и дополнительные признаки, возраст и «правило не применяется».
 */
function rulesOf(p: Patient, obs: readonly Observation[]): VisitView['rules'] {
  const t = T.spikes.patient;
  const names = (ids: Id[]) => ids.map(f => lowerFirst(db.findings[f].name.ru));
  const known = knownOf(obs);
  return rulesFor(db, p).map(r => {
    const x = checkRule(r, p, known);
    const age = r.age?.main !== undefined ? t.ruleAgeOver(r.age.main) : r.age?.from !== undefined ? t.ruleAgeFrom(r.age.from) : undefined;
    const main = [...names(x.main), ...(x.ageMain && age ? [age] : [])];
    const minor = [...names(x.minor), ...(x.ageMinor && r.age?.minor ? [t.ruleAgeRange(r.age.minor[0], r.age.minor[1])] : [])];
    // шкала с баллами (часть 41б): сколько набрано и за какие пункты
    const counted = (r.points?.items ?? []).filter(i => known(i.f) === true && !(i.unless ?? []).some(u => known(u) === true)).map(i => i.f);
    // возраст — по своей полосе, пол — если за него балл (часть 42а: CHA₂DS₂-VASc)
    const band = r.points ? ageBand(r.points, p.age) : undefined;
    const byAge = band ? [band.to !== undefined ? t.ruleAgeRange(band.from, band.to) : t.ruleAgeFrom(band.from)] : [];
    const bySex = r.points?.sex?.[p.sex] ? [t.ruleSex(p.sex)] : [];
    const scored = r.points && x.points ? t.rulePoints(x.points.min, [...byAge, ...bySex, ...names(counted)].join(', ')) : undefined;
    const why = scored ?? (main.length > 0 ? main.join(', ') : t.ruleMinor(minor.join(', ')));
    const no = x.points && x.points.min === x.points.max && x.applies !== false ? t.rulePointsNo(x.points.min, r.texts.no.ru) : r.texts.no.ru;
    const text =
      x.verdict === 'yes' ? t.ruleYes(r.texts.yes.ru, why)
      : x.verdict === 'no' ? (x.applies === false ? r.texts.na?.ru ?? r.texts.no.ru : no)
      : t.ruleCheck(names(x.left).join(', '));
    return { id: r.id, name: r.name.ru, text };
  });
}

export function makeCaseView(c: CaseInput): VisitView {
  const p = c.patient;
  const line = (o: Observation): Line => ({
    f: o.f,
    shown: o.shown,
    exam: o.exam,
    text: o.exam === 'complaint' ? complaintText(db, o, p.sex, p.seed) : observationText(db, o, p.sex, p.seed),
  });
  // уточнения, которых нет, отдельной строкой не пишутся (часть 32в): у такого признака нет текста
  // «нет» — «пневмоторакса нет» скажет основной признак, а «средостение не смещено» уже лишнее
  const visible = (o: Observation) => o.shown || (db.findings[o.f]?.texts.absent?.length ?? 0) > 0;
  const obs = observationsOfCase(p, c.arrived);
  const treatments = treatmentChoices(obs, c.bedsideEquipment);
  return {
    version: c.version,
    title: `${patientName(p)}, ${T.spikes.patient.years(p.age)}, ${p.sex === 'm' ? T.spikes.patient.male : T.spikes.patient.female}`,
    portrait: { key: fnv1a(`${p.seed}:portrait`), sex: p.sex, age: p.age, complaints: p.complaints },
    clock: hhmm(c.clock),
    minutesSpent: c.minutesSpent,
    money: c.money,
    complaints: complaintObservations(p).map(line),
    results: c.arrived.flatMap(a => a.obs).filter(visible).map(line),
    groups: c.arrived
      .map((a, i) => {
        const image = imageOf(a.exam, a.obs, obs, fnv1a(`${p.seed}:${a.exam}`), p.seed);
        return { key: `${i}:${a.exam}`, exam: a.exam, name: resultName(a.exam, a.repeat), at: hhmm(a.at), fresh: c.step > 0 && a.step === c.step, lines: a.obs.filter(visible).map(line), ...(image ? { image } : {}) };
      })
      .reverse(),
    freshCount: c.arrived.filter(a => c.step > 0 && a.step === c.step).reduce((n, a) => n + a.obs.filter(visible).length, 0),
    pending: c.pending.map(x => ({ exam: x.exam, name: resultName(x.exam, x.repeat), at: hhmm(x.readyAt) })),
    meanwhile: c.meanwhile,
    ...(c.urgent ? { urgent: true } : {}),
    done: c.done,
    unavailable: c.unavailable ?? {},
    settings: c.settings ?? (['home', 'ward', 'ambulance'] as const).map(key => ({ key, title: T.spikes.patient.setting[key] })),
    // «0 из 10» ничего не подсказывает — такие не показываем, первую — всегда
    diagnoses: diagnosisGroups(c.departments),
    hints: c.difficulty === 'doctor' ? [] : beliefsOf(p, obs, c.departments).slice(0, HINTS)
      .map(b => ({ id: b.id, name: db.conditions[b.id].name.ru, outOf10: Math.round(b.p * 10) }))
      .filter((h, i) => i === 0 || h.outOf10 > 0),
    rules: c.difficulty === 'doctor' ? [] : rulesOf(p, obs),
    treatments,
    treatmentGroups: groupTreatments(treatments),
    draft: c.draft,
    draftDiagnosisName: c.draft.diagnosis ? db.conditions[c.draft.diagnosis].name.ru : undefined,
    ...(c.canSendAway ? { canSendAway: true } : {}),
    ...(c.canStepOut ? { canStepOut: true } : {}),
    ...(c.bedside ? { bedside: c.bedside } : {}),
    ...(c.targets && c.targets.length > 0 ? { targets: c.targets } : {}),
    ...(c.returnNote ? { returnNote: c.returnNote } : {}),
    ...(c.payerNote ? { payerNote: c.payerNote } : {}),
    ...(c.payment ? { payment: c.payment } : {}),
    ...(c.achievements && c.achievements.length > 0 ? { achievements: c.achievements } : {}),
    ...(c.colleague ? { colleague: c.colleague } : {}),
    ...(c.byDoctor ? { byDoctor: c.byDoctor } : {}),
    decision: c.decision,
  };
}

/** Итог и разбор закрытого случая — словами (`04` §10). */
export function decisionOf(x: {
  patient: Patient; arrived: readonly Arrival[]; diagnosis: Id; verdict: Decision['verdict']; confidence: number;
  plan: { treatments: Id[]; setting: Setting }; ev: PlanEval; outcome: Outcome; score: CaseScore; review: ReviewData;
  targets?: readonly TargetResult[];
  /** до решения сняли фибрилляцию желудочков разрядом под монитором (часть 39б) */
  arrest?: boolean;
}): Decision {
  const t = T.spikes.patient;
  const p = x.patient;
  const cond = db.conditions[p.truth.conditions[0].id];
  const outOf10 = (v: number) => Math.round(v * 10);
  const seen = x.arrived.flatMap(a => a.obs);
  const keys = ['accuracy', 'defensibility', 'thrift', 'treatment', 'setting', 'safety'] as const;
  return {
    diagnosis: x.diagnosis,
    verdict: x.verdict,
    truth: cond.id,
    truthName: cond.name.ru,
    outOf10: outOf10(x.confidence),
    pearls: (cond.pearls ?? []).map(v => v.ru),
    causes: p.truth.findings
      .filter(f => seen.some(o => o.f === f.f && o.shown) || p.complaints.includes(f.f))
      .map(f => ({ finding: db.findings[f.f].name.ru, cause: f.cause === 'leak' ? t.causeLeak : (db.conditions[f.cause]?.name.ru ?? db.risks[f.cause]?.name.ru ?? f.cause) })),
    outcome: `${x.arrest ? `${t.outcome.arrest}. ` : ''}${outcomeText(x.outcome, x.plan.setting, p.sex === 'f')}`,
    grades: keys.map(k => ({ key: k, label: t.grade[k], grade: x.score[k] })),
    overall: x.score.overall,
    notes: x.score.notes.map(noteText),
    ...(x.targets && x.targets.length > 0
      ? { targets: { grade: worstGrade(x.targets.map(r => r.grade)), lines: x.targets.map(r => targetLineOf(r)) } }
      : {}),
    // не лекарство — «лечение выбора» (часть 32)
    plan: x.ev.roles.map(r => ({ name: db.treatments[r.tx].name.ru, role: (db.treatments[r.tx].kind !== 'drug' ? t.roleTx[r.role] : undefined) ?? t.role[r.role] })),
    settingName: t.setting[x.plan.setting],
    rational: t.rationalLine(
      x.review.rational.exams.length > 0 ? x.review.rational.exams.map(e => db.exams[e].name.ru).join(', ') : t.rationalNone,
      x.review.rational.minutes, T.common.rub(x.review.rational.money), db.conditions[x.review.rational.diagnosis].name.ru),
    idle: x.review.idle.map(e => db.exams[e].name.ru),
    timeline: x.review.timeline.map(v => ({ label: v.exam === 'complaint' ? t.timelineComplaints : db.exams[v.exam].name.ru, truth: outOf10(v.truth), chosen: outOf10(v.chosen) })),
  };
}

/** Строка срока в разборе: от прихода или (часть 39б) от находки — словами записи. */
function targetLineOf(r: TargetResult): string {
  const target = db.targets[r.id];
  const t = T.spikes.patient;
  return target?.texts.from && target.texts.after
    ? t.targetLine(target.name.ru, r.minutes, r.limit, target.texts.from.ru, target.texts.after.ru)
    : t.targetLine(target?.name.ru ?? r.id, r.minutes, r.limit);
}

export function outcomeText(outcome: Outcome, setting: Setting, female: boolean): string {
  const out = T.spikes.patient.outcome;
  // переведённый в сосудистый центр с подъёмом ST (часть 39б): как открыли артерию, и чем кончилось
  if (outcome.rsc) {
    const r = out.rsc;
    const how = `${r[outcome.rsc.by](outcome.rsc.hours)}${outcome.rsc.loss >= 100 ? `; ${r.late}` : ''}`;
    if (outcome.kind === 'died') return `${how}. ${r.died(outcome.day, female)}`;
    return `${outcome.severe ? r.severe(female) : r.transferred(female)}. ${how}`;
  }
  switch (outcome.kind) {
    // острый период позади (часть 41а): у инсульта — с последствиями или без
    case 'recovered': return outcome.settled === 'clear' ? out.settledClear(outcome.day) : outcome.settled === 'residual' ? out.settledResidual(outcome.day) : out.recovered(outcome.day, female);
    case 'improved': return out.improved(female);
    case 'unchanged': return out.unchanged;
    case 'worse':
      if (outcome.returns?.as && outcome.harmBy) return out.worseAfter(outcome.day, lowerFirst(db.conditions[outcome.returns.as]?.name.ru ?? ''), db.treatments[outcome.harmBy]?.name.ru ?? outcome.harmBy);
      return outcome.returns?.as ? out.worseAs(outcome.day, lowerFirst(db.conditions[outcome.returns.as]?.name.ru ?? '')) : out.worse(outcome.day);
    case 'reaction': return outcome.reaction ? out.reaction(db.treatments[outcome.reaction.tx].name.ru, riskName(outcome.reaction.by)) : out.unchanged;
    case 'transferred':
      if (outcome.severe) return out.transferredSevere(female);
      return setting === 'ambulance' ? out.ambulance : setting === 'admit' || setting === 'surgery' || setting === 'icu' ? out.transferred(female) : out.ward(female);
    // своя палата интенсивной терапии (spec 2026-10-chapter-3, часть 38а)
    case 'admitted': return setting === 'surgery' ? out.operated : setting === 'icu' ? out.icu : out.admitted;
    case 'died': return out.died(outcome.day, female);
  }
}

/**
 * Условие по скрытому параметру словами: «при тяжёлом течении», «при ишемии кишки». Подпись —
 * по паре «параметр:значение», иначе по значению (тяжесть одна у многих болезней); без подписи
 * значение не показываем — «yes» в статье хуже, чем ничего.
 */
export function whenText(when: Record<string, string[]> | undefined): string | undefined {
  if (!when) return undefined;
  const words = Object.entries(when).flatMap(([name, values]) => {
    // подпись набора значений (часть 41а): гемипарез при инсульте — «при слабости в руке и ноге», а не
    // четыре шаблона выпадений подряд
    const set = values.length > 1 ? T.encyclopedia.when[`${name}:${[...values].sort().join('|')}`] : undefined;
    return set !== undefined ? [set] : values.map(v => T.encyclopedia.when[`${name}:${v}`] ?? T.encyclopedia.when[v]);
  }).filter((w): w is string => w !== undefined);
  // несколько значений (часть 30д): «при инфильтрате, абсцессе и перитоните» — «при» один раз
  return words.length <= 1 ? words[0] : T.encyclopedia.whenList(words);
}

export function noteText(n: ScoreNote): string {
  const t = T.spikes.patient.note;
  const tx = (id: Id) => db.treatments[id].name.ru;
  switch (n.code) {
    case 'tx.harmful': return t.harmful(tx(n.tx));
    case 'tx.notIndicated': return t.notIndicated(tx(n.tx));
    case 'tx.acceptable': return db.treatments[n.tx].kind === 'drug' ? t.acceptable(tx(n.tx)) : t.acceptableTx(tx(n.tx));
    case 'tx.noCure': return t.noCure;
    case 'tx.none': return t.none;
    case 'tx.preHospitalMissing': return t.preHospitalMissing(tx(n.tx));
    case 'tx.preventMissing': return t.preventMissing(tx(n.tx));
    // обязательное при лечении здесь (часть 38б): «обязательно при сатурации ниже 90 %»
    case 'tx.requireMissing': return t.requireMissing(tx(n.tx), whenText(n.when));
    // обязательное и при переводе (часть 39а): «при инфаркте с подъёмом ST в первые 12 часов»
    case 'tx.beforeTransferMissing': return t.beforeTransferMissing(tx(n.tx), whenText(n.when));
    case 'tx.companionMissing': return t.companionMissing(tx(n.tx), tx(n.of));
    // окно закрылось, пока шло обследование (часть 41а): тромболизис при инсульте
    case 'tx.windowMissed': return t.windowMissed(tx(n.tx), n.at);
    case 'setting.under': return t.settingUnder(n.recommended);
    case 'setting.over': return t.settingOver(n.recommended);
    case 'safety.knownViolation': return t.knownViolation(tx(n.tx), riskName(n.by));
    case 'safety.unaskedViolation': return t.unaskedViolation(tx(n.tx), riskName(n.by));
    case 'safety.notAsked': return t.notAsked(riskName(n.by));
    case 'safety.redFlagIgnored': return t.redFlagIgnored(db.findings[n.f].name.ru);
    case 'safety.redFlagUnchecked': return t.redFlagUnchecked(db.findings[n.f].name.ru);
    case 'thrift.over': return t.thriftOver(n.times);
    case 'triage.under': return t.triageUnder(n.triage, n.news2, n.flag && db.findings[n.flag]?.name.ru);
    case 'triage.over': return t.triageOver(n.triage, n.news2, n.flag && db.findings[n.flag]?.name.ru);
    case 'op.onTime': return t.opOnTime(tx(n.tx), n.hours, n.window, n.onset === true, n.observed === true);
    case 'op.late': return t.opLate(tx(n.tx), n.hours, n.window, n.onset === true, n.observed === true);
    case 'op.complication': return t.opComplication(tx(n.tx));
    case 'op.complicated': return t.opComplicated(db.conditions[n.of]?.complication?.name.ru ?? n.of, n.hours, n.before);
  }
}

/**
 * Обследования по разделам действий карты пациента — те, что ему подходят по полу, возрасту и
 * жалобе: о месячных и беременности мужчину не спрашивают, о травме головы — без травмы головы.
 */
export function examsByAction(patient: Pick<Patient, 'sex' | 'age' | 'complaints'>): Record<'ask' | 'examine' | 'order', Id[]> {
  // по названию; в «Спросить» сначала расспрос о жалобах по системам, потом анамнез жизни
  const byName = (a: Id, b: Id) => (db.exams[a].name.ru < db.exams[b].name.ru ? -1 : 1);
  const history = (id: Id) => (db.exams[id].checks.every(c => c.f.startsWith('hx.')) ? 1 : 0);
  const ids = Object.keys(db.exams).filter(id => examFits(db.exams[id], patient)).sort(byName);
  return {
    ask: ids.filter(id => db.exams[id].kind === 'ask').sort((a, b) => history(a) - history(b) || byName(a, b)),
    examine: ids.filter(id => ['physical', 'bedside'].includes(db.exams[id].kind)),
    order: ids.filter(id => ['lab', 'rapid', 'imaging', 'functional'].includes(db.exams[id].kind)),
  };
}

export function examInfo(id: Id): { name: string; minutes: number; cost: number } {
  const e = db.exams[id];
  return { name: e.name.ru, minutes: e.time.procedure + (e.time.report ?? 0) + (e.time.turnaround ?? 0), cost: e.cost };
}

/** «Что это?» о признаке: объяснение и чем его выявляют. */
export function findingInfo(id: Id): TermInfo {
  const f = db.findings[id];
  const by = (db.revealedBy[id] ?? []).map(e => db.exams[e].name.ru);
  return {
    id,
    title: f.name.ru,
    text: f.texts.hint ? [f.texts.hint.ru] : [],
    list: by.length > 0 ? { label: T.spikes.patient.revealedBy, items: by } : undefined,
  };
}

/** «Что это?» об обследовании: как делают, что показывает, какие признаки проверяет. */
export function examTerm(id: Id): TermInfo {
  const e = db.exams[id];
  return {
    id,
    title: e.name.ru,
    text: [e.texts.summary.ru, ...(e.texts.hint ? [e.texts.hint.ru] : [])],
    list: { label: T.spikes.patient.checks, items: e.checks.map(c => db.findings[c.f].name.ru) },
  };
}

/** «Что это?» о лечении. */
export function treatmentTerm(id: Id): TermInfo {
  const x = db.treatments[id];
  return { id, title: x.name.ru, text: [x.texts.hint.ru] };
}

/** «Что это?» о болезни — только общее описание из энциклопедии. */
export function conditionTerm(id: Id): TermInfo {
  const c = db.conditions[id];
  return { id, title: c.name.ru, text: [c.texts.summary.ru] };
}
