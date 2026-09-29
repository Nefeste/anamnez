// Схема исходных записей медицинской базы (YAML в content/, `docs/05-content.md` §4).
// Строгие объекты: опечатка в имени поля — ошибка сборки, а не молча пропущенное поле.
import { z } from 'zod';
import { SYSTEMS } from '../../src/content/types';

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
/** «Что это?»: одна-две фразы простыми словами, без доз и торговых названий. */
const hint = z.strictObject({ ru: z.string().min(20).max(320), en: z.string().optional() });
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
  /** точная частота — откуда она: сверено с источником (без пояснения — предупреждение сборки) */
  note: z.string().min(10).optional(),
  stages: z.array(z.string()).optional(),
  when: z.record(z.string(), z.array(z.string())).optional(),
  attrs: z.record(z.string(), attrSpec).optional(),
});
const riskMultiplier = z.strictObject({ id: z.string(), x: z.number().positive() });
const txId = z.string().regex(/^tx\.[a-z0-9_]+$/);
/** Где лечить — что нужно пациенту; `admit` («в палату») — только выбор врача, в базе его нет. */
export const SETTINGS = ['home', 'ward', 'ambulance', 'surgery', 'transfer'] as const;
const setting = z.enum(SETTINGS);
const season = z.strictObject({ winter: z.number(), spring: z.number(), summer: z.number(), autumn: z.number() });

export const conditionSchema = z.strictObject({
  id: z.string().regex(/^cond\.[a-z0-9_]+$/),
  name: text,
  icd10: z.string().optional(),
  department: z.string(),
  group: z.string().regex(/^grp\.[a-z0-9_]+$/).optional(),
  /** система органов — для списков диагнозов и энциклопедии; обязательна у того, с чем приходят */
  system: z.enum(SYSTEMS).optional(),
  kind: z.enum(['disease', 'injury', 'syndrome', 'state']),
  severity: z.enum(['minor', 'moderate', 'serious', 'critical']),
  presenting: z.boolean().default(true),
  /** бывает без жалоб — находят на профосмотре (гипертония, диабет); остальные приходят с симптомом */
  checkup: z.boolean().optional(),
  epidemiology: z.strictObject({
    prevalence: z.enum(Object.keys(PREVALENCE) as [keyof typeof PREVALENCE, ...(keyof typeof PREVALENCE)[]]),
    age: z.strictObject({ min: z.number().int(), max: z.number().int().optional(), peak: z.tuple([z.number(), z.number()]).optional() }),
    sex: z.strictObject({ m: z.number(), f: z.number() }).optional(),
    season: season.optional(),
    risks: z.array(riskMultiplier).optional(),
    requires: z.array(z.string()).optional(),
    /** не бывает у того, у кого уже есть это (впервые выявленная гипертензия — не у гипертоника) */
    excludes: z.array(z.string()).optional(),
    chronic: z.strictObject({ band: probability, ageMin: z.number().int().optional(), risks: z.array(riskMultiplier).optional() }).optional(),
  }),
  params: z.record(z.string(), weights).optional(),
  /**
   * производные параметры (часть 32г): «yes», если правило решения выполнено на настоящих
   * признаках и возрасте, иначе «no»; доли того же параметра в `params` — для вывода, пока
   * признаки правила не известны
   */
  derived: z.record(z.string(), z.string().regex(/^rule\.[a-z0-9_]+$/)).optional(),
  course: z.strictObject({
    stages: z.array(z.strictObject({ id: z.string(), days: z.tuple([z.number(), z.number()]), needs: z.literal('treatment').optional() })).min(1),
    /** в какие дни болезни обычно обращаются */
    presentation: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
    /**
     * проходит само: без лечения — выздоровление к концу стадий; `{ when }` — только при этих
     * значениях скрытого параметра (часть 30д: неосложнённый дивертикулит — да, абсцесс — нет)
     */
    selfLimiting: z.union([z.boolean(), z.strictObject({ when: z.record(z.string(), z.array(z.string())) })]).optional(),
    /** без действенного лечения: с какой вероятностью и на какой день становится хуже; `when` — при каких значениях параметра */
    untreated: z.strictObject({ band: probability, days: z.tuple([z.number().int().min(0), z.number().int().min(0)]), when: z.record(z.string(), z.array(z.string())).optional() }).optional(),
    /** в стационаре при действенном лечении: через сколько суток можно выписывать (spec 2026-09-chapter-2, часть 26) */
    stay: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional(),
  }),
  /** тактика (`04-medical-model.md` §8): пять списков и где лечить */
  treatment: z.strictObject({
    /** при лечении дома — хотя бы одно (валидатор); при переводе — что сделать до приезда скорой */
    firstLine: z.array(txId).default([]),
    acceptable: z.array(txId).default([]),
    supportive: z.array(txId).default([]),
    notIndicated: z.array(txId).default([]),
    harmful: z.array(txId).default([]),
    /** типичное назначение целиком, если первая линия — выбор из равных (цистит: одно из двух) */
    plan: z.array(txId).min(1).optional(),
    /**
     * обязательная профилактика (часть 32г-2): её нет в плане — лечение неполное, даже если рана
     * зажила (анатоксин столбнячный при просроченной прививке, вакцина от бешенства после укуса)
     */
    prevent: z.array(txId).min(1).optional(),
    /**
     * тактика по скрытому параметру (spec 2026-09-chapter-2, часть 32): при таких значениях у
     * названных здесь лечений — эта роль, у остальных — из общих списков; своё типичное назначение
     * (перелом со смещением — репозиция, без смещения — лонгета)
     */
    byParam: z.array(z.strictObject({
      when: z.record(z.string(), z.array(z.string()).min(1)),
      firstLine: z.array(txId).default([]),
      acceptable: z.array(txId).default([]),
      supportive: z.array(txId).default([]),
      notIndicated: z.array(txId).default([]),
      harmful: z.array(txId).default([]),
      plan: z.array(txId).min(1).optional(),
      /** обязательная профилактика при этих значениях — вдобавок к общей */
      prevent: z.array(txId).min(1).optional(),
    })).min(1).optional(),
    setting: z.strictObject({
      default: setting,
      /** уточнение по скрытому параметру случая: значение → место */
      param: z.strictObject({ name: z.string(), map: z.record(z.string(), setting) }).optional(),
      /** если у пациента есть красный флаг этого состояния */
      redFlag: setting.optional(),
      /** если у пациента есть фактор риска: пиелонефрит у беременной — в стационар */
      risks: z.array(z.strictObject({ id: z.string().regex(/^risk\.[a-z0-9_]+$/), setting })).optional(),
      /**
       * ещё места, которые при этих значениях не ошибка (часть 32б): изолированный перелом ключицы
       * со смещением — показание к операции относительное (853_1), повязка дома тоже можно
       */
      also: z.array(z.strictObject({ when: z.record(z.string(), z.array(z.string()).min(1)), settings: z.array(setting).min(1) })).min(1).optional(),
    }),
  }).optional(),
  /**
   * лечат операцией (spec 2026-09-chapter-2, часть 28): какой — операция вида `surgery`, — и за
   * сколько часов от поступления её сделать, чтобы не было поздно, — по рекомендации
   */
  surgery: z.strictObject({
    /** срок нет — в рекомендации его нет: закрытый нестабильный перелом оперируют в эту госпитализацию (часть 32) */
    tx: txId, window: z.number().int().min(1).max(240).optional(),
    /**
     * операция по скрытому параметру (часть 32б): при этих значениях — эта операция, иначе `tx`;
     * перелом шейки бедра без смещения — винты, со смещением — эндопротез (980_1)
     */
    byParam: z.array(z.strictObject({ when: z.record(z.string(), z.array(z.string()).min(1)), tx: txId })).min(1).optional(),
    /** срок — от начала болезни, а не от поступления: ранняя холецистэктомия — в первые 72 ч болезни (часть 30) */
    from: z.enum(['arrival', 'onset']).optional(),
    /**
     * срок, если экстренной операции не нужно и лечат в палате (часть 30в): неоперативное лечение
     * не помогло — операция не позже стольких часов от поступления
     */
    observe: z.number().int().min(1).max(240).optional(),
    /** стационар после операции, сутки от суток операции — если он дольше, чем без неё (часть 30в) */
    stay: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional(),
  }).optional(),
  /**
   * осложнённая стадия (часть 28б): без действенного лечения наступает по часам от начала
   * болезни — за первые `early.hours` часов с долей `early.p`, дальше — с долей `later.p` за
   * каждые `later.every` часов (перфорация аппендикса); после операции в этой стадии — свой срок
   * стационара, сутки
   */
  complication: z.strictObject({
    name: text,
    early: z.strictObject({ hours: z.number().int().min(1).max(240), p: probability }).optional(),
    later: z.strictObject({ every: z.number().int().min(1).max(240), p: probability }).optional(),
    /** наступает наверняка через столько часов от начала болезни (часть 30б: прободная язва позже 24 ч — Boey) */
    after: z.number().int().min(1).max(240).optional(),
    /** стадия бывает только при таком значении скрытого параметра (часть 30в: некроз — при ишемии кишки) */
    when: z.record(z.string(), z.array(z.string())).optional(),
    stay: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional(),
  }).refine(x => (x.after !== undefined) !== (x.early !== undefined && x.later !== undefined) && (x.early === undefined) === (x.later === undefined), {
    message: 'осложнённая стадия — либо по риску (early и later), либо по сроку (after)',
  }).optional(),
  /** у того, с чем приходят, — не меньше трёх (валидатор); у хронического фона хватит одного */
  findings: z.array(link).min(1),
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
  /** срочность на сортировке, если медсестра видит признак (жалоба, витальные): красный — сразу к врачу */
  triage: z.enum(['red', 'yellow']).optional(),
  attrs: z.record(z.string(), z.record(z.string(), text)).optional(),
  value: z.strictObject({
    unit: z.string(),
    ref: z.tuple([z.number(), z.number()]),
    present: z.tuple([z.number(), z.number()]),
    absent: z.tuple([z.number(), z.number()]),
    decimals: z.number().int().min(0).max(3),
    /** производные числа для шаблона: {dia} = значение × множитель (давление: нижнее из верхнего) */
    derived: z.record(z.string().regex(/^[a-z]+$/), z.number().positive()).optional(),
  }).optional(),
  texts: z.strictObject({ complaint: texts.optional(), present: texts, absent: texts.optional(), hint }),
  sources: z.array(source).optional(),
  review,
});

const accuracy = z.number().min(50).max(100);
const roomId = z.string().regex(/^room\.[a-z0-9_]+$/);
const eqId = z.string().regex(/^eq\.[a-z0-9_]+$/);
const roleId = z.string().regex(/^role\.[a-z0-9_]+$/);
export const examSchema = z.strictObject({
  id: z.string().regex(/^exam\.[a-z0-9_]+$/),
  name: text,
  kind: z.enum(['ask', 'physical', 'bedside', 'lab', 'rapid', 'functional', 'imaging']),
  /** где делают; нет — в кабинете врача */
  room: roomId.optional(),
  /** каким аппаратом: подходит любой из списка (spec 2026-09-own-hospital) */
  equipment: z.array(eqId).min(1).optional(),
  /** где берут материал: кровь и мочу для анализов принимают в процедурном */
  collect: roomId.optional(),
  time: z.strictObject({ procedure: z.number().int().min(0), report: z.number().int().min(0).optional(), turnaround: z.number().int().min(0).optional() }),
  cost: z.number().int().min(0),
  discomfort: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  radiation: z.enum(['none', 'low', 'medium', 'high']).optional(),
  /** спрашивают каждого (анамнез жизни): «виртуальный врач» делает это первым */
  routine: z.boolean().optional(),
  /** делают каждому с одной из этих жалоб, первым (часть 32г-2): при ране головы — неврологический осмотр */
  routineFor: z.array(z.string().regex(/^sym\.[a-z0-9_]+$/)).min(1).optional(),
  /** кому делают: только этому полу (о месячных и беременности — женщин) */
  sex: z.enum(['m', 'f']).optional(),
  /** кому делают по возрасту, лет включительно: вне его не предлагается */
  ageMin: z.number().int().min(0).max(120).optional(),
  ageMax: z.number().int().min(0).max(120).optional(),
  /** кому делают: только пришедшим с одной из этих жалоб (часть 32г: расспрос о травме головы) */
  complaints: z.array(z.string().regex(/^sym\.[a-z0-9_]+$/)).min(1).optional(),
  /** чувствительность и специфичность — в процентах */
  checks: z.array(z.strictObject({ f: z.string(), sens: accuracy, spec: accuracy })).min(1),
  texts: z.strictObject({ summary: text, hint }),
  sources: z.array(source).min(1),
  review,
});

/** Лечение — группа или МНН без доз (ADR 0012). */
export const treatmentSchema = z.strictObject({
  id: txId,
  name: text,
  kind: z.enum(['drug', 'regimen', 'procedure', 'surgery']),
  /** класс для аллергий и статистики: antibiotic.penicillin, antibiotic.macrolide… */
  class: z.string().regex(/^[a-z_]+(\.[a-z_]+)*$/).optional(),
  route: z.enum(['oral', 'inhaled', 'nasal', 'iv', 'im']).optional(),
  cost: z.number().int().min(0),
  /** cure — действует на причину: переводит болезнь к выздоровлению с вероятностью за столько дней */
  effects: z.array(z.strictObject({
    on: z.string().regex(/^cond\.[a-z0-9_]+$/),
    kind: z.enum(['cure', 'relieve']),
    band: probability,
    days: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
    /** действует, только если у болезни такое значение скрытого параметра (часть 30в: без ишемии кишки) */
    when: z.record(z.string(), z.array(z.string())).optional(),
  })).default([]),
  /** противопоказание — фактор риска (аллергия) или состояние; reaction — вероятность вреда, если назначить */
  contraindications: z.array(z.strictObject({
    id: z.string().regex(/^(risk|cond)\.[a-z0-9_]+$/),
    level: z.enum(['relative', 'absolute']),
    reaction: probability,
  })).default([]),
  /**
   * операция (часть 28): в каком помещении, какая бригада — по человеку на должность, какие
   * аппараты — все сразу, сколько минут идёт; осложнений после неё при среднем навыке хирурга
   */
  surgery: z.strictObject({
    room: roomId,
    team: z.array(roleId).min(1),
    equipment: z.array(eqId).min(1),
    minutes: z.number().int().min(5).max(600),
    complications: probability,
    /** умерли в стационаре после операции (часть 28б) */
    death: probability.optional(),
    /** в осложнённой стадии болезни на момент разреза: свои осложнения и смерть */
    complicated: z.strictObject({ complications: probability, death: probability.optional() }).optional(),
    /** каждый полный час от поступления до разреза выживаемость ниже на столько (часть 30б: прободная язва — Buck 2013) */
    delay: probability.optional(),
  }).optional(),
  texts: z.strictObject({ hint }),
  sources: z.array(source).min(1),
  review,
});

export const riskSchema = z.strictObject({
  id: z.string().regex(/^risk\.[a-z0-9_]+$/),
  name: text,
  prevalence: z.strictObject({ m: z.number().min(0).max(100), f: z.number().min(0).max(100) }),
  ageMin: z.number().int().optional(),
  ageMax: z.number().int().optional(),
  findings: z.array(link),
  sources: z.array(source).min(1),
  review,
});

// --- каталог больницы (spec 2026-09-own-hospital, `docs/07-data-model.md` §1) ---------------
// Помещения, аппараты и должности — игровые предметы: цены и размеры — баланс игры. Что
// каким аппаратом делают — медицинский факт, он записан в записях обследований с источниками.

export const OBJECT_KINDS = ['bed', 'chair', 'desk', 'couch', 'cabinet', 'machine', 'plant', 'sink', 'bench', 'xray', 'table', 'ecg', 'analyzer', 'or_table', 'anesthesia', 'us'] as const;
const cellSrc = z.tuple([z.number().int().min(0), z.number().int().min(0)]);
/** «нет лаборатории», «нет лаборанта» — родительный падеж для причин «не работает» */
const gen = text;

/**
 * Размер помещения: клетки вместе со стенами; координаты — от левого верхнего угла стен в
 * исходном повороте, дверная сторона — нижняя. Первый ряд внутри — под подпись на карте,
 * последний — проход вдоль двери: в обоих предметов нет (валидатор).
 */
const roomSize = z.strictObject({
  id: z.enum(['S', 'M', 'L']),
  w: z.number().int().min(5).max(16),
  h: z.number().int().min(5).max(16),
  /** цена постройки и содержание в день, ₽ */
  cost: z.number().int().min(0),
  upkeep: z.number().int().min(0),
  /** дверь по умолчанию: первая клетка проёма на нижней стене и его ширина */
  door: z.strictObject({ x: z.number().int().min(1), width: z.number().int().min(1).max(4).default(1) }),
  objects: z.array(z.tuple([z.enum(OBJECT_KINDS), z.number().int(), z.number().int()])),
  /** места под аппараты */
  slots: z.array(cellSrc).default([]),
  /** где стоит человек каждой должности */
  staff: z.record(roleId, cellSrc).default({}),
  /** куда встаёт или садится пациент */
  patient: cellSrc.optional(),
  /** мест для нанятых врачей — ординаторская (spec 2026-09-hired-doctors) */
  places: z.number().int().min(0).max(8).default(0),
});

export const roomSchema = z.strictObject({
  id: roomId,
  name: text,
  gen,
  /** кто нужен, чтобы работало: по человеку на должность */
  staff: z.array(roleId).default([]),
  /** без аппарата не работает */
  needsEquipment: z.boolean().default(false),
  /** стулья — места в очереди */
  seats: z.boolean().default(false),
  /** койки — места лежащих пациентов (палата, spec 2026-09-chapter-2, часть 26) */
  beds: z.boolean().default(false),
  /** смотровая приёмного: койки — места для пациентов скорой (часть 27) */
  emergency: z.boolean().default(false),
  /** работает — в больницу приходят и больные этих отделений: приёмное — хирургию (часть 30) */
  admits: z.array(z.string().regex(/^dept\.[a-z0-9_]+$/)).min(1).optional(),
  sizes: z.array(roomSize).min(1),
  texts: z.strictObject({ hint }),
});

export const equipmentSchema = z.strictObject({
  id: eqId,
  name: text,
  gen,
  room: roomId,
  /** как выглядит на карте: у каждого вида аппарата свой рисунок (spec 2026-09-living-map) */
  sprite: z.enum(['ecg', 'analyzer', 'xray', 'or_table', 'anesthesia', 'us']),
  /** улучшение другого аппарата: цифровой рентген — плёночного */
  upgradeOf: eqId.optional(),
  /** своё место в помещении — номер из `slots` (стол операционной — под пациентом); занято — первое свободное */
  slot: z.number().int().min(0).optional(),
  /** цена и обслуживание в день, ₽ */
  price: z.number().int().min(0),
  upkeep: z.number().int().min(0),
  /** шанс поломки за день работы, %; поломок в 0.2.0 нет */
  breakdown: z.number().min(0).max(100),
  /** множитель времени обследования: 0.8 — на пятую часть быстрее */
  speed: z.number().min(0.3).max(3),
  /** поправка к чувствительности и специфичности, процентные пункты */
  quality: z.strictObject({ sens: z.number().int().min(-20).max(20), spec: z.number().int().min(-20).max(20) }).default({ sens: 0, spec: 0 }),
  texts: z.strictObject({ hint }),
});

export const roleSchema = z.strictObject({
  id: roleId,
  name: text,
  gen,
  /** врача не нанимают: это игрок */
  hire: z.boolean().default(true),
  /** зарплата за смену при навыке 1 и при навыке 5, ₽ */
  salary: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
  /** встаёт на место этой должности — терапевт на место врача, в любом кабинете, кроме вашего */
  stands: roleId.optional(),
  /** без места в этом помещении не работает — терапевту нужна ординаторская */
  needs: roomId.optional(),
  /** описывает снимки своего помещения — от навыка точность (рентгенолог, врач УЗД, часть 29) */
  reads: z.boolean().optional(),
  texts: z.strictObject({ hint }),
});

const int = z.number().int().min(0);
/** доля, целые проценты */
const pct = z.number().int().min(0).max(100);
/** Готовая больница: участок, вход, коридор прямоугольниками, помещения, скамьи, штат. */
export const presetSchema = z.strictObject({
  id: z.string().regex(/^preset\.[a-z0-9_]+$/),
  name: text,
  plot: z.tuple([z.number().int().min(8).max(64), z.number().int().min(8).max(64)]),
  entrance: cellSrc,
  /** коридор — прямоугольники клеток: x0, y0, x1, y1 включительно */
  corridor: z.array(z.tuple([int, int, int, int])).min(1),
  rooms: z.array(z.strictObject({
    type: roomId,
    size: z.enum(['S', 'M', 'L']),
    x: int,
    y: int,
    /** поворот по часовой: дверная сторона снизу (0), слева (1), сверху (2), справа (3) */
    rot: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    /** дверь — первая клетка вдоль дверной стороны в координатах шаблона; нет — сама */
    door: z.number().int().min(1).optional(),
    equipment: z.array(eqId).default([]),
  })).min(1),
  decor: z.array(z.tuple([z.enum(OBJECT_KINDS), int, int])).default([]),
  /** кто где работает: должность и номер помещения в списке */
  staff: z.array(z.strictObject({ role: roleId, room: int })).default([]),
});

/** Поправка чувствительности и специфичности, процентные пункты. */
const pp = z.tuple([z.number().int().min(-20).max(20), z.number().int().min(-20).max(20)]);
/** Черта кандидата: вес при выборе, зарплата и скорость в процентах, поправка чтения снимка, навык (от, до), рост. */
const trait = z.strictObject({
  weight: int,
  salary: z.number().int().min(50).max(200).optional(),
  speed: z.number().int().min(50).max(200).optional(),
  reading: pp.optional(),
  skills: z.tuple([z.number().int().min(1).max(5), z.number().int().min(1).max(5)]).optional(),
  growth: z.number().int().min(1).max(5).optional(),
  /** нанятый врач: поправка порога уверенности, п. п.; «забыл спросить», п. п. */
  threshold: z.number().int().min(-20).max(20).optional(),
  forget: z.number().int().min(-100).max(100).optional(),
});

/** Баланс своей больницы: числа игровые, настраиваются симулятором экономики. */
export const economySchema = z.strictObject({
  /** клетка коридора: постройка и содержание в день, ₽ */
  corridor: z.strictObject({ cost: int, upkeep: int }),
  /** сколько процентов цены возвращают снос и продажа аппарата */
  refund: pct,
  /** персонал: кандидаты, навык, скорость и точность по навыку, рост, черты (spec 2026-09-own-hospital, часть 8) */
  staff: z.strictObject({
    candidates: z.tuple([int, int]),
    skills: z.tuple([int, int, int, int, int]),
    speed: z.tuple([int, int, int, int, int]),
    reading: z.tuple([pp, pp, pp, pp, pp]),
    /** хирург по навыку 1–5: доля осложнений после операции, % от записанной у операции (часть 28) */
    surgery: z.tuple([int, int, int, int, int]),
    growthDays: z.number().int().min(1),
    noTrait: int,
    traits: z.strictObject({
      careful: trait, fast: trait, novice: trait, experienced: trait,
    }),
    /** нанятые врачи по навыку 1–5: порог уверенности, %; наименьшая польза обследования, тысячные бита; «забыл спросить», % */
    doctor: z.strictObject({
      threshold: z.tuple([pct, pct, pct, pct, pct]),
      minGain: z.tuple([int, int, int, int, int]),
      forget: z.tuple([pct, pct, pct, pct, pct]),
    }),
  }),
  /** тарифы: ОМС по тяжести диагноза, доля по обоснованности и без подтверждения; ДМС и платно — обращение и прайс, % цены */
  tariffs: z.strictObject({
    oms: z.strictObject({ minor: int, moderate: int, serious: int, critical: int }),
    /** случай стационара: по тяжести диагноза, при выписке (spec 2026-09-chapter-2, часть 26) */
    omsWard: z.strictObject({ minor: int, moderate: int, serious: int, critical: int }),
    /** случай стационара с операцией — прибавка к тарифу за операцию (часть 28) */
    omsOperation: int,
    omsQuality: z.strictObject({ A: pct, B: pct, C: pct, D: pct }),
    omsUnconfirmed: pct,
    omsExam: int,
    dms: z.strictObject({ visit: int, price: int }),
    self: z.strictObject({ visit: int, price: int }),
  }),
  /** уровень амбулатории для ОМС: доля тарифа за обращение, % — базовая и прибавки за работающие помещения */
  level: z.strictObject({ base: pct, rooms: z.record(z.string(), pct) }),
  /** доля ДМС и платных, % — при репутации 0, 50, 100 */
  payers: z.strictObject({ dms: z.tuple([int, int, int]), self: z.tuple([int, int, int]) }),
  /** расходники обследования, % цены — по виду */
  consumables: z.strictObject({ ask: int, physical: int, bedside: int, lab: int, rapid: int, functional: int, imaging: int }),
  /** процент на долг в день, сотые доли процента */
  interest: int,
  /** стационар: койко-день — питание и расходники лежащего, ₽; доля тарифа за прерванный случай, % */
  ward: z.strictObject({ bedDay: int, interrupted: pct }),
  /**
   * скорая (spec 2026-09-chapter-2, часть 27): машин за смену, если работает смотровая приёмного;
   * вес болезни по тяжести (с распространённостью) и доля тяжёлых среди тех, у кого тяжесть есть, %
   */
  ambulance: z.strictObject({
    perDay: z.tuple([int, int]),
    weight: z.strictObject({ minor: int, moderate: int, serious: int, critical: int }),
    severe: pct,
  }),
  /** репутация: начало, шаг к оценке дня, %; поправки оценки за ожидание и санузел */
  reputation: z.strictObject({
    start: pct, pull: z.number().int().min(1).max(100),
    waitShort: z.number().int(), waitShortMin: int, waitLong: z.number().int(), waitLongMin: int, noToilet: z.number().int(),
  }),
  /** поток пациентов от репутации: ± % при 0 и 100 */
  flow: z.number().int().min(0).max(90),
  /** песочница: участок, вход, отрезок коридора прямоугольниками, бюджеты; с готовой амбулаторией — доля бюджета, % */
  sandbox: z.strictObject({
    plot: z.tuple([z.number().int().min(8).max(64), z.number().int().min(8).max(64)]),
    entrance: cellSrc,
    corridor: z.array(z.tuple([int, int, int, int])).min(1),
    budgets: z.strictObject({ modest: int, normal: int, generous: int }),
    clinicShare: pct,
  }),
});

// --- кампания (spec 2026-09-campaign) ---------------------------------------------------------

const slug = z.string().regex(/^[a-z][a-zA-Z0-9]*$/);
const count = z.number().int().min(1);

/** Персонаж кампании — наставник, главврач: не человек, портрет рисуется кодом по зерну. */
export const characterSchema = z.strictObject({
  id: z.string().regex(/^char\.[a-z0-9_]+$/),
  name: text,
  /** как подписывает письма: «Анна Сергеевна» */
  short: text,
  sex: z.enum(['m', 'f']),
  age: z.number().int().min(18).max(100),
  portrait: int,
  role: text,
});

/** Условие дня для заданий «N дней»: без непоказанного антибиотика, без ушедших, касса в плюсе. */
const dayKind = z.enum(['noNeedlessAntibiotic', 'noLeft', 'cashPositive']);

/** Задание главы: вид — в движке, числа и текст — здесь. */
const missionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id: slug, main: z.boolean(), kind: z.literal('seen'), count, accuracy: pct, text }),
  z.strictObject({ id: slug, main: z.boolean(), kind: z.literal('roomWorks'), room: roomId, text }),
  z.strictObject({ id: slug, main: z.boolean(), kind: z.literal('streak'), days: count, day: dayKind, text }),
  z.strictObject({ id: slug, main: z.boolean(), kind: z.literal('days'), days: count, day: dayKind, text }),
]);

/** Письмо: от кого, когда — в начале главы, после дня N, при задании, в конце главы. */
const letterSchema = z.strictObject({
  id: slug,
  from: z.string().regex(/^char\.[a-z0-9_]+$/),
  when: z.union([z.literal('start'), z.literal('end'), z.strictObject({ afterDay: count }), z.strictObject({ mission: slug })]),
  text,
});

/** Глава кампании: больница, бюджет, что можно строить, задания и письма. */
export const chapterSchema = z.strictObject({
  id: z.string().regex(/^chapter\.[a-z0-9_]+$/),
  order: count,
  name: text,
  place: text,
  preset: z.string().regex(/^preset\.[a-z0-9_]+$/),
  budget: int,
  department: z.string().regex(/^dept\.[a-z0-9_]+$/),
  build: z.array(roomId).min(1),
  /** первые пациенты главы — заданные болезни (обучение с наставником) */
  tutorial: z.array(z.string().regex(/^cond\.[a-z0-9_]+$/)).default([]),
  missions: z.array(missionSchema).min(1),
  letters: z.array(letterSchema).default([]),
});

/**
 * Подсказка наставника в первую смену главы: когда показать — открылась карта пациента, после
 * первых вопросов, у пациента с болезнью, на «Решении», на разборе.
 */
export const tipSchema = z.strictObject({
  id: z.string().regex(/^tip\.[a-z0-9_]+$/),
  /** порядок: какая первой, если подходят две */
  order: count,
  from: z.string().regex(/^char\.[a-z0-9_]+$/),
  name: text,
  when: z.union([
    z.literal('caseOpen'), z.literal('afterAsk'), z.literal('decision'), z.literal('review'),
    z.strictObject({ condition: z.string().regex(/^cond\.[a-z0-9_]+$/) }),
  ]),
  text,
  /** о чём подсказка — статьи энциклопедии */
  see: z.array(z.string()).default([]),
});

// --- достижения (spec 2026-09-campaign, часть 13) --------------------------------------------

const achievementBase = {
  id: z.string().regex(/^ach\.[a-z0-9_]+$/),
  /** порядок в списке профиля */
  order: count,
  category: z.enum(['practice', 'diagnosis', 'care', 'knowledge', 'hospital', 'campaign', 'daily']),
  name: text,
  /** что нужно сделать — у неполученного, без счётчиков «осталось» */
  need: text,
};

/** «Сколько раз»: приёмов, дней, верных подряд и т. п. */
const counted = <K extends string>(kind: K) => z.strictObject({ ...achievementBase, kind: z.literal(kind), count });

/** Достижение: вид и числа — движку (src/engine/career/achievements.ts), тексты — игроку. */
export const achievementSchema = z.discriminatedUnion('kind', [
  counted('cases'), counted('days'), counted('correctRun'), counted('gradeA'), counted('thriftCase'), counted('allergyAsked'), counted('noLeftDay'),
  counted('seenConditions'), counted('dailyCases'),
  z.strictObject({ ...achievementBase, kind: z.literal('department'), department: z.string().regex(/^dept\.[a-z0-9_]+$/) }),
  z.strictObject({ ...achievementBase, kind: z.literal('roomWorks'), room: roomId }),
  z.strictObject({ ...achievementBase, kind: z.literal('chapter'), chapter: z.string().regex(/^chapter\.[a-z0-9_]+$/) }),
]);

/**
 * Шкала раннего предупреждения по витальным (NEWS2, spec 2026-09-chapter-2, часть 27): баллы по
 * измеренному значению признака — [от, до, баллы], `null` — без границы; отдельные строки — дышит
 * кислородом и спутанность; уровни ответа — средний с `medium` баллов или `single` по одному
 * параметру, высокий — с `high`.
 */
export const scoreSchema = z.strictObject({
  id: z.string().regex(/^score\.[a-z0-9_]+$/),
  name: text,
  params: z.array(z.strictObject({
    f: z.string(),
    points: z.array(z.tuple([z.number().nullable(), z.number().nullable(), z.number().int().min(0).max(3)])).min(2),
  })).min(1),
  oxygen: z.number().int().min(0).max(3),
  confusion: z.number().int().min(0).max(3),
  levels: z.strictObject({ medium: z.number().int().min(1), single: z.number().int().min(1), high: z.number().int().min(1) }),
  texts: z.strictObject({ summary: text, hint }),
  sources: z.array(source).min(1),
  review,
});

/**
 * Правило решения (spec 2026-09-chapter-2, часть 32): оттавские правила — при жалобе `complaints`
 * обследования `exams` нужны, если есть хоть один признак из `any`; проверили все — и ни одного,
 * перелом маловероятен. Правило проверено у тех, кому не меньше `ageMin` лет.
 */
export const ruleSchema = z.strictObject({
  id: z.string().regex(/^rule\.[a-z0-9_]+$/),
  name: text,
  complaints: z.array(z.string()).min(1),
  /** основные признаки: хватит одного */
  any: z.array(z.string()).min(1),
  /** дополнительные признаки: нужно не меньше `count` (часть 32г) */
  minor: z.strictObject({ any: z.array(z.string()).min(1), count: z.number().int().min(2) }).optional(),
  /** возраст: старше `main` — основной признак, в пределах `minor` — дополнительный (часть 32г) */
  age: z.strictObject({ main: z.number().int().min(1).max(120).optional(), from: z.number().int().min(1).max(120).optional(), minor: z.tuple([z.number().int().min(0), z.number().int().max(120)]).optional() }).optional(),
  /** применимо, только если есть хоть один из этих признаков (часть 32г: лёгкая ЧМТ) */
  requires: z.array(z.string()).min(1).optional(),
  /** какое обследование правило назначает; пусто — его в игре нет (КТ, часть 32г), тогда `texts.exam` */
  exams: z.array(z.string().regex(/^exam\.[a-z0-9_]+$/)).default([]),
  ageMin: z.number().int().min(0).max(120).optional(),
  /** о каких болезнях — для энциклопедии */
  about: z.array(z.string().regex(/^cond\.[a-z0-9_]+$/)).min(1),
  /**
   * yes — есть признак: «Снимок нужен»; no — проверили все, признаков нет; na — правило не
   * применимо; exam — что за обследование, если в игре его нет
   */
  texts: z.strictObject({ summary: text, hint, yes: text, no: text, na: text.optional(), exam: text.optional() }),
  sources: z.array(source).min(1),
  review,
});

export const versionSchema = z.strictObject({ contentVersion: z.number().int().min(1) });

export type ConditionSrc = z.infer<typeof conditionSchema>;
export type TreatmentSrc = z.infer<typeof treatmentSchema>;
export type FindingSrc = z.infer<typeof findingSchema>;
export type ExamSrc = z.infer<typeof examSchema>;
export type RiskSrc = z.infer<typeof riskSchema>;
export type RoomSrc = z.infer<typeof roomSchema>;
export type EquipmentSrc = z.infer<typeof equipmentSchema>;
export type RoleSrc = z.infer<typeof roleSchema>;
export type PresetSrc = z.infer<typeof presetSchema>;
export type EconomySrc = z.infer<typeof economySchema>;
export type CharacterSrc = z.infer<typeof characterSchema>;
export type ChapterSrc = z.infer<typeof chapterSchema>;
export type TipSrc = z.infer<typeof tipSchema>;
export type AchievementSrc = z.infer<typeof achievementSchema>;
export type ScoreSrc = z.infer<typeof scoreSchema>;
export type RuleSrc = z.infer<typeof ruleSchema>;
export type LinkSrc = z.infer<typeof link>;
export type ProbabilitySrc = z.infer<typeof probability>;
