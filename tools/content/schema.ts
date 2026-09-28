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
  stages: z.array(z.string()).optional(),
  when: z.record(z.string(), z.array(z.string())).optional(),
  attrs: z.record(z.string(), attrSpec).optional(),
});
const riskMultiplier = z.strictObject({ id: z.string(), x: z.number().positive() });
const txId = z.string().regex(/^tx\.[a-z0-9_]+$/);
/** Где лечить: дома, направить в стационар, вызвать скорую (перевод). */
export const SETTINGS = ['home', 'ward', 'ambulance'] as const;
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
  course: z.strictObject({
    stages: z.array(z.strictObject({ id: z.string(), days: z.tuple([z.number(), z.number()]), needs: z.literal('treatment').optional() })).min(1),
    /** в какие дни болезни обычно обращаются */
    presentation: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
    /** проходит само: без лечения — выздоровление к концу стадий */
    selfLimiting: z.boolean().optional(),
    /** без действенного лечения: с какой вероятностью и на какой день становится хуже */
    untreated: z.strictObject({ band: probability, days: z.tuple([z.number().int().min(0), z.number().int().min(0)]) }).optional(),
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
    setting: z.strictObject({
      default: setting,
      /** уточнение по скрытому параметру случая: значение → место */
      param: z.strictObject({ name: z.string(), map: z.record(z.string(), setting) }).optional(),
      /** если у пациента есть красный флаг этого состояния */
      redFlag: setting.optional(),
      /** если у пациента есть фактор риска: пиелонефрит у беременной — в стационар */
      risks: z.array(z.strictObject({ id: z.string().regex(/^risk\.[a-z0-9_]+$/), setting })).optional(),
    }),
  }).optional(),
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
  /** кому делают: только этому полу (о месячных и беременности — женщин) */
  sex: z.enum(['m', 'f']).optional(),
  /** кому делают по возрасту, лет включительно: вне его не предлагается */
  ageMin: z.number().int().min(0).max(120).optional(),
  ageMax: z.number().int().min(0).max(120).optional(),
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
  kind: z.enum(['drug', 'regimen', 'procedure']),
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
  })).default([]),
  /** противопоказание — фактор риска (аллергия) или состояние; reaction — вероятность вреда, если назначить */
  contraindications: z.array(z.strictObject({
    id: z.string().regex(/^(risk|cond)\.[a-z0-9_]+$/),
    level: z.enum(['relative', 'absolute']),
    reaction: probability,
  })).default([]),
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

export const OBJECT_KINDS = ['bed', 'chair', 'desk', 'couch', 'cabinet', 'machine', 'plant', 'sink', 'bench', 'xray', 'table', 'ecg', 'analyzer'] as const;
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
  sizes: z.array(roomSize).min(1),
  texts: z.strictObject({ hint }),
});

export const equipmentSchema = z.strictObject({
  id: eqId,
  name: text,
  gen,
  room: roomId,
  /** как выглядит на карте: у каждого вида аппарата свой рисунок (spec 2026-09-living-map) */
  sprite: z.enum(['ecg', 'analyzer', 'xray']),
  /** улучшение другого аппарата: цифровой рентген — плёночного */
  upgradeOf: eqId.optional(),
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
export type LinkSrc = z.infer<typeof link>;
export type ProbabilitySrc = z.infer<typeof probability>;
