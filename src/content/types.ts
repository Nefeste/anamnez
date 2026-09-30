// Типы собранной медицинской базы (`docs/07-data-model.md` §1).
//
// Исходник — YAML в content/, собирает tools/content/build.ts. Здесь — то, что получает
// движок: полосы частот уже переведены в целые доли 1/10 000, ссылки проверены.
// Движок принимает базу параметром (ContentDb) и сам её не загружает — поэтому тесты
// подставляют маленькие базы, а приложение — собранную.

export type Id = string;
/** Вероятность в долях 1/10 000. */
export type P = number;

export interface Text {
  ru: string;
  en?: string;
}

export type Review = 'draft' | 'checked' | 'reviewed';

export interface Source {
  kind: 'guideline' | 'textbook' | 'paper' | 'review' | 'dataset' | 'score';
  title: string;
  org?: string;
  year?: number;
  url?: string;
  note?: string;
}

/** Откуда брать значение атрибута признака: параметр случая, распределение или константа. */
export type AttrSpec = { param: string } | { dist: Record<string, number> } | { value: string };

/** Связь «причина → признак» (noisy-OR, ADR 0009). */
export interface Link {
  f: Id;
  p: P;
  /** на каких стадиях связь действует; нет — на всех */
  stages?: string[];
  /** условие по скрытым параметрам случая: параметр → допустимые значения */
  when?: Record<string, string[]>;
  attrs?: Record<string, AttrSpec>;
}

/** Где лечить: дома, направить в стационар, вызвать скорую (перевод). */
/**
 * Место лечения. В базе — что нужно пациенту: дома, стационар, срочно в стационар, операция,
 * центр, которого в районе нет. У врача — что он выбрал: домой, направить в стационар,
 * вызвать скорую, в свою палату, в свою операционную, перевести (spec 2026-09-chapter-2,
 * «Место лечения»).
 */
export type Setting = 'home' | 'ward' | 'ambulance' | 'admit' | 'surgery' | 'transfer';

/** Система органов в порядке показа: простуда и ЛОР, лёгкие, сердце, живот, мочевые, обмен, голова и спина, кости и суставы (часть 32). */
export const SYSTEMS = ['airways', 'lungs', 'heart', 'digestive', 'urinary', 'metabolic', 'nerves', 'bones', 'skin'] as const;
export type BodySystem = (typeof SYSTEMS)[number];

/** Тактика при состоянии (`04-medical-model.md` §8). */
export interface Tactics {
  firstLine: Id[];
  acceptable: Id[];
  supportive: Id[];
  notIndicated: Id[];
  harmful: Id[];
  /** типичное назначение целиком, если первая линия — выбор из равных; нет — вся первая линия */
  plan?: Id[];
  /**
   * обязательная профилактика (часть 32г-2): без неё лечение неполное, даже если рана зажила, —
   * анатоксин столбнячный, если прививка просрочена; вакцина от бешенства после укуса
   */
  prevent?: Id[];
  /**
   * что сделать до приезда скорой (часть 32д-2): в записи — только у тактики по параметру,
   * `tacticsFor` собирает его по значениям; без него у того, что лечат не дома, — первая линия
   * (`preHospitalOf`)
   */
  preHospital?: Id[];
  /**
   * тактика по скрытому параметру (spec 2026-09-chapter-2, часть 32): при таких значениях у
   * названных лечений — эта роль, у остальных — из общих списков; своё типичное назначение
   */
  byParam?: TacticsByParam[];
  setting: {
    default: Setting;
    /** уточнение по скрытому параметру случая */
    param?: { name: string; map: Record<string, Setting> };
    /** если у пациента есть красный флаг этого состояния */
    redFlag?: Setting;
    /** если у пациента есть фактор риска */
    risks?: { id: Id; setting: Setting }[];
    /**
     * ещё места, которые при этих значениях не ошибка (часть 32б): изолированный перелом ключицы
     * со смещением — показание к операции относительное, повязка дома тоже можно
     */
    also?: { when: Record<string, string[]>; settings: Setting[] }[];
  };
}

/** Тактика при значениях скрытого параметра: перелом со смещением — репозиция, без смещения — лонгета. */
export interface TacticsByParam {
  when: Record<string, string[]>;
  firstLine: Id[];
  acceptable: Id[];
  supportive: Id[];
  notIndicated: Id[];
  harmful: Id[];
  plan?: Id[];
  /** обязательная профилактика при этих значениях — вдобавок к общей (часть 32г-2) */
  prevent?: Id[];
  /**
   * что сделать до приезда скорой при этих значениях — хоть одно из этого (часть 32д-2): у
   * обширного ожога место по умолчанию — дом, а до перевода нужна капельница
   */
  preHospital?: Id[];
}

/** Лечение — группа или МНН без доз (ADR 0012). */
export interface Treatment {
  id: Id;
  name: Text;
  kind: 'drug' | 'regimen' | 'procedure' | 'surgery';
  class?: string;
  route?: 'oral' | 'inhaled' | 'nasal' | 'iv' | 'im' | 'sc';
  cost: number;
  /** cure — действует на причину: к выздоровлению с вероятностью p за days дней */
  effects: Effect[];
  /** reaction — вероятность вреда, если назначить при этом противопоказании */
  contraindications: { id: Id; level: 'relative' | 'absolute'; reaction: P }[];
  /** операция (spec 2026-09-chapter-2, часть 28): помещение, бригада, аппараты — все сразу, минуты, осложнений при среднем навыке хирурга */
  surgery?: Surgery;
  texts: { hint: Text };
  sources: Source[];
  review: Review;
}

/**
 * Действие лечения на состояние. `when` (часть 30в) — только при таких значениях скрытых параметров
 * болезни: неоперативное лечение непроходимости помогает, если нет ишемии кишки.
 */
export interface Effect {
  on: Id;
  kind: 'cure' | 'relieve';
  p: P;
  days: [number, number];
  when?: Record<string, string[]>;
}

export interface Surgery {
  room: Id;
  team: Id[];
  equipment: Id[];
  minutes: number;
  complications: P;
  /** умерли в стационаре после операции (spec 2026-09-chapter-2, часть 28б) */
  death?: P;
  /** в осложнённой стадии болезни на момент разреза — свои доли */
  complicated?: { complications: P; death?: P };
  /** каждый полный час от поступления до разреза выживаемость ниже на столько (часть 30б, Buck 2013) */
  delay?: P;
}

/**
 * Осложнённая стадия (часть 28б): без действенного лечения наступает по часам от начала болезни —
 * по риску (за первые `early.hours` часов с долей `early.p`, дальше — `later.p` за каждые
 * `later.every` часов) или по сроку `after` (часть 30б).
 */
export interface Complication {
  name: Text;
  /** по риску: за первые `early.hours` часов — `early.p`, дальше `later.p` за каждые `later.every` */
  early?: { hours: number; p: P };
  later?: { every: number; p: P };
  /** по сроку: наступает наверняка через столько часов от начала болезни (часть 30б) */
  after?: number;
  /** стадия бывает только при таких значениях скрытых параметров (часть 30в: некроз — при ишемии кишки) */
  when?: Record<string, string[]>;
  /** срок стационара после операции в этой стадии, сутки */
  stay?: [number, number];
}

/**
 * Операция болезни (часть 28): какая и за сколько часов, чтобы не поздно. С частью 30в — срок
 * `observe`, если экстренной операции не нужно и лечат в палате, и свой стационар после операции.
 */
export interface ConditionSurgery {
  tx: Id;
  /** операция по скрытому параметру (часть 32б): перелом шейки бедра без смещения — винты, со смещением — эндопротез */
  byParam?: { when: Record<string, string[]>; tx: Id }[];
  /** нет — в рекомендации срока нет: закрытый нестабильный перелом оперируют в эту госпитализацию (часть 32) */
  window?: number;
  from?: 'onset';
  /** нужды в экстренной операции нет, лечат в палате: не помогло — операция не позже стольких часов от поступления */
  observe?: number;
  /** стационар после операции, сутки от суток операции */
  stay?: [number, number];
}

export interface Stage {
  id: string;
  days: [number, number];
  /** стадия наступает только при эффективном лечении (разрешение пневмонии) */
  needs?: 'treatment';
}

export interface Condition {
  id: Id;
  name: Text;
  icd10?: string;
  department: Id;
  /** состояния с одинаковой тактикой: путаница внутри группы — частичная точность (`04` §10) */
  group?: Id;
  /** система органов — для списков диагнозов и энциклопедии */
  system?: BodySystem;
  kind: 'disease' | 'injury' | 'syndrome' | 'state';
  severity: 'minor' | 'moderate' | 'serious' | 'critical';
  /** выпадает ли основным заболеванием (false — только сопутствующим) */
  presenting: boolean;
  /** бывает без жалоб — находят на профосмотре; остальные приходят с заметным симптомом */
  checkup?: boolean;
  /** относительный вес распространённости (из полосы) */
  weight: number;
  age: { min: number; max: number; peak?: [number, number] };
  sex?: { m: number; f: number };
  season?: Record<Season, number>;
  /** множители веса от факторов риска и сопутствующих состояний */
  risks?: { id: Id; x: number }[];
  /** без этих состояний не бывает (обострение ХОБЛ — только при ХОБЛ) */
  requires?: Id[];
  /** не бывает у того, у кого уже есть эти (впервые выявленная гипертензия — не у гипертоника) */
  excludes?: Id[];
  /** как часто бывает сопутствующим (хроническим) */
  chronic?: { p: P; ageMin?: number; risks?: { id: Id; x: number }[] };
  params?: Record<string, Record<string, number>>;
  /**
   * производные параметры (spec 2026-09-chapter-2, часть 32г): значение — «yes», если правило
   * решения выполнено на настоящих признаках и возрасте пациента, иначе «no»; доли в `params` —
   * для вывода, пока признаки правила не известны
   */
  derived?: Record<string, Id>;
  stages: Stage[];
  /** в какие дни болезни обычно обращаются: [от, до] */
  presentation?: [number, number];
  findings: Link[];
  confirm: Id[] | 'clinical';
  redFlags?: Id[];
  /** с чем спутать по рекомендации (часть 33б) — вдобавок к похожим по признакам */
  differential?: Id[];
  /** проходит само, без лечения */
  selfLimiting?: boolean;
  /** проходит само только при этих значениях скрытого параметра (часть 30д: неосложнённый дивертикулит) */
  selfLimitingWhen?: Record<string, string[]>;
  /** без действенного лечения: вероятность ухудшения и на какой день; `when` — при каких значениях параметра (часть 30д) */
  untreated?: { p: P; days: [number, number]; when?: Record<string, string[]> };
  /** в стационаре при действенном лечении: через сколько суток можно выписывать */
  stay?: [number, number];
  /** лечат операцией (часть 28): какой и за сколько часов от поступления, чтобы не поздно */
  /** срок `window` часов — от поступления или, с `from: 'onset'`, от начала болезни (часть 30) */
  surgery?: ConditionSurgery;
  /** осложнённая стадия (часть 28б): перфорация аппендикса */
  complication?: Complication;
  /** тактика; есть у всех, с чем приходят (валидатор) */
  treatment?: Tactics;
  texts: { summary: Text };
  pearls?: Text[];
  sources: Source[];
  review: Review;
}

export interface NumericSpec {
  unit: string;
  ref: [number, number];
  /** диапазон значения, когда признак есть и когда нет */
  present: [number, number];
  absent: [number, number];
  decimals: number;
  /** производные числа для шаблона: {dia} = значение × множитель */
  derived?: Record<string, number>;
  /**
   * Порог на измерении другого признака (часть 33б): число одно на двоих. Низкое давление меряют
   * тем же тонометром, что высокое: при рождении пациента с низким давлением общее значение — из
   * `present` этого признака, а тот, чьё измерение, снимается; в обследовании с ним вместе «есть» —
   * если его измеренное значение попало в `present`.
   */
  of?: Id;
}

export interface Finding {
  id: Id;
  name: Text;
  kind: 'sym' | 'sign' | 'vital' | 'lab' | 'img' | 'ecg' | 'hx';
  /** фон популяции: вероятность признака от причин, которых нет в модели */
  leak: P;
  /** насколько заметно пациенту: 3 — назовёт первым, 0 — только на вопрос */
  salience: number;
  redFlag?: boolean;
  /** срочность на сортировке, если медсестра видит признак (жалоба, витальные) */
  triage?: 'red' | 'yellow';
  attrs?: Record<string, Record<string, Text>>;
  value?: NumericSpec;
  texts: {
    complaint?: Text[];
    present: Text[];
    absent?: Text[];
    /** «Что это?» простыми словами — для тех, кто не медик (05-content.md §4) */
    hint?: Text;
  };
  review: Review;
}

export interface ExamCheck {
  f: Id;
  sens: P;
  spec: P;
}

export interface Exam {
  id: Id;
  name: Text;
  kind: 'ask' | 'physical' | 'bedside' | 'lab' | 'rapid' | 'functional' | 'imaging';
  /** где делают; нет — в кабинете врача */
  room?: Id;
  /** каким аппаратом: подходит любой из списка */
  equipment?: Id[];
  /** где берут материал (анализы — в процедурном) */
  collect?: Id;
  /** минуты: сама процедура, описание, ожидание результата */
  time: { procedure: number; report?: number; turnaround?: number };
  cost: number;
  discomfort: 0 | 1 | 2 | 3;
  radiation?: 'none' | 'low' | 'medium' | 'high';
  /** спрашивают каждого (анамнез жизни) */
  routine?: boolean;
  /**
   * делают каждому с одной из этих жалоб (часть 32г-2): при травме и ране головы — расспрос о
   * потере сознания и неврологический осмотр, пока ЧМТ не исключена (733_2, 734_2)
   */
  routineFor?: Id[];
  /** кому делают: только этому полу — о месячных и беременности спрашивают женщин */
  sex?: 'm' | 'f';
  /** кому делают по возрасту, лет включительно */
  ageMin?: number;
  ageMax?: number;
  /** кому делают: только пришедшим с одной из этих жалоб — о травме головы спрашивают при травме головы (часть 32г) */
  complaints?: Id[];
  checks: ExamCheck[];
  /** summary — как делают; hint — что показывает, простыми словами */
  texts: { summary: Text; hint?: Text };
  sources: Source[];
  review: Review;
}

export interface Risk {
  id: Id;
  name: Text;
  /** распространённость по полу */
  p: { m: P; f: P };
  ageMin?: number;
  ageMax?: number;
  findings: Link[];
  sources: Source[];
  review: Review;
}

export type Season = 'winter' | 'spring' | 'summer' | 'autumn';

// --- каталог больницы (spec 2026-09-own-hospital) ------------------------------------------

export type Cell = [number, number];
export type ObjectKind = 'bed' | 'chair' | 'desk' | 'couch' | 'cabinet' | 'machine' | 'plant' | 'sink' | 'bench' | 'xray' | 'table' | 'ecg' | 'analyzer' | 'or_table' | 'anesthesia' | 'us';
export type RoomSizeId = 'S' | 'M' | 'L';

/**
 * Размер помещения: клетки вместе со стенами, координаты — от левого верхнего угла стен в
 * исходном повороте; дверная сторона — нижняя. Первый ряд внутри — под подпись на карте,
 * последний — проход вдоль двери.
 */
export interface RoomSize {
  id: RoomSizeId;
  w: number;
  h: number;
  cost: number;
  upkeep: number;
  /** дверь по умолчанию: первая клетка проёма на нижней стене и ширина проёма */
  door: { x: number; width: number };
  objects: { kind: ObjectKind; x: number; y: number }[];
  /** места под аппараты */
  slots: Cell[];
  /** где стоит человек каждой должности */
  staff: Record<Id, Cell>;
  /** куда встаёт или садится пациент */
  patient?: Cell;
  /** стулья зоны ожидания — места в очереди */
  seats: number;
  /** койки палаты — места лежащих; у смотровой приёмного — места для пациентов скорой */
  beds: number;
  /** мест для нанятых врачей — ординаторская */
  places: number;
}

export interface RoomType {
  id: Id;
  name: Text;
  /** родительный падеж: «нет лаборатории» */
  gen: Text;
  /** кто нужен, чтобы работало: по человеку на должность */
  staff: Id[];
  needsEquipment: boolean;
  seats: boolean;
  beds: boolean;
  /** смотровая приёмного: койки — места для пациентов скорой (spec 2026-09-chapter-2, часть 27) */
  emergency: boolean;
  /** работает — в больницу приходят и больные этих отделений: приёмное — хирургию (часть 30) */
  admits?: Id[];
  sizes: RoomSize[];
  /** производное: какие аппараты ставят сюда и какие обследования здесь делают или берут материал */
  equipment: Id[];
  exams: Id[];
  collects: Id[];
  texts: { hint: Text };
}

export interface Equipment {
  id: Id;
  name: Text;
  gen: Text;
  room: Id;
  sprite: 'ecg' | 'analyzer' | 'xray' | 'or_table' | 'anesthesia' | 'us';
  upgradeOf?: Id;
  /** своё место в помещении — номер из `slots`; занято — первое свободное */
  slot?: number;
  price: number;
  upkeep: number;
  /** шанс поломки за день работы, в долях 1/10 000; поломок в 0.2.0 нет */
  breakdown: P;
  /** множитель времени обследования */
  speed: number;
  /** поправка к чувствительности и специфичности, процентные пункты */
  quality: { sens: number; spec: number };
  /** производное: какие обследования им делают */
  exams: Id[];
  texts: { hint: Text };
}

export interface StaffRole {
  id: Id;
  name: Text;
  gen: Text;
  /** врача не нанимают: это игрок */
  hire: boolean;
  /** зарплата за смену при навыке 1 и при навыке 5, ₽ */
  salary: [number, number];
  /** встаёт на место этой должности (терапевт — на место врача) */
  stands?: Id;
  /** без места в этом помещении не работает (терапевту нужна ординаторская) */
  needs?: Id;
  /** описывает снимки своего помещения: от навыка — точность (рентгенолог, врач УЗД) */
  reads?: true;
  /** производное: где работает */
  rooms: Id[];
  texts: { hint: Text };
}

/** Поворот помещения по часовой: дверная сторона снизу (0), слева (1), сверху (2), справа (3). */
export type Rot = 0 | 1 | 2 | 3;

/** Готовая больница (content/hospital/presets): участок, коридор, помещения, штат. */
export interface Preset {
  id: Id;
  name: Text;
  plot: [number, number];
  /** вход — дверь в краю участка */
  entrance: Cell;
  corridor: Cell[];
  rooms: { type: Id; size: RoomSizeId; x: number; y: number; rot: Rot; door?: number; equipment: Id[] }[];
  /** предметы коридора: скамьи */
  decor: { kind: ObjectKind; x: number; y: number }[];
  /** кто где работает: должность и номер помещения в списке */
  staff: { role: Id; room: number }[];
}

/** Баланс своей больницы (content/hospital/economy.yaml); числа — игровые. */
export interface Economy {
  /** клетка коридора: постройка и содержание в день, ₽ */
  corridor: { cost: number; upkeep: number };
  /** сколько процентов цены возвращают снос и продажа аппарата */
  refund: number;
  /** персонал (spec 2026-09-own-hospital, часть 8): числа — баланс игры */
  staff: {
    /** кандидатов на должность в день: от, до */
    candidates: [number, number];
    /** веса навыка 1–5 */
    skills: [number, number, number, number, number];
    /** время обследования по навыку 1–5, % */
    speed: [number, number, number, number, number];
    /** рентгенолог по навыку 1–5: поправка чувствительности и специфичности снимка, п. п. */
    reading: [number, number][];
    /** хирург по навыку 1–5: доля осложнений после операции, % от записанной у операции (spec 2026-09-chapter-2, часть 28) */
    surgery: [number, number, number, number, number];
    /** отработанных дней на ступень навыка */
    growthDays: number;
    /** вес «без черты» */
    noTrait: number;
    traits: Record<'careful' | 'fast' | 'novice' | 'experienced', {
      weight: number; salary?: number; speed?: number; reading?: [number, number]; skills?: [number, number]; growth?: number;
      /** нанятый врач: поправка порога уверенности и «забыл спросить», п. п. */
      threshold?: number; forget?: number;
    }>;
    /**
     * Нанятые врачи (spec 2026-09-hired-doctors) по навыку 1–5: при какой уверенности ставят
     * диагноз, %; наименьшая польза обследования, тысячные бита; как часто забывают спросить
     * о противопоказаниях перед лечением, %.
     */
    doctor: { threshold: number[]; minGain: number[]; forget: number[] };
  };
  /**
   * ОМС — за обращение по тяжести диагноза; экспертиза страховой: доля по обоснованности и
   * доля, если диагноз не подтверждён. ДМС и платно — обращение и прайс, % цены обследования.
   */
  tariffs: {
    oms: Record<'minor' | 'moderate' | 'serious' | 'critical', number>;
    /** случай стационара по тяжести диагноза — при выписке */
    omsWard: Record<'minor' | 'moderate' | 'serious' | 'critical', number>;
    /** случай стационара с операцией — прибавка за операцию */
    omsOperation: number;
    omsQuality: Record<'A' | 'B' | 'C' | 'D', number>;
    omsUnconfirmed: number;
    /** показанные обследования, % цены в базе */
    omsExam: number;
    dms: { visit: number; price: number };
    self: { visit: number; price: number };
  };
  /** уровень амбулатории для ОМС: доля тарифа за обращение, % — базовая и прибавки за работающие помещения */
  level: { base: number; rooms: Record<Id, number> };
  /** доля ДМС и платных, % — при репутации 0, 50, 100 */
  payers: { dms: [number, number, number]; self: [number, number, number] };
  /** расходники обследования, % цены — по виду */
  consumables: Record<Exam['kind'], number>;
  /** процент на долг в день, сотые доли процента */
  interest: number;
  /** стационар: койко-день, ₽; доля тарифа за прерванный случай (перевод, выписка раньше срока), % */
  ward: { bedDay: number; interrupted: number };
  /** скорая: машин за смену; вес болезни по тяжести; доля тяжёлых, % (часть 27) */
  ambulance: { perDay: [number, number]; weight: Record<'minor' | 'moderate' | 'serious' | 'critical', number>; severe: number };
  /** репутация 0–100: начало, на сколько % вечером сдвигается к оценке дня, поправки оценки */
  reputation: {
    start: number; pull: number;
    waitShort: number; waitShortMin: number; waitLong: number; waitLongMin: number; noToilet: number;
  };
  /** поток пациентов от репутации: ± % при 0 и 100 */
  flow: number;
  /** песочница: участок, вход и отрезок коридора, бюджеты; с готовой амбулаторией — доля бюджета, % */
  sandbox: {
    plot: [number, number];
    entrance: Cell;
    corridor: Cell[];
    budgets: Record<'modest' | 'normal' | 'generous', number>;
    clinicShare: number;
  };
}

/** Персонаж кампании — наставник, главврач (spec 2026-09-campaign). */
export interface Character {
  id: Id;
  name: Text;
  short: Text;
  sex: 'm' | 'f';
  age: number;
  portrait: number;
  role: Text;
}

/** Условие дня для заданий «N дней». */
export type DayKind = 'noNeedlessAntibiotic' | 'noLeft' | 'cashPositive' | 'noWaitComplication';

export type Mission = { id: string; main: boolean; text: Text } & (
  | { kind: 'seen'; count: number; accuracy: number }
  | { kind: 'roomWorks'; room: Id }
  | { kind: 'streak'; days: number; day: DayKind }
  | { kind: 'days'; days: number; day: DayKind }
  /** глава 2 (spec 2026-09-chapter-2, часть 34): сортировка скорой, операции, сроки стационара */
  | { kind: 'triage'; count: number }
  | { kind: 'operations'; count: number }
  | { kind: 'stay'; count: number }
);

export type LetterWhen = 'start' | 'end' | { afterDay: number } | { mission: string };

export interface Letter {
  id: string;
  from: Id;
  when: LetterWhen;
  text: Text;
}

/**
 * Заданный пациент первой смены главы: болезнь, привезёт ли его скорая, какие скрытые параметры
 * заданы и в каком он возрасте (часть 34б: тяжёлая пневмония, стабильный перелом лодыжек,
 * аппендицит у молодого).
 */
export interface TutorialPatient {
  condition: Id;
  ambulance?: boolean;
  params?: Record<string, string>;
  /** возраст, лет: от и до — аппендицит у молодого (часть 34б) */
  age?: [number, number];
}

/** Глава кампании: больница, бюджет, что можно строить, задания и письма. */
export interface Chapter {
  id: Id;
  order: number;
  name: Text;
  place: Text;
  /** кнопка перехода в главу в конце прежней (часть 34) */
  move?: Text;
  preset: Id;
  budget: number;
  department: Id;
  build: Id[];
  tutorial: TutorialPatient[];
  missions: Mission[];
  letters: Letter[];
}

/**
 * Когда подсказка наставника к месту: открылась карта, после первых вопросов, у пациента с
 * болезнью, «Решение», разбор; ждёт сортировки привезённый скорой, обход (часть 34б).
 */
export type TipWhen = 'caseOpen' | 'afterAsk' | 'decision' | 'review' | 'ambulance' | 'rounds' | { condition: Id };

/** Подсказка наставника в первую смену главы (spec 2026-09-campaign). */
export interface Tip {
  id: Id;
  order: number;
  from: Id;
  /** только в этой главе (часть 34б) */
  chapter?: Id;
  name: Text;
  when: TipWhen;
  text: Text;
  /** о чём подсказка — статьи энциклопедии */
  see: Id[];
}

/** Группа достижения в профиле. */
export type AchievementCategory = 'practice' | 'diagnosis' | 'care' | 'knowledge' | 'hospital' | 'campaign' | 'daily';

/** Вид «сколько раз»: приёмов, рабочих дней, верных подряд, на A, бережливых, с вопросом об аллергии, дней без ушедших, разных болезней, случаев дня. */
export type CountedKind = 'cases' | 'days' | 'correctRun' | 'gradeA' | 'thriftCase' | 'allergyAsked' | 'noLeftDay' | 'seenConditions' | 'dailyCases';

/** Достижение (spec 2026-09-campaign, часть 13): вид и числа — движку, название и что нужно — игроку. */
export type Achievement = { id: Id; order: number; category: AchievementCategory; name: Text; need: Text } & (
  | { kind: CountedKind; count: number }
  | { kind: 'department'; department: Id }
  | { kind: 'roomWorks'; room: Id }
  | { kind: 'chapter'; chapter: Id }
);

/**
 * Шкала раннего предупреждения по витальным (NEWS2, spec 2026-09-chapter-2, часть 27): баллы по
 * значению признака — [от, до, баллы], `null` — без границы; дышит кислородом и спутанность —
 * отдельные строки; уровни ответа.
 */
export interface Score {
  id: Id;
  name: Text;
  params: { f: Id; points: [number | null, number | null, number][] }[];
  oxygen: number;
  confusion: number;
  levels: { medium: number; single: number; high: number };
  texts: { summary: Text; hint: Text };
  sources: Source[];
  review: Review;
}

/**
 * Правило решения (spec 2026-09-chapter-2, часть 32): оттавские правила — при жалобе из
 * `complaints` обследования `exams` нужны, если есть хоть один признак из `any`; проверили все —
 * и ни одного: перелом маловероятен, снимок можно не делать. Проверено с `ageMin` лет. С части
 * 32г — ещё дополнительные признаки (`minor`: нужно не меньше `count`), возраст как основной или
 * дополнительный признак и круг, к кому правило применимо (`requires`: хоть один признак). С части
 * 33а — признаки, при которых правило не применяют (`excludes`), и «ещё не решено — узнать, что
 * осталось»: шкала Уэллса меньше двух — D-димер.
 */
export interface Rule {
  id: Id;
  name: Text;
  complaints: Id[];
  /** основные признаки: хватит одного */
  any: Id[];
  /** дополнительные: нужно не меньше `count` (возраст из `age.minor` — тоже один) */
  minor?: { any: Id[]; count: number };
  /**
   * возраст: старше `main` — основной признак (КТ головы: старше 60 лет); `from` и старше — тоже
   * основной (оттавские правила для колена: 55 лет и старше, часть 32д); в пределах `minor` —
   * дополнительный
   */
  age?: { main?: number; from?: number; minor?: [number, number] };
  /** применимо, только если есть хоть один из этих признаков; без них — «не применяется» */
  requires?: Id[];
  /**
   * не применяется, если есть хоть один из этих признаков (часть 33а): у тромбофлебита УЗИ вен
   * нужно всем, шкала Уэллса и D-димер не нужны; при беременности D-димер не используют
   */
  excludes?: Id[];
  /** какое обследование правило назначает; пусто — его в игре нет (КТ, часть 32г), тогда `texts.exam` */
  exams: Id[];
  ageMin?: number;
  /** о каких болезнях — для энциклопедии */
  about: Id[];
  /**
   * yes — есть признак: «Снимок нужен»; no — проверили все, признаков нет; na — правило не
   * применимо; exam — что за обследование, если в игре его нет
   */
  texts: { summary: Text; hint: Text; yes: Text; no: Text; na?: Text; exam?: Text };
  sources: Source[];
  review: Review;
}

export interface ContentDb {
  contentVersion: number;
  hash: string;
  conditions: Record<Id, Condition>;
  findings: Record<Id, Finding>;
  exams: Record<Id, Exam>;
  risks: Record<Id, Risk>;
  treatments: Record<Id, Treatment>;
  rooms: Record<Id, RoomType>;
  equipment: Record<Id, Equipment>;
  roles: Record<Id, StaffRole>;
  presets: Record<Id, Preset>;
  economy: Economy;
  characters: Record<Id, Character>;
  chapters: Record<Id, Chapter>;
  tips: Record<Id, Tip>;
  achievements: Record<Id, Achievement>;
  /** шкалы по витальным: NEWS2 (часть 27) */
  scores: Record<Id, Score>;
  /** правила решения: оттавские (часть 32) */
  rules: Record<Id, Rule>;
  /** производное: какие обследования проверяют признак */
  revealedBy: Record<Id, Id[]>;
}
