import { pluralRu } from '../plural';
import { lowerFirst } from '../case';

const decimal = (x: number) => String(x).replace('.', ',');

export const encyclopedia = {
  title: 'Энциклопедия',
  // 11-publishing.md §3: та же мысль, что в оговорке, одной строкой вверху каждого раздела
  disclaimer: 'Сведения упрощены для игры: это не справочник и не замена врачу.',
  search: 'Поиск по энциклопедии',
  nothing: 'Ничего не нашлось',
  articles: (n: number) => `${n}\u00a0${pluralRu(n, 'статья', 'статьи', 'статей')}`,
  sections: {
    conditions: 'Болезни',
    findings: 'Признаки',
    exams: 'Обследования',
    treatments: 'Лечение',
    risks: 'Факторы риска',
    scores: 'Шкалы и правила',
    hospital: 'Больница',
    tips: 'Подсказки',
  },
  chronic: 'Хронические болезни',
  findingGroup: { sym: 'Жалобы', hx: 'Анамнез', sign: 'Осмотр', vital: 'Показатели', lab: 'Анализы', img: 'Снимки', ecg: 'ЭКГ' },
  findingKind: { sym: 'Жалоба', hx: 'Анамнез', sign: 'Находка при осмотре', vital: 'Показатель', lab: 'Анализ', img: 'Снимок', ecg: 'ЭКГ' },
  examGroup: { ask: 'Расспрос', examine: 'Осмотр', lab: 'Анализы и экспресс-тесты', imaging: 'Снимки и функциональные' },
  examKind: { ask: 'Расспрос', physical: 'Осмотр', bedside: 'У постели', lab: 'Анализ', rapid: 'Экспресс-тест', functional: 'Функциональное', imaging: 'Снимок' },
  txKind: { drug: 'Лекарство', regimen: 'Режим и советы', procedure: 'Процедура', surgery: 'Операция' },
  severity: { minor: 'лёгкое', moderate: 'средней тяжести', serious: 'серьёзное', critical: 'угрожает жизни' },
  band: {
    always: 'Почти всегда',
    usually: 'Обычно',
    often: 'Часто',
    sometimes: 'Иногда',
    rarely: 'Редко',
    veryRarely: 'Исключительно редко',
    never: 'Не бывает',
  },
  when: {
    severe: 'при тяжёлом течении',
    moderate: 'при среднетяжёлом течении',
    mild: 'при лёгком течении',
    stemi: 'при инфаркте с подъёмом ST',
    nste: 'при ОКС без подъёма ST',
    // скрытые параметры «есть / нет» — по паре «параметр:значение» (части 30б и 30в)
    'obstruction:yes': 'при непроходимости кишки',
    'ischemia:yes': 'при ишемии кишки',
    'ischemia:no': 'без ишемии кишки',
    // почечная колика и парапроктит (часть 30г)
    'infection:yes': 'при инфекции мочевых путей',
    'infection:no': 'без инфекции',
    'depth:superficial': 'при подкожном и подслизистом',
    'depth:deep': 'при глубоком',
    // дивертикулит (часть 30д)
    'form:uncomplicated': 'при неосложнённом',
    'form:infiltrate': 'при инфильтрате',
    'form:abscess_small': 'при абсцессе до 3\u00a0см',
    'form:abscess_large': 'при абсцессе больше 3\u00a0см',
    'form:peritonitis': 'при перитоните',
    // переломы (часть 32): смещение отломков и стабильность
    'displacement:none': 'без смещения',
    'displacement:displaced': 'при смещении',
    'displacement:unstable': 'при нестабильном переломе',
    'stability:stable': 'при стабильном переломе',
    'stability:unstable': 'при нестабильном переломе',
  } as Record<string, string>,
  /** несколько условий одной фразой (часть 30д): «при» — один раз, последнее — через «и» */
  whenList: (words: string[]) => {
    const rest = words.slice(1).map(w => w.replace(/^при /, ''));
    return `${[words[0], ...rest.slice(0, -1)].join(', ')} и ${rest[rest.length - 1]}`;
  },
  icd: (code: string) => `МКБ-10: ${code}`,

  // статья болезни — разделы в порядке 05-content.md §4
  what: 'Что это',
  signs: 'Признаки',
  who: 'У кого бывает',
  peakAfter: (from: number) => `Чаще после ${from}\u00a0лет.`,
  peakBetween: (from: number, to: number) => `Чаще в ${from}–${to}\u00a0лет.`,
  onlyWomen: 'Почти только у женщин.',
  moreWomen: 'Чаще у женщин.',
  onlyMen: 'Почти только у мужчин.',
  moreMen: 'Чаще у мужчин.',
  season: { winter: 'Чаще зимой.', spring: 'Чаще весной.', summer: 'Чаще летом.', autumn: 'Чаще осенью.' },
  requires: 'Бывает только при',
  riskFactors: 'Факторы риска',
  times: (x: number) => `в ${decimal(x)}\u00a0раза чаще`,
  confirm: 'Как подтвердить',
  clinical: 'Отдельного подтверждающего обследования нет: диагноз ставят по жалобам и осмотру, исключив опасное.',
  similar: 'С чем спутать',
  treatment: 'Лечение',
  firstLine: 'Первая линия',
  plan: 'Обычно назначают',
  acceptable: 'Можно также',
  supportive: 'Облегчить состояние',
  notIndicated: 'Не нужно',
  harmful: 'Опасно',
  setting: { home: 'дома', ward: 'в стационаре', ambulance: 'скорая, больница', admit: 'в стационаре', surgery: 'операция', transfer: 'скорая, перевод в центр' },
  whereTitle: 'Где лечить',
  whereDefault: (s: string) => `Обычно — ${s}.`,
  whereIf: (when: string, s: string) => `${when[0].toUpperCase()}${when.slice(1)} — ${s}.`,
  whereRedFlag: (s: string) => `При красных флагах — ${s}.`,
  // ещё место, которое не ошибка (часть 32б): «При смещении без красных флагов — можно и дома.»
  whereAlso: (when: string, s: string, flags = false, risks = false) =>
    `${when[0].toUpperCase()}${when.slice(1)}${flags || risks ? ` без ${[flags ? 'красных флагов' : '', risks ? 'факторов риска' : ''].filter(Boolean).join(' и ')}` : ''} — можно и ${s}.`,
  whereRisk: (risk: string, s: string) => `Если есть «${risk}» — ${s}.`,
  // операция и срок стационара (spec 2026-09-chapter-2, части 26 и 28)
  // срока нет (часть 32: закрытый перелом) — без срока
  whereSurgery: (op: string, hours: number | undefined, onset = false) =>
    hours === undefined ? `Операция — ${lowerFirst(op)}.` : `Операция — ${lowerFirst(op)}: в первые ${hours}\u00a0ч ${onset ? 'от начала болезни' : 'после поступления'}.`,
  whereStay: (lo: number, hi: number) => `В стационаре обычно ${lo === hi ? lo : `${lo}–${hi}`}\u00a0${pluralRu(hi, 'день', 'дня', 'дней')}.`,
  // наблюдение в палате и стационар после операции (часть 30в)
  whereObserve: (hours: number) => `Без показаний к экстренной операции — лечение в палате; не помогло — операция не позже ${hours}\u00a0ч после поступления.`,
  whereStayOperated: (lo: number, hi: number) => `После операции — ${lo === hi ? lo : `${lo}–${hi}`}\u00a0${pluralRu(hi, 'день', 'дня', 'дней')}.`,
  // осложнённая стадия (часть 28б): риск по часам без операции, срок после неё, исходы операции
  whereStayComplicated: (name: string, lo: number, hi: number) => `После операции, если была ${name}, — ${lo === hi ? lo : `${lo}–${hi}`}\u00a0${pluralRu(hi, 'день', 'дня', 'дней')}.`,
  complicationRisk: (name: string, hours: number, early: string, every: number, later: string) =>
    `${name[0].toUpperCase()}${name.slice(1)} без операции: за первые ${hours}\u00a0ч — до ${early}\u00a0%, дальше — ${later}\u00a0% за каждые ${every}\u00a0ч.`,
  // по сроку (часть 30б): прободная язва позже суток — поздняя госпитализация
  complicationAfter: (name: string, hours: number, when?: string) =>
    `${when ? `${when[0].toUpperCase()}${when.slice(1)} позже` : 'Позже'} ${hours}\u00a0ч от начала болезни — ${name}.`,
  // каждый час до операции (часть 30б, Buck 2013)
  opDelay: (pctHour: string) => `Каждый час от поступления до операции выживаемость ниже на ${pctHour}\u00a0%.`,
  opOutcomes: 'Исходы',
  opComplications: (plain: string, complicated?: string, name?: string) =>
    `Осложнения после операции — ${plain}\u00a0%${complicated && name ? `; если была ${name}, — ${complicated}\u00a0%` : ''}.`,
  opDeaths: (plain: string, complicated?: string, name?: string) =>
    `Умирают в стационаре — ${plain}\u00a0%${complicated && name ? `; если была ${name}, — ${complicated}\u00a0%` : ''}.`,
  surgeryRow: 'Операция',
  opTreats: 'Чем лечат и в какой срок',
  opWindow: (hours: number, onset = false, observe?: number) =>
    `в первые ${hours}\u00a0ч ${onset ? 'от начала болезни' : 'после поступления'}${observe !== undefined ? `; после наблюдения — до ${observe}\u00a0ч` : ''}`,
  opTeam: 'Бригада',
  course: 'Без лечения',
  selfLimiting: 'Обычно проходит само.',
  // по скрытому параметру (часть 30д): «При неосложнённом — обычно проходит само.»
  selfLimitingIf: (when: string) => `${when[0].toUpperCase()}${when.slice(1)} — обычно проходит само.`,
  untreated: (band: string, from: number, to: number, when?: string) =>
    `${when ? `${when[0].toUpperCase()}${when.slice(1)} без` : 'Без'} действенного лечения ${band.toLowerCase()} становится хуже — на ${from}–${to}-й день.`,
  redFlags: 'Красные флаги',
  redFlagsNote: 'Признаки опасного течения: с ними тактика другая.',
  pearls: 'Что запомнить',
  sources: 'Источники',

  // признак
  redFlag: 'красный флаг',
  howFound: 'Как выявить',
  inConditions: 'При каких болезнях',
  fromRisks: 'Бывает и от',
  redFlagFor: 'Красный флаг при',

  // обследование
  minutes: (n: number) => `${n}\u00a0мин`,
  checks: 'Что проверяет',
  accuracy: (sens: number, spec: number) => `чувствительность ${sens}\u00a0%, специфичность ${spec}\u00a0%`,
  accuracyNote: 'Чувствительность — какую долю больных обследование находит; специфичность — какую долю здоровых не принимает за больных.',
  confirms: 'Подтверждает',

  // лечение
  usedAs: 'Где в лечении',
  firstLineFor: 'Первая линия при',
  planFor: 'Обычно назначают при',
  acceptableFor: 'Можно при',
  supportiveFor: 'Облегчает при',
  harmfulFor: 'Опасно при',
  contraindications: 'Противопоказания',
  level: { absolute: 'нельзя', relative: 'с осторожностью' },

  // фактор риска
  riskKind: 'Фактор риска',
  // шкалы (часть 27)
  scoreKind: 'Шкала',
  scoreGroup: 'Шкалы',
  // правила решения (spec 2026-09-chapter-2, часть 32): оттавские правила
  ruleGroup: 'Правила',
  ruleKind: 'Правило решения',
  ruleWhen: 'Когда применяют',
  ruleAge: (years: number) => `Проверено у тех, кому ${years}\u00a0лет и больше.`,
  ruleAny: 'Если есть хоть один признак',
  ruleNone: 'Если проверили все и ни одного нет',
  ruleExams: 'Какое обследование',
  ruleAbout: 'При каких болезнях',
  rulesFor: 'Правила решения',
  inRules: 'В правилах решения',
  // тактика по скрытому параметру (часть 32): «Первая линия, со смещением»
  byParamRow: (role: string, when: string) => `${role}, ${when}`,
  scorePoints: 'Баллы',
  scoreUpTo: (v: string) => `${v} и меньше`,
  scoreFrom: (v: string) => `${v} и больше`,
  scoreOxygen: (n: number) => `Дышит кислородом — ${n}`,
  scoreConfusion: (n: number) => `Спутанность, ответ только на голос или боль, нет ответа — ${n}`,
  scoreLevels: 'Что значит сумма',
  scoreLevelsText: (medium: number, single: number, high: number) =>
    `0–${medium - 1} — низкий риск; ${medium}–${high - 1} — средний: срочно к врачу, как и при ${single} по одному показателю; ${high} и больше — высокий: экстренно.`,
  scoreUses: 'По каким признакам',
  shows: 'Как проявляется',
  raises: 'Чаще бывают',
  limits: 'Мешает лечению',

  // больница: помещения, аппараты, должности (spec 2026-09-own-hospital)
  hospitalGroup: { rooms: 'Помещения', equipment: 'Аппараты', roles: 'Должности' },
  whereDone: 'Где делают',
  collectHere: 'берут материал',
  roomKind: 'Помещение',
  fromPrice: (rub: string) => `от ${rub}`,
  doneHere: 'Что здесь делают',
  collectsFor: 'Здесь берут материал на',
  needs: 'Что нужно, чтобы работало',
  needPeople: 'Люди',
  needMachine: 'Аппарат — хотя бы один',
  needMachines: 'Аппараты — все сразу',
  machines: 'Аппараты',
  sizes: 'Размеры и цена',
  sizeLine: (id: string, w: number, h: number, cost: string, upkeep: string, seats: number, beds = 0, bays = 0) =>
    `${id} — ${w}\u00a0×\u00a0${h}\u00a0м, ${cost}, содержание ${upkeep} в\u00a0день${seats > 0 ? `, ${seats}\u00a0${pluralRu(seats, 'место', 'места', 'мест')}` : ''}${beds > 0 ? `, ${beds}\u00a0${pluralRu(beds, 'койка', 'койки', 'коек')}` : ''}${bays > 0 ? `, ${bays}\u00a0${pluralRu(bays, 'место', 'места', 'мест')} для скорой` : ''}.`,
  sizeNote: 'Размер — вместе со стенами; соседние помещения делят стену.',
  equipmentKind: 'Аппарат',
  examsBy: 'Что им делают',
  standsIn: 'Где стоит',
  upgrades: 'Улучшение для',
  upgradedBy: 'Можно заменить на',
  prices: 'Цена',
  priceLine: (price: string, upkeep: string) => `${price}, обслуживание — ${upkeep} в\u00a0день.`,
  slower: (x: number) => `Обследование идёт в\u00a0${decimal(x)}\u00a0раза дольше обычного.`,
  faster: (x: number) => `Обследование идёт в\u00a0${decimal(x)}\u00a0раза быстрее обычного.`,
  worse: (sens: number, spec: number) => `Точность ниже обычной: чувствительность — на\u00a0${sens}, специфичность — на\u00a0${spec}\u00a0${pluralRu(spec, 'процентный пункт', 'процентных пункта', 'процентных пунктов')}.`,
  better: (sens: number, spec: number) => `Точность выше обычной: чувствительность — на\u00a0${sens}, специфичность — на\u00a0${spec}\u00a0${pluralRu(spec, 'процентный пункт', 'процентных пункта', 'процентных пунктов')}.`,
  roleKind: 'Должность',
  worksIn: 'Где работает',
  salary: 'Зарплата',
  salaryLine: (from: string, to: string) => `От ${from} до ${to} за смену — по навыку.`,
  perShift: (from: string, to: string) => `${from}–${to} за смену`,

  // подсказки наставника (spec 2026-09-campaign)
  tipKind: 'Подсказка наставника',
  tipText: 'Совет',
  tipWhenTitle: 'Когда подсказывает',
  tipWhen: {
    caseOpen: 'Открылась карта пациента.',
    afterAsk: 'Врач задал первые вопросы и ещё не осматривал.',
    condition: (name: string) => `У пациента с болезнью «${name}» — после первого вопроса или осмотра.`,
    decision: 'Первый раз на экране «Решение».',
    review: 'Первый разбор приёма.',
  },
  tipNote: 'Подсказки приходят в первую смену главы 1, каждая — один раз за карьеру; в первой можно выбрать «Без подсказок».',
  tipSee: 'О чём подсказка',

  // переходы
  more: 'Подробнее в энциклопедии',
  truthArticle: (name: string) => `В энциклопедии: ${name}`,
};
