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

/**
 * Распространённость → относительный вес основного заболевания. С частью 41в (spec 2026-10-chapter-3)
 * — ещё две полосы для редких угроз жизни: скорая везёт тяжёлых охотнее, и внутримозговое и
 * субарахноидальное кровоизлияние иначе приходили бы втрое-вдесятеро чаще, чем по 523_3. С частью 43а —
 * ещё одна: расслоение аорты в 50 раз реже острого коронарного синдрома (946_1), а с `ultra_rare` у скорой
 * было бы 5,5 на 100 ОКС вместо 2.
 */
export const PREVALENCE = {
  very_common: 1000,
  common: 300,
  uncommon: 100,
  rare: 30,
  very_rare: 10,
  extremely_rare: 3,
  ultra_rare: 1,
  exceptionally_rare: 0.3,
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
  // «-$имя» — сторона напротив (spec 2026-10-chapter-3, часть 41в): гематома — в полушарии напротив слабости
  z.string().regex(/^-?\$[a-z_]+$/, 'ссылка на параметр пишется как $имя, сторона напротив — как -$имя'),
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
/** обязательное (часть 38б): лечение или группа «одно из» — не меньше двух, первое — выбора (часть 39в) */
const required = z.array(z.union([txId, z.array(txId).min(2)])).min(1);
/**
 * Где лечить — что нужно пациенту; `admit` («в палату») — только выбор врача, в базе его нет;
 * `icu` — палата интенсивной терапии (spec 2026-10-chapter-3, часть 38а): своя — «В ПИТ», нет её —
 * перевод, из амбулатории — скорая.
 */
export const SETTINGS = ['home', 'ward', 'ambulance', 'surgery', 'transfer', 'icu'] as const;
const setting = z.enum(SETTINGS);
const season = z.strictObject({ winter: z.number(), spring: z.number(), summer: z.number(), autumn: z.number() });

/** Что будет без действенного лечения (часть 30д; часть 41б — списком и другой болезнью). */
const untreatedSchema = z.strictObject({
  band: probability,
  days: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
  when: z.record(z.string(), z.array(z.string())).optional(),
  as: z.string().regex(/^cond\.[a-z0-9_]+$/).optional(),
});

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
  /**
   * с этим приходят только со скорой (spec 2026-10-chapter-3, часть 41а): инсульт привозят в
   * смотровую приёмного, к монитору, — пришедших самих с ним нет
   */
  arrival: z.literal('ambulance').optional(),
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
   * признаки правила не известны. Порог на измерении (часть 38б): «yes», если число признака `f`
   * у пациента ниже `below` — сатурация ниже 90 %
   */
  derived: z.record(z.string(), z.union([
    z.string().regex(/^rule\.[a-z0-9_]+$/),
    /**
     * `clock` (spec 2026-10-chapter-3, часть 41а) — порог по числу с ходом времени: к часам от
     * начала прибавляются часы от прихода до решения; окно тромболизиса — 4,5 часа до его начала
     */
    // `seen` (часть 41в) — разбор судит по измеренному: давление снижают по тонометру
    // порог — ниже `below` или (часть 43в) выше `above`, один из двух; с ходом времени — только «ниже»
    z.strictObject({ f: z.string().regex(/^[a-z]+\.[a-z0-9_]+$/), below: z.number().optional(), above: z.number().optional(), clock: z.literal(true).optional(), seen: z.literal(true).optional() })
      .refine(d => (d.below === undefined) !== (d.above === undefined), { message: 'порог — либо below, либо above' })
      .refine(d => !d.clock || d.below !== undefined, { message: 'порог со временем — только below' }),
    /**
     * по другим параметрам (часть 41а): «yes», если у каждого из `all` — одно из названных значений;
     * тромбэктомия — окклюзия, NIHSS 6 и больше и меньше 6 часов от начала
     */
    z.strictObject({ all: z.record(z.string(), z.array(z.string()).min(1)) }),
    /**
     * хоть у одного из `any` — одно из названных значений (spec 2026-10-chapter-3, часть 43в): ПИТ при острой
     * сердечной недостаточности — отёк лёгких, гипоперфузия, частота дыхания выше 25 или сатурация ниже 90
     */
    z.strictObject({ any: z.record(z.string(), z.array(z.string()).min(1)) }),
    /**
     * по баллам шкалы (часть 41б): «yes», если баллов правила у пациента не меньше `from` — высокий
     * риск по ABCD2 с 6 баллов
     */
    z.strictObject({ rule: z.string().regex(/^rule\.[a-z0-9_]+$/), from: z.number().int().min(1) }),
    /**
     * по признаку (spec 2026-10-chapter-3, часть 44а): «yes», если признак `has` у пациента есть, от какой бы
     * причины, — пьёт таблетки сульфонилмочевины
     */
    z.strictObject({ has: z.string().regex(/^[a-z]+\.[a-z0-9_]+$/) }),
  ])).optional(),
  course: z.strictObject({
    stages: z.array(z.strictObject({ id: z.string(), days: z.tuple([z.number(), z.number()]), needs: z.literal('treatment').optional() })).min(1),
    /** в какие дни болезни обычно обращаются */
    presentation: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
    /**
     * проходит само: без лечения — выздоровление к концу стадий; `{ when }` — только при этих
     * значениях скрытого параметра (часть 30д: неосложнённый дивертикулит — да, абсцесс — нет)
     */
    selfLimiting: z.union([z.boolean(), z.strictObject({ when: z.record(z.string(), z.array(z.string())) })]).optional(),
    /**
     * без действенного лечения: с какой вероятностью и на какой день становится хуже; `when` — при
     * каких значениях параметра. Списком (часть 41б) — первая подошедшая запись; `as` — хуже значит
     * другая болезнь: после ТИА без профилактики возвращаются с инсультом
     */
    untreated: z.union([untreatedSchema, z.array(untreatedSchema).min(2)]).optional(),
    /** в стационаре при действенном лечении: через сколько суток можно выписывать (spec 2026-09-chapter-2, часть 26) */
    stay: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional(),
    /**
     * острый период проходит в стационаре и без действия на причину (spec 2026-10-chapter-3, часть
     * 41а): инсульт под наблюдением в ПИТ стабилизируется к сроку `stay`, последствия остаются; дома —
     * `untreated`
     */
    settles: z.literal(true).optional(),
    /**
     * часов от начала до прихода (spec 2026-10-chapter-3, часть 39а): интервалы — верхняя граница в
     * часах и доля; число — у признака `f` (`hx.*`), его больной называет при расспросе
     */
    onset: z.strictObject({
      f: z.string().regex(/^hx\.[a-z0-9_]+$/),
      hours: z.array(z.tuple([z.number().positive(), z.number().int().positive()])).min(1),
    }).optional(),
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
     * обязательно при лечении здесь (часть 38б): без этого лечение неполное — кислород через
     * маску при сатурации ниже порога рекомендации; группа — хоть одно из неё, первое — выбора
     * (часть 39в: антикоагулянт при ОКС без подъёма ST)
     */
    require: required.optional(),
    /**
     * обязательно и при переводе — сделать до него (spec 2026-10-chapter-3, часть 41в: консультация
     * нейрохирурга при кровоизлиянии — и тем, кого оставляют, и тем, кого переводят); по параметру —
     * в его записи; группа — одно из (часть 42в: атропин, стимуляция или допамин при АВ-блокаде)
     */
    beforeTransfer: required.optional(),
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
      /** обязательно при этих значениях — вдобавок к общему (часть 38б); группа — одно из (часть 39в) */
      require: required.optional(),
      /**
       * что сделать до приезда скорой при этих значениях — хоть одно (часть 32д-2): обширный ожог
       * лечат не дома, хотя место по умолчанию — дом, и до перевода ставят капельницу
       */
      preHospital: z.array(txId).min(1).optional(),
      /** обязательно и при переводе — сделать до него (часть 39а): тромболизис в окне 12 часов; группа — одно из (часть 42в) */
      beforeTransfer: required.optional(),
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
      /**
       * место, когда пришёл результат одного из `exams` (spec 2026-10-chapter-3, часть 40): вместо
       * места по параметру — `setting`, вместо красного флага — признаки `flags`. КТ без крови —
       * сотрясение лечат дома, а оглушённого кладут под наблюдение (734_2, приложение Б); `also` —
       * как и до обследования
       */
      after: z.strictObject({
        exams: z.array(z.string().regex(/^exam\.[a-z0-9_]+$/)).min(1),
        setting,
        flags: z.strictObject({ any: z.array(z.string()).min(1), setting }).optional(),
      }).optional(),
      /**
       * где у постели нет этих аппаратов — это место (spec 2026-10-chapter-3, часть 42б): приступ
       * наджелудочковой тахикардии снимают под монитором; в кабинете — вагусные пробы, и в ПИТ
       */
      without: z.strictObject({ equipment: z.array(z.string().regex(/^eq\.[a-z0-9_]+$/)).min(1), setting }).optional(),
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
  /**
   * исход перевода по часам до реперфузии (spec 2026-10-chapter-3, часть 39б): при этих значениях
   * параметров (подъём ST) артерию открывают тромболизисом здесь или вмешательством в сосудистом
   * центре; смертность — в границах класса параметра `by` (Killip, 157_5, приложение А3), %, тем
   * ближе к верхней, чем позже реперфузия: `loss` — до какого часа (не включая) какая доля потери, %
   */
  reperfusion: z.strictObject({
    when: z.record(z.string(), z.array(z.string()).min(1)),
    by: z.string(),
    death: z.record(z.string(), z.tuple([z.number().min(0).max(100), z.number().min(0).max(100)])),
    loss: z.array(z.tuple([z.number().int().min(1).max(48), z.number().int().min(0).max(100)])).min(1),
    /** тромболизис: какое лечение, у скольких удаётся, %, и за сколько часов открывает артерию */
    lysis: z.strictObject({ tx: txId, pct: z.number().min(0).max(100), hours: z.number().int().min(0).max(6) }),
  }).optional(),
  /**
   * фибрилляция желудочков до реперфузии (часть 39б): доля в час, %, пока от начала болезни меньше
   * `hours` часов; под монитором — разряд, без него — смерть
   */
  arrest: z.strictObject({
    when: z.record(z.string(), z.array(z.string()).min(1)),
    perHour: z.number().min(0).max(100),
    hours: z.number().int().min(1).max(48),
  }).optional(),
  /** у того, с чем приходят, — не меньше трёх (валидатор); у хронического фона хватит одного */
  findings: z.array(link).min(1),
  /** признаки, которых при этом состоянии не бывает, откуда бы ни пришли (часть 39а): шок гасит высокое давление */
  masks: z.array(z.string()).min(1).optional(),
  confirm: z.union([z.array(z.string()).min(1), z.literal('clinical')]),
  redFlags: z.array(z.string()).optional(),
  /**
   * с чем спутать по рекомендации (часть 33б) — вдобавок к похожим по признакам: острую ишемию ноги
   * отличают от тромбоза глубоких вен (1006_1, раздел 2.2), хотя признаки у них разные
   */
  differential: z.array(z.string().regex(/^cond\.[a-z0-9_]+$/)).min(1).optional(),
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
  /** атрибут для записей до его появления (часть 39а): старые сохранения — без него */
  fallback: z.record(z.string(), z.string()).optional(),
  /** признак-последователь (часть 39а): есть, когда есть хоть один из этих */
  follows: z.array(z.string().regex(/^(sym|sign|vital|lab|img|ecg|hx)\.[a-z0-9_]+$/)).min(1).optional(),
  /** не улика (часть 39а): вывод его не учитывает, нужно только его число */
  evidence: z.literal(false).optional(),
  value: z.strictObject({
    unit: z.string(),
    ref: z.tuple([z.number(), z.number()]),
    present: z.tuple([z.number(), z.number()]),
    absent: z.tuple([z.number(), z.number()]),
    decimals: z.number().int().min(0).max(3),
    /** производные числа для шаблона: {dia} = значение × множитель (давление: нижнее из верхнего) */
    derived: z.record(z.string().regex(/^[a-z]+$/), z.number().positive()).optional(),
    /**
     * порог на измерении другого признака (часть 33б): число одно на двоих — низкое давление меряют
     * тем же тонометром, что высокое; «есть» — значение в диапазоне `present`
     */
    of: z.string().optional(),
    /**
     * порог дальше от нормы и не снимает то измерение (spec 2026-10-chapter-3, часть 42б): пульс 150 и чаще —
     * это и «чаще 100»; только с `of`
     */
    implies: z.literal(true).optional(),
    /**
     * крупная единица для шаблона {amount} (часть 42а): с `from` — число, делённое на `per`, с единицей
     * `unit`; часы от начала с двух суток — сутками
     */
    long: z.strictObject({ from: z.number().positive(), per: z.number().positive(), unit: z.string().min(1) }).optional(),
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
  /** делают каждому, у кого увидели один из признаков (часть 42б): неритмичный пульс или 150 и чаще — ЭКГ */
  routineSeen: z.array(z.string()).min(1).optional(),
  /** кому делают: только этому полу (о месячных и беременности — женщин) */
  sex: z.enum(['m', 'f']).optional(),
  /** кому делают по возрасту, лет включительно: вне его не предлагается */
  ageMin: z.number().int().min(0).max(120).optional(),
  ageMax: z.number().int().min(0).max(120).optional(),
  /** кому делают: только пришедшим с одной из этих жалоб (часть 32г: расспрос о травме головы) */
  complaints: z.array(z.string().regex(/^sym\.[a-z0-9_]+$/)).min(1).optional(),
  /**
   * чувствительность и специфичность — в процентах; `given` (spec 2026-10-chapter-3, часть 41в) —
   * уточнение: проверяют, только если это же обследование показало тот признак (объём гематомы —
   * когда на КТ кровь)
   */
  checks: z.array(z.strictObject({ f: z.string(), sens: accuracy, spec: accuracy, given: z.string().optional() })).min(1),
  /**
   * у постели (spec 2026-10-chapter-3, часть 37): лежащему в смотровой приёмного, где стоит этот
   * аппарат, обследование делают на месте — врачом, без очереди в кабинет и без описания
   */
  bedside: z.strictObject({
    room: roomId,
    equipment: z.array(eqId).min(1),
    time: z.strictObject({ procedure: z.number().int().min(1) }),
  }).optional(),
  /**
   * повторный забор по тому же назначению (spec 2026-10-chapter-3, часть 39в): через `minutes` минут;
   * его проверки — из `checks` обследования, приходят с ним; `name` — как назвать его результат
   */
  repeat: z.strictObject({
    minutes: z.number().int().min(1),
    checks: z.array(z.string()).min(1),
    name: text,
  }).optional(),
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
  /** как вводят; `sc` — под кожу (часть 33а: низкомолекулярный гепарин, фондапаринукс натрия) */
  route: z.enum(['oral', 'inhaled', 'nasal', 'iv', 'im', 'sc']).optional(),
  cost: z.number().int().min(0),
  /**
   * cure — действует на причину: переводит болезнь к выздоровлению с вероятностью за столько дней;
   * harm (spec 2026-10-chapter-3, часть 41в) — вредит при этой болезни: с такой вероятностью
   * реакция, как при противопоказании (тромболизис при кровоизлиянии в мозг — кровотечение)
   */
  effects: z.array(z.strictObject({
    on: z.string().regex(/^cond\.[a-z0-9_]+$/),
    kind: z.enum(['cure', 'relieve', 'harm']),
    band: probability,
    days: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
    /** действует, только если у болезни такое значение скрытого параметра (часть 30в: без ишемии кишки) */
    when: z.record(z.string(), z.array(z.string())).optional(),
    /**
     * вред — другая болезнь (часть 42а), только у `harm`: кардиоверсия при фибрилляции предсердий 48
     * часов и дольше без антикоагулянта — инсульт; дома — возврат с ней за `days`, в палате — на обходе
     */
    as: z.string().regex(/^cond\.[a-z0-9_]+$/).optional(),
  })).default([]),
  /** противопоказание — фактор риска (аллергия) или состояние; reaction — вероятность вреда, если назначить */
  contraindications: z.array(z.strictObject({
    id: z.string().regex(/^(risk|cond)\.[a-z0-9_]+$/),
    level: z.enum(['relative', 'absolute']),
    reaction: probability,
  })).default([]),
  /** только у постели с этими аппаратами (часть 39а): тромболизис — под монитором с дефибриллятором */
  bedside: z.strictObject({ equipment: z.array(eqId).min(1) }).optional(),
  /** назначают только вместе с этим (часть 39а); группа — хоть одно из неё, первое — выбора */
  companions: z.array(z.union([txId, z.array(txId).min(2)])).min(1).optional(),
  /** спутники — только при этих болезнях (часть 42б): антикоагулянт рядом с кардиоверсией — при фибрилляции предсердий */
  companionsFor: z.array(z.string().regex(/^cond\.[a-z0-9_]+$/)).min(1).optional(),
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

export const OBJECT_KINDS = ['bed', 'chair', 'desk', 'couch', 'cabinet', 'machine', 'plant', 'sink', 'bench', 'xray', 'table', 'ecg', 'analyzer', 'or_table', 'anesthesia', 'us', 'monitor', 'ct'] as const;
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
  /**
   * палата интенсивной терапии (spec 2026-10-chapter-3, часть 38а): койки — места лежащих под
   * монитором; койка работает, если на её месте (`slots` по порядку коек) стоит монитор
   */
  icu: z.boolean().default(false),
  /** работает — в больницу приходят и больные этих отделений: приёмное — хирургию (часть 30) */
  admits: z.array(z.string().regex(/^dept\.[a-z0-9_]+$/)).min(1).optional(),
  sizes: z.array(roomSize).min(1),
  texts: z.strictObject({ hint }),
});

export const equipmentSchema = z.strictObject({
  id: eqId,
  name: text,
  gen,
  /** куда ставят: монитор с дефибриллятором — в смотровую приёмного и в палату интенсивной терапии (часть 38а) */
  rooms: z.array(roomId).min(1),
  /** как выглядит на карте: у каждого вида аппарата свой рисунок (spec 2026-09-living-map) */
  sprite: z.enum(['ecg', 'analyzer', 'xray', 'or_table', 'anesthesia', 'us', 'monitor', 'ct']),
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
    /** случай с палатой интенсивной терапии по показаниям — прибавка к тарифу (spec 2026-10-chapter-3, часть 38а) */
    omsIcu: int,
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
  /** палата интенсивной терапии (часть 38а): койко-день — дороже палатного, ₽ */
  icu: z.strictObject({ bedDay: int }),
  /** перевод в сосудистый центр (часть 39б): часов пути и часов от приезда до вмешательства */
  transfer: z.strictObject({ hours: z.number().int().min(1).max(12), pci: z.number().int().min(0).max(6) }),
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
    died: z.number().int().max(0),
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
// noWaitComplication (spec 2026-09-chapter-2, часть 34): операции были, и ни у кого болезнь не
// осложнилась, пока он ждал в больнице
const dayKind = z.enum(['noNeedlessAntibiotic', 'noLeft', 'cashPositive', 'noWaitComplication']);

/** Задание главы: вид — в движке, числа и текст — здесь. */
const missionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id: slug, main: z.boolean(), kind: z.literal('seen'), count, accuracy: pct, text }),
  z.strictObject({ id: slug, main: z.boolean(), kind: z.literal('roomWorks'), room: roomId, text }),
  z.strictObject({ id: slug, main: z.boolean(), kind: z.literal('streak'), days: count, day: dayKind, text }),
  z.strictObject({ id: slug, main: z.boolean(), kind: z.literal('days'), days: count, day: dayKind, text }),
  // глава 2 (spec 2026-09-chapter-2, часть 34): смена без ошибок сортировки со столькими пациентами
  // скорой; столько операций без осложнения; столько выписанных подряд со сроком не выше обычного
  z.strictObject({ id: slug, main: z.boolean(), kind: z.literal('triage'), count, text }),
  z.strictObject({ id: slug, main: z.boolean(), kind: z.literal('operations'), count, text }),
  z.strictObject({ id: slug, main: z.boolean(), kind: z.literal('stay'), count, text }),
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
  /** кнопка перехода в главу в конце прежней: «Перейти в районную больницу» (часть 34) */
  move: text.optional(),
  preset: z.string().regex(/^preset\.[a-z0-9_]+$/),
  budget: int,
  department: z.string().regex(/^dept\.[a-z0-9_]+$/),
  build: z.array(roomId).min(1),
  /**
   * первые пациенты главы — заданные болезни (обучение с наставником): строкой — пришедший сам;
   * с часть 34б — и привезённый скорой (`ambulance`), и с заданными скрытыми параметрами
   */
  tutorial: z.array(z.union([
    z.string().regex(/^cond\.[a-z0-9_]+$/),
    z.strictObject({
      condition: z.string().regex(/^cond\.[a-z0-9_]+$/),
      ambulance: z.literal(true).optional(),
      params: z.record(z.string(), z.string()).optional(),
      age: z.tuple([z.number().int().min(0).max(110), z.number().int().min(0).max(110)]).optional(),
    }),
  ])).default([]),
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
  /** только в этой главе (часть 34б); нет — в первую смену любой главы с обучением */
  chapter: z.string().regex(/^chapter\.[a-z0-9_]+$/).optional(),
  name: text,
  // ambulance — ждёт сортировки привезённый скорой; rounds — обход (часть 34б)
  when: z.union([
    z.literal('caseOpen'), z.literal('afterAsk'), z.literal('decision'), z.literal('review'), z.literal('ambulance'), z.literal('rounds'),
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

/** баллы шкалы за возраст: столько баллов с этого возраста (часть 41б) */
const pointsAge = z.strictObject({ from: z.number().int().min(1).max(120), w: z.number().int().min(1) });

/**
 * Правило решения (spec 2026-09-chapter-2, часть 32): оттавские правила — при жалобе `complaints`
 * обследования `exams` нужны, если есть хоть один признак из `any`; проверили все — и ни одного,
 * перелом маловероятен. Правило проверено у тех, кому не меньше `ageMin` лет. С части 33а — и
 * признаки, при которых правило не применяют (`excludes`).
 */
export const ruleSchema = z.strictObject({
  id: z.string().regex(/^rule\.[a-z0-9_]+$/),
  name: text,
  complaints: z.array(z.string()).min(1),
  /** основные признаки: хватит одного; у шкалы с баллами (часть 41б) их может не быть */
  any: z.array(z.string()).default([]),
  /** дополнительные признаки: нужно не меньше `count` (часть 32г) */
  minor: z.strictObject({ any: z.array(z.string()).min(1), count: z.number().int().min(2) }).optional(),
  /**
   * баллы шкалы (spec 2026-10-chapter-3, часть 41б): у пункта вес; пункт с `unless` не считается,
   * если есть хоть один из тех признаков (ABCD2: речь — балл, только если слабости нет); `age` —
   * столько баллов с этого возраста, с части 42а — и полосами по возрастанию (CHA₂DS₂-VASc: 65–74 —
   * 1, 75 и старше — 2); `sex` — баллы за пол (женский — 1). Правило выполнено от `from` баллов, с
   * части 42а — и своим порогом у пола (`fromSex`: антикоагулянт женщинам — с 3 баллов)
   */
  points: z.strictObject({
    items: z.array(z.strictObject({ f: z.string(), w: z.number().int().min(1), unless: z.array(z.string()).min(1).optional() })).min(1),
    age: z.union([pointsAge, z.array(pointsAge).min(2)]).transform(a => (Array.isArray(a) ? a : [a])).optional(),
    sex: z.strictObject({ m: z.number().int().min(1).optional(), f: z.number().int().min(1).optional() }).optional(),
    from: z.number().int().min(1),
    fromSex: z.strictObject({ m: z.number().int().min(1).optional(), f: z.number().int().min(1).optional() }).optional(),
  }).optional(),
  /** возраст: старше `main` — основной признак, в пределах `minor` — дополнительный (часть 32г) */
  age: z.strictObject({ main: z.number().int().min(1).max(120).optional(), from: z.number().int().min(1).max(120).optional(), minor: z.tuple([z.number().int().min(0), z.number().int().max(120)]).optional() }).optional(),
  /** применимо, только если есть хоть один из этих признаков (часть 32г: лёгкая ЧМТ) */
  requires: z.array(z.string()).min(1).optional(),
  /** пункты проверяют, только когда правило уже применимо (часть 39а: тромболизис — при подъёме ST) */
  onlyIfApplies: z.literal(true).optional(),
  /**
   * не применяется, если есть хоть один из этих признаков (часть 33а): тяж по ходу подкожной вены —
   * тромбофлебит, УЗИ нужно всем и без шкалы; при беременности D-димер не используют
   */
  excludes: z.array(z.string()).min(1).optional(),
  /** какое обследование правило назначает; пусто — его в игре нет (КТ, часть 32г), тогда `texts.exam` */
  exams: z.array(z.string().regex(/^exam\.[a-z0-9_]+$/)).default([]),
  /** о каком лечении правило решает, а не об обследовании (часть 39а): «Можно ли тромболизис» */
  decides: z.string().regex(/^tx\.[a-z0-9_]+$/).optional(),
  /** решает, где лечить (spec 2026-10-chapter-3, часть 43б): sPESI — дома или в стационаре */
  place: z.literal(true).optional(),
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

/**
 * Срок (spec 2026-10-chapter-3, часть 37): что сделать и за сколько минут от прихода — кому с
 * жалобой `complaints` при поступлении, лежащему в помещении `room` (смотровая приёмного: там
 * монитор и ЭКГ у постели). Сделано — пришёл результат одного из `exams`.
 */
export const targetSchema = z.strictObject({
  id: z.string().regex(/^target\.[a-z0-9_]+$/),
  name: text,
  /** кому: по жалобе при поступлении или (часть 39б) по находке, которую показали обследования */
  complaints: z.array(z.string().regex(/^sym\.[a-z0-9_]+$/)).default([]),
  findings: z.array(z.string().regex(/^[a-z]+\.[a-z0-9_]+$/)).default([]),
  /**
   * кроме тех, у кого обследование показало одну из этих находок (spec 2026-10-chapter-3, часть 44б): КТ при
   * перекошенном лице не нужна, если невролог нашёл периферический парез, — «при типичной клинической картине…
   * в экстренном порядке нецелесообразно» (895_1, раздел 2.4)
   */
  except: z.array(z.string().regex(/^[a-z]+\.[a-z0-9_]+$/)).min(1).optional(),
  room: roomId.optional(),
  /** что: обследование — пришёл результат; назначение или место (часть 39б) — решение */
  exams: z.array(z.string().regex(/^exam\.[a-z0-9_]+$/)).default([]),
  treatments: z.array(txId).default([]),
  settings: z.array(setting).default([]),
  /** отсчёт: от прихода или от результата с находкой (часть 39б) */
  from: z.enum(['arrival', 'finding']).default('arrival'),
  /**
   * только тем, кто остаётся у нас (spec 2026-10-chapter-3, часть 41а): в палате, ПИТ или
   * операционной; переведённому тест глотания делают там, куда везут
   */
  stays: z.literal(true).optional(),
  minutes: z.number().int().min(1).max(24 * 60),
  texts: z.strictObject({ hint, from: text.optional(), after: text.optional() }),
  sources: z.array(source).min(1),
  review,
}).refine(x => x.complaints.length + x.findings.length > 0, { message: 'срок — кому: жалоба или находка' })
  .refine(x => x.exams.length + x.treatments.length + x.settings.length > 0, { message: 'срок — что: обследование, назначение или место' })
  .refine(x => x.from === 'arrival' || (x.findings.length > 0 && x.texts.from !== undefined && x.texts.after !== undefined), {
    message: 'срок от находки — с находками и словами «от чего» (texts.from, texts.after)',
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
export type TargetSrc = z.infer<typeof targetSchema>;
export type LinkSrc = z.infer<typeof link>;
export type ProbabilitySrc = z.infer<typeof probability>;
