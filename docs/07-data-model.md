# Данные

Три вида данных: **медицинская база** (одинакова у всех, едет в приложении), **состояние
партии** (сохранение), **профиль и настройки** (общие для всех партий). Правила
наполнения базы — [`05-content.md`](05-content.md); смысл полей — в
[`04-medical-model.md`](04-medical-model.md). Типы ниже — договор. Где код уже есть,
источник правды — он: `tools/content/schema.ts` (что пишут в YAML),
`src/content/types.ts` (что получает движок), позже `src/engine/core/state.ts`; этот
документ объясняет «почему», а ещё не сделанное помечает «позже».

## 1. Медицинская база

### Сборка

```
content/**/*.yaml ──► tools/content/build.ts ──► src/content/generated/bundle.json
   исходник              схема, ссылки,              одна собранная база
   (по файлу             полосы → числа,             + contentVersion
    на запись)           вычисляемые поля            + хеш содержимого
```

- `bundle.json` не хранится в репозитории: его собирают скрипты `prestart`, `pretest`
  и CI. Правка руками бессмысленна.
- `contentVersion` — целое, растёт при каждом выпуске с изменённой базой (ставится в
  `content/version.yaml` вместе с версией игры). Хеш содержимого ловит «забыл поднять
  номер»: CI сверяет хеш с прошлым выпуском.
- Схема записей описана в коде (`tools/content/schema.ts`), из неё же генерируется
  JSON Schema — редактор подсказывает поля прямо в YAML.

### Общие типы

```ts
type Id = string;                        // 'cond.pneumonia_cap'
type Text = { ru: string; en?: string };
type Band = 'always' | 'usually' | 'often' | 'sometimes' | 'rarely' | 'very_rarely' | 'never';
type P = number;                         // вероятность в долях 1/10 000: 0…10000
type Minutes = number;                   // игровые минуты
type Source = { kind: 'guideline' | 'textbook' | 'paper' | 'dataset' | 'score';
                title: string; org?: string; year?: number; url?: string; note?: string };
type Review = 'draft' | 'checked' | 'reviewed';
```

Полосы переводятся в `P` при сборке по таблице из `04` §4: `always` 9500, `usually`
7500, `often` 5000, `sometimes` 2500, `rarely` 800, `very_rarely` 200, `never` 0.

### Состояние

```ts
interface Condition {
  id: Id; name: Text; icd10?: string;
  department: Id;                       // 'dept.therapy'
  group?: Id;                            // одинаковая тактика: путаница внутри — частичная точность
  system?: BodySystem;                   // система органов: списки диагнозов, энциклопедия
  kind: 'disease' | 'injury' | 'syndrome' | 'state';
  severity: 'minor' | 'moderate' | 'serious' | 'critical';
  checkup?: boolean;                     // бывает без жалоб — находят на профосмотре
  epidemiology: {
    prevalence: P;                      // из полосы распространённости
    age: { min: number; max?: number; peak?: [number, number] };
    sex?: { m: number; f: number };     // относительные веса
    season?: { winter: number; spring: number; summer: number; autumn: number };
    risks?: { id: Id; x: number }[];    // множители: фактор риска или состояние
    requires?: Id[];                    // без этого не бывает (обострение ХОБЛ — при ХОБЛ)
    excludes?: Id[];                    // не бывает у того, у кого это уже есть
    chronic?: boolean;                  // бывает сопутствующим
  };
  params?: Record<string, Record<string, number>>;       // скрытые параметры: значение → вес
  course: {
    stages: { id: string; days: [number, number]; needs?: 'treatment' }[];
    presentation?: [number, number];    // в какие дни болезни обычно обращаются
    selfLimiting?: boolean;             // проходит само к концу последней стадии
    selfLimitingWhen?: Record<string, string[]>;   // с 0.0.52: проходит само только при этих значениях параметра
    untreated?: { p: P; days: [number, number]; when?: Record<string, string[]> };  // без действенного лечения: ухудшение и на какой день; when — с 0.0.52
    stay?: [number, number];            // обычный срок стационара, сутки, — по рекомендации (0.0.43);
                                        // нет — срок действия лечения причины, иначе неделя
    // позже (приёмное и скорая, этап 4) — осложнения новыми состояниями:
    // complications?: { after: [number, number]; when?: Cond; add: Id; p: P }[];
  };
  surgery?: { tx: Id; byParam?: { when: Record<string, string[]>; tx: Id }[]; window?: number; from?: 'onset'; observe?: number; stay?: [number, number] }; // лечат операцией tx; «в срок» — не позже window часов (0.0.45) от поступления или от начала болезни (0.0.48), срока нет — если его нет в рекомендации (0.0.54); лечили в палате без нужды в экстренной — не позже observe часов (0.0.50); после операции — stay суток от её суток (0.0.50); byParam (0.0.55) — своя операция при таких значениях параметра: шейка бедра без смещения — винты
  // осложнённая стадия по часам без лечения (0.0.46): по риску — за первые early.hours — early.p,
  // дальше later.p за каждые later.every часов; или по сроку (0.0.49) — наверняка через after
  // часов от начала болезни; только при значениях параметров when (0.0.50); после операции в ней — свой срок стационара
  complication?: { name: Text; early?: { hours: number; p: P }; later?: { every: number; p: P }; after?: number; when?: Record<string, string[]>; stay?: [number, number] };
  findings: Link[];                     // связи «состояние → признак»
  vitals?: VitalShift[];                // сдвиги витальных по стадиям и тяжести
  confirm: Id[] | 'clinical';
  redFlags?: Id[];
  expect?: { exam?: Id; treatment?: Id; within: Minutes | 'day' }[];
  treatment: Tactics;                   // обязательно у всех, с чем приходят (валидатор)
  texts: { summary: Text; lay?: Text };  // lay — как называют пациенты
  pearls?: Text[];                       // «что запомнить»: 2–3 вывода для разбора и энциклопедии
  simplified?: string;                   // что упрощено и почему
  sources: Source[]; review: Review;
  replacedBy?: Id;
}

// Тактика (04-medical-model.md §8). Назначение, не названное ни в одном списке, — «не показано».
interface Tactics {
  firstLine: Id[];                       // препарат или метод выбора; при переводе — что до скорой
  acceptable: Id[];                      // замена при противопоказании к первой линии
  supportive: Id[];                      // облегчает самочувствие, на причину не действует
  notIndicated: Id[]; harmful: Id[];     // одно лечение — не больше чем в одном списке
  plan?: Id[];                           // типичное назначение, если первая линия — выбор из равных
  byParam?: {                            // с 0.0.54: при таких значениях скрытого параметра у
    when: Record<string, string[]>;      // названных лечений — эта роль, у остальных — из общих
    firstLine: Id[]; acceptable: Id[]; supportive: Id[]; notIndicated: Id[]; harmful: Id[];
    plan?: Id[];                         // списков; своё типичное назначение
  }[];
  setting: {                             // где лечить; берётся самое высокое из подходящих
    default: Setting;
    param?: { name: string; map: Record<string, Setting> };  // по скрытому параметру: тяжесть
    redFlag?: Setting;                   // если у пациента есть красный флаг состояния
    risks?: { id: Id; setting: Setting }[];  // по фактору риска: пиелонефрит у беременной
    also?: { when: Record<string, string[]>; settings: Setting[] }[];  // с 0.0.55: места, которые при этих
                                         // значениях тоже не ошибка (ключица со смещением — и дома),
                                         // пока нет красного флага и фактора риска из правила
  };
  score?: Id;                            // позже: шкала, по которой решают (CRB-65)
}
// Системы органов в порядке показа; у всего, с чем приходят, — обязательна (валидатор).
type BodySystem = 'airways' | 'lungs' | 'heart' | 'digestive' | 'urinary' | 'metabolic' | 'nerves' | 'bones';  // bones — с 0.0.54
// В базе — что нужно пациенту: дома, стационар, срочно в стационар, операция, перевод в
// центр (0.0.43). Выбор игрока — что есть в больнице: в амбулатории «домой», «направить в
// стационар», «вызвать скорую»; со своей палатой ещё «в палату» — `admit`, его в базе нет.
// Операционная и перевод из своей больницы — части 27–28 (spec 2026-09-chapter-2).
type Setting = 'home' | 'ward' | 'ambulance' | 'admit' | 'surgery' | 'transfer';

interface Link {
  f: Id;                                 // признак
  p: P;                                  // из полосы или точного числа
  stages?: string[];                     // на каких стадиях
  when?: Cond;                           // условие по скрытым параметрам
  age65?: { p: P };                      // поправка для пожилых (пример поправки)
  attrs?: Record<string, string | Record<string, number>>;   // '$side' — из параметра
  value?: { dist: 'normal' | 'uniform'; mean?: number; sd?: number; min?: number; max?: number };
}
type Cond = Record<string, string[]>;    // { severity: ['moderate', 'severe'] }
```

### Признак

```ts
interface Finding {
  id: Id; name: Text;
  kind: 'sym' | 'sign' | 'vital' | 'lab' | 'img' | 'ecg' | 'hx';   // hx — ответ об анамнезе
  system?: string;                       // позже: respiratory, cardiac, …
  leak: P;                               // фон популяции
  salience: 0 | 1 | 2 | 3;               // насколько заметно: 2–3 — назовёт сам, жалоба
  redFlag?: boolean;
  attrs?: Record<string, Record<string, Text>>;   // допустимые атрибуты и их подписи
  value?: {                              // числовой показатель: давление, анализ
    unit: string; ref: [number, number];
    present: [number, number]; absent: [number, number]; decimals: number;
    derived?: Record<string, number>;    // {dia} = значение × 0,62 — нижнее давление
  };
  texts: {
    complaint?: TemplateSet;             // от лица пациента
    present: TemplateSet;                // строка осмотра или протокола
    absent?: TemplateSet;                // отрицательный результат
    hint: Text;                          // «Что это?» простыми словами (05-content.md §4)
  };
  sources?: Source[]; review: Review; replacedBy?: Id;
}
type TemplateSet = { ru: string[]; en?: string[] };   // варианты, шаблоны с родом и числом
```

### Обследование

```ts
interface Exam {
  id: Id; name: Text;
  kind: 'ask' | 'physical' | 'bedside' | 'lab' | 'rapid' | 'functional' | 'imaging' | 'endoscopy' | 'score';
  room?: Id;                                     // где делают; нет — в кабинете врача
  equipment?: Id[];                              // каким аппаратом: подходит любой из списка
  collect?: Id;                                  // где берут материал: анализы — в процедурном
  time: { procedure: Minutes; report?: Minutes; turnaround?: Minutes };
  cost: number; consumables?: number;
  discomfort: 0 | 1 | 2 | 3; radiation?: 'none' | 'low' | 'medium' | 'high';
  routine?: boolean;                             // спрашивают каждого (анамнез жизни)
  sex?: 'm' | 'f'; ageMin?: number; ageMax?: number;  // кому делают: о беременности — женщинам 12–50
  contraindications?: { id: Id; level: 'relative' | 'absolute' }[];   // позже: рентген при беременности
  checks: { f: Id; sens: P; spec: P }[];         // какие признаки проверяет и как точно
  modifiers?: { by: Id; sens?: number; spec?: number }[];  // ожирение, навык, уровень аппарата
  texts: { summary: Text; hint: Text };          // как делают; что показывает — простыми словами
  sources: Source[]; review: Review; replacedBy?: Id;
}
```

### Фактор риска

```ts
interface Risk {
  id: Id; name: Text;                    // курение, аллергия на пенициллины, беременность
  prevalence: { m: number; f: number };  // доля людей, %
  ageMin?: number; ageMax?: number;      // беременность — 18–44
  findings: Link[];                      // как проявляется: ответ на вопрос, тест
  sources: Source[]; review: Review;
}
```

### Клиническая задача

```ts
interface ClinicalTask {
  id: Id; title: Text; department: Id; difficulty: 1 | 2 | 3;
  patient: { sex: 'm' | 'f'; age: number; name?: string; risks: Id[]; allergies: Id[]; traits?: Id[] };
  truth: { conditions: { id: Id; role: 'primary' | 'comorbid'; stage: string;
                         params?: Record<string, string> }[] };
  pinned: { f: Id; present: boolean; attrs?: Record<string, string> }[];  // то, что есть в истории
  story: Text;                           // история пациента или сопроводительный лист
  budget?: number;                       // лимит на обследования
  pearls: Text[];
  sources: Source[]; review: Review; replacedBy?: Id;
}
```

### Лечение, помещения, оборудование, роли

```ts
interface Treatment {
  id: Id; name: Text;                    // МНН или группа, без доз (ADR 0012)
  kind: 'drug' | 'regimen' | 'procedure' | 'surgery'; // операция — с 0.0.45
  class?: string;                        // 'antibiotic.penicillin'
  route?: 'oral' | 'inhaled' | 'nasal' | 'iv' | 'im';
  cost: number;
  // cure — на причину: к выздоровлению с вероятностью p за days дней; relieve — облегчает
  effects: { on: Id; kind: 'cure' | 'relieve'; p: P; days: [number, number]; when?: Record<string, string[]> }[]; // when — только при таких значениях параметров болезни (0.0.50)
  // противопоказание — фактор риска (аллергия) или состояние; reaction — вероятность
  // вреда, если назначить, когда оно у пациента есть (знал врач или нет)
  contraindications: { id: Id; level: 'relative' | 'absolute'; reaction: P }[];
  texts: { hint: Text };                 // «Что это?» простыми словами (05-content.md §4)
  sources: Source[]; review: Review; replacedBy?: Id;
  // операция (0.0.45): где, какая бригада, какие аппараты — все сразу, минуты, доля осложнений
  surgery?: {
    room: Id; team: Id[]; equipment: Id[]; minutes: number; complications: P;
    death?: P;                                           // умерли в стационаре (0.0.46)
    complicated?: { complications: P; death?: P };       // в осложнённой стадии на момент разреза
  };
  // позже: room?, staff?, time? (процедуры в кабинетах), findings в effects
  // (жаропонижающее снимает температуру), sideEffects: { add: Id; p: P; if?: Id }[]
}

// Каталог больницы — content/hospital/ (spec 2026-09-own-hospital). gen — родительный
// падеж для причин «не работает: нет лаборанта». Цены и зарплаты — баланс игры.
interface RoomType {
  id: Id; name: Text; gen: Text;
  staff: Id[];                           // кто нужен: по человеку на должность
  needsEquipment: boolean;               // без аппарата не работает (лаборатория, ЭКГ, рентген)
  seats: boolean;                        // стулья — места в очереди (зона ожидания)
  beds: boolean;                         // койки — палата (0.0.43)
  emergency: boolean;                    // койки — места для скорой: смотровая приёмного (0.0.44)
  admits?: Id[];                         // работает — больница принимает и эти отделения: приёмное — хирургию (0.0.48)
  sizes: RoomSize[];
  texts: { hint: Text };
  // производное при сборке: какие аппараты сюда ставят, какие обследования здесь делают
  // и для каких здесь берут материал
  equipment: Id[]; exams: Id[]; collects: Id[];
}
// Клетки со стенами, от левого верхнего угла стен; дверная сторона в исходном повороте —
// нижняя. Первый ряд внутри — под подпись на карте, последний — проход у двери: там пусто.
interface RoomSize {
  id: 'S' | 'M' | 'L'; w: number; h: number;
  cost: number; upkeep: number;          // постройка и содержание в день, ₽
  door: { x: number; width: number };    // дверь по умолчанию на нижней стене
  objects: { kind: ObjectKind; x: number; y: number }[];
  slots: Cell[];                         // места под аппараты
  staff: Record<Id, Cell>;               // где стоит человек каждой должности
  patient?: Cell;                        // куда встаёт или садится пациент
  seats: number;                         // производное: стулья зоны ожидания
  beds: number;                          // производное: койки палаты или места смотровой
  places: number;                        // мест для нанятых врачей — ординаторская (0.0.32)
}
interface Equipment {
  id: Id; name: Text; gen: Text; room: Id; sprite: 'ecg' | 'analyzer' | 'xray' | 'or_table' | 'anesthesia' | 'us'; upgradeOf?: Id;
  slot?: number;                         // своё место в помещении (стол — под пациентом, 0.0.45)
  price: number; upkeep: number;
  breakdown: P;                          // шанс поломки за день работы; поломок в 0.2.0 нет
  speed: number;                         // множитель времени обследования
  quality: { sens: number; spec: number };   // поправка к точности, процентные пункты
  exams: Id[];                           // производное: что им делают
  texts: { hint: Text };
}
interface StaffRole {
  id: Id; name: Text; gen: Text;
  hire: boolean;                         // врача не нанимают: это игрок
  salary: [number, number];              // за смену при навыке 1 и 5
  stands?: Id;                           // встаёт на место этой должности: терапевт — врача (0.0.32)
  needs?: Id;                            // без места в этом помещении не работает: ординаторская
  reads?: true;                          // описывает снимки помещения: рентгенолог, врач УЗД (0.0.47)
  rooms: Id[];                           // производное: где работает (встающий — там же, где та должность)
  texts: { hint: Text };
}
```

Нанятые врачи (spec 2026-09-hired-doctors, 0.0.32): в `economy.yaml`, `staff.doctor`, — по навыку
1–5 порог уверенности (%), наименьшая польза обследования (тысячные бита) и доля «забыл
спросить о противопоказаниях» (%); у черт — поправки `threshold` и `forget`.

## 2. Состояние партии

Один сериализуемый объект. Показаны главные части; правда пациента хранится рядом с
тем, что о нём знает игрок, но наружу выходит только «вид» (`06-architecture.md` §7).

```ts
interface GameState {
  meta: {
    schemaVersion: number; contentVersion: number; rngVersion: number;
    mode: 'campaign' | 'shift' | 'daily' | 'sandbox';   // сейчас: 'shift' — практика, 'sandbox' — песочница (слот `sandbox`)
    difficulty: 'student' | 'resident' | 'doctor' | 'professor';
    soft: boolean;                       // «мягкий режим»
    seed: number; chapter?: Id;
  };
  clock: { t: number; day: number; speed: 0 | 1 | 2 | 4 };   // t — игровые секунды
  rng: Record<string, [number, number, number, number]>;      // состояние ветвей
  events: ScheduledEvent[];              // очередь событий (куча)
  hospital: {                            // src/engine/hospital/build.ts (0.0.19)
    w: number; h: number; entrance: Cell;
    corridor: number[];                  // клетки коридора: y·w + x по возрастанию
    rooms: RoomInstance[];               // тип, размер, угол, поворот, дверь, аппарат на каждом месте
    decor: Placed[];                     // скамьи в коридоре
    next: number;                        // номер следующего помещения (r1, r2…)
    // сетка не хранится: план выводится из помещений (planOf)
    staff: StaffMember[]; candidates: StaffMember[];   // часть 8
  };
  people: Agent[];                       // кто где идёт: маршрут и время выхода
  patients: Record<string, Patient>;     // активные и недавние
  queue: string[];                       // порядок очереди
  orders: Order[];                       // назначенные обследования и лечение
  economy: { cash: number; reputation: number; ledger: Ledger };  // касса дня; 0.0.20–0.0.21 — только cash
  // 0.0.22 (src/engine/economy/economy.ts): Ledger — доходы и число приёмов по плательщикам,
  // расходы по статьям (зарплаты, аппараты, помещения, расходники, проценты), экспертиза
  // (не оплачено, диагнозов обоснованных ниже A, без подтверждения, обследований без
  // показаний); у пациента — payer, calledT (первый вызов — ожидание для репутации),
  // indicated (какие обследования были показаны при назначении), paid (оплата приёма);
  // в итогах дня — касса дня, остаток, репутация (было, стало, оценка, причины) и уровень ОМС
  undo?: { hospital; cash }[];           // «Отменить» на экране стройки, последние 20; «Готово» — пусто
  // 0.0.21: штат и кандидаты (src/engine/hospital/staff.ts) — должность, пол и зерно имени,
  // навык 1–5, черта, зарплата за смену, помещение (нет — резерв), отработанные смены;
  // у ожидающего результата — помещение и время процедуры; у пациента без доврачебного
  // кабинета — triaged: false
  campaign?: {                           // 0.0.24, src/engine/campaign/campaign.ts
    chapter: Id; since: number;          // глава и последний день прежней
    done: Record<string, number>;        // выполненные задания главы → день
    letters: { id: string; day: number; read?: boolean }[];
    complete?: number;                   // день, когда выполнены все основные
    tips?: { shown: Id[]; off?: boolean }; // 0.0.25: подсказки наставника — показанные в карьере,
                                         // «Без подсказок»; отметка вида, движок её не читает
  };                                     // meta.career — слот карьеры (1–3)
  journal: Command[];                    // команды за текущий день (отчёт об ошибке, тесты)
}

interface Patient {
  id: string; name: string; sex: 'm' | 'f'; age: number; seed: number;
  profession: Id; payer: 'oms' | 'dms' | 'self'; traits: Id[];
  satisfaction: number;
  truth: {                               // ПРАВДА — только движок и разбор
    conditions: { id: Id; role: 'primary' | 'comorbid' | 'complication';
                  onsetT: number; stage: string; params: Record<string, string>;
                  treatedBy?: Id[] }[];
    risks: Id[]; allergies: Id[];
    findings: { f: Id; present: boolean; cause: Id | 'leak'; attrs?: Record<string, string>;
                value?: number; sinceT: number }[];
    vitals: Vitals;
  };
  known: {                               // ЧТО ЗНАЕТ ИГРОК — источник «вида»
    results: { f: Id; shown: boolean; value?: number; attrs?: Record<string, string>;
               by: Id; atT: number; orderId?: string }[];
    said: { f: Id; text: string; atT: number }[];     // ответы пациента текстом
    hypotheses: Id[];
    diagnosis?: { primary: Id; secondary: Id[]; atT: number };
    plan?: { treatments: Id[]; setting: string; atT: number };
  };
  visit: { arrivedT: number; triage: 'red' | 'yellow' | 'green'; returnOf?: string;
           location: string; status: string };
}
```

Правила:

- Реализованные признаки лежат в `truth.findings` явно: после обновления базы у уже
  пришедшего пациента ничего не «перебрасывается».
- `known.results[].shown` — что показало обследование, `truth.findings[].present` — как на
  самом деле. Разница между ними — ложный результат.
- Закрытый случай переезжает в архив профиля (§3) и из партии удаляется через сутки.

### Сейчас: смена (0.0.7)

Первая смена хранит подмножество этого состояния — `ShiftState` в
`src/engine/shift/types.ts` (`schemaVersion` 1):

- `meta` — версии схемы, базы и генератора, `mode` (`shift` — практика, `sandbox`,
  `campaign`, с 0.0.28 `single` — «Смена» со своим слотом `single` и `venue`: запись
  готовой больницы `preset.*` или `sandbox` — копия своей), зерно, сезон, отделение,
  сложность (`difficulty`: `student` или `doctor`, с 0.0.16; нет поля — «Врач», как играли
  до того: схема не менялась);
  **состояния ветвей генератора нет**: вся случайность — из именованных ветвей зерна
  смены (`day:2`, `vitals:1-04`, `exam:1-04:3:exam.cbc`, `outcome:1-04`…), поэтому снимок
  не хранит ничего, кроме того, что уже случилось;
- `t` — игровые секунды от полуночи первого дня; `day`; `dayOpen` — день закрыт, ждём
  «следующий день»;
- `patients` — по идентификатору `<день>-<номер>`: пациент с правдой (как у генератора),
  вид приёма (результаты по обследованиям с номером действия, ожидаемые результаты,
  сделанное, черновик решения), сортировка, статус (`coming`, `waiting`, `inRoom`,
  `away`, `done`, `left`, `unseen`), терпение, повторное обращение (`returnOf`,
  `returnReason`) и закрытый случай (`closed`: диагноз, вердикт, уверенность, план,
  исход, оценки, замечания, цена разумного пути). Разбор не хранится — экран
  пересчитывает его той же ветвью зерна;
- `queue`, `current`, `events` (по `t`, затем по номеру постановки), `seq`, `rooms`
  (когда освободятся рентген и ЭКГ), `returns` (кто и когда вернётся), `summary` и
  `history` (итоги дней), `journal` (команды текущего дня; ходы времени подряд — одной
  командой).
- С 0.0.32 — нанятые врачи (spec 2026-09-hired-doctors): у пациента `by` — номер
  человека из штата, который его ведёт (и у закрытого `closed.by`), и `phase` — где врач в
  приёме (ищет диагноз или спрашивает перед лечением); `desk` — до какого времени врач
  дописывает карту; в итогах дня `colleagues` — приёмы каждого врача, а прежние строки —
  только ваши. События `colleague` (следующий шаг врача) и `free` (врач свободен). Прежнее
  сохранение читается как есть: врачей в нём нет.
- С 0.0.33 — забрать приём у врача (часть 19): команда `takeOver` снимает с пациента `by` и
  `phase` и ставит `from` — у кого забран (у закрытого — `closed.from`); следующий шаг врача
  снимается. Вопрос или осмотр врач записывает сразу, со временем конца (`results[].at` может
  быть впереди часов): начатый он доделывает, а ожидание результатов у себя, записанное вперёд,
  в счёт приёма не идёт. У врача в итогах дня —
  `taken`, сколько его пациентов вы забрали. Приём с `from` — ваш: в прежних строках итогов,
  в профиле и оценке «Смены».

- С 0.0.55 — травма стопы, бедра и ключицы (часть 32б): у операции болезни — `surgery.byParam`
  (своя операция при таких значениях параметра; «В операционную» берёт её по тому, что видно на
  снимке), у места — `setting.also` (места, которые при этих значениях тоже не ошибка); в оценке
  места у `PlanEval.setting` — `also`. Схема сохранения прежняя: операция лежащего уже записана в
  его плане (`plan.treatments`), обход берёт её оттуда.
- С 0.0.54 — травма запястья и голеностопа (часть 32а): таблица базы `rules` — правила решения
  `Rule { id, name, complaints, any, exams, ageMin?, about, texts: { summary, hint, yes, no },
  sources, review }` (оттавские правила: при жалобе обследование нужно, если есть хоть один
  признак из `any`); у тактики — `byParam` (см. выше); срок операции болезни `surgery.window`
  необязателен — при закрытом переломе рекомендации его не называют, и строки срока в разборе
  нет; система органов `bones`. Картинка результата — ещё и `bone` (вид, сторона, переломы — место
  и смещение, как у `BoneFindings` рисовальщика). У вида приёма — `rules`: что правила говорят по
  проверенному (только «Студенту»). Смотровая приёмного принимает и `dept.trauma`. Схема
  сохранения прежняя: всё новое — необязательные поля и данные базы.
- С 0.0.50 — хирургия живота, третий шаг (часть 30в): у действия лечения и у осложнённой стадии
  — условие `when` по скрытым параметрам болезни; у операции болезни — `observe` (срок после
  наблюдения в палате) и `stay` (стационар после операции). У заметки разбора `op.onTime` и
  `op.late` — `observed`, если срок был после наблюдения. Схема сохранения прежняя: всё новое —
  необязательные поля.
- С 0.0.49 — хирургия живота, второй шаг (часть 30б): у осложнённой стадии болезни — `after`
  (стадия по сроку, прободная язва — давняя перфорация позже 24 ч), у операции — `surgery.delay`
  (каждый полный час от поступления до разреза выживаемость ниже на эту долю). Картинка
  результата — ещё и `abdomen` (`freeGas`, `levels`): обзорный снимок живота стоя. Схема
  сохранения прежняя: всё новое — необязательные поля.
- С 0.0.48 — хирургия живота (часть 30а): у помещения `admits` — какие отделения больница
  принимает, пока оно работает (смотровая приёмного — `dept.surgery`); у пациента смены
  `departments` — с какими отделениями его приняли (нет — одно отделение смены): из их болезней
  вывод, выбор диагноза, разбор и показанность обследований, и так же — в архиве профиля. У
  болезни `surgery.from: 'onset'` — срок операции от начала болезни; в разборе у `op.onTime` и
  `op.late` тогда `onset: true`. Картинка результата `us` — ещё и вид `gallbladder` (`stones`,
  `wall`). Генератору — `departments` и `carried` (скорая). Схема сохранения прежняя: всё новое
  — необязательные поля.
- С 0.0.47 — кабинет УЗИ (часть 29): помещение `room.ultrasound`, аппараты `eq.us_basic` и
  `eq.us_expert` (рисунок `us`), должность `role.sonographer` с `reads`; у должности `reads` —
  кто описывает снимки помещения, от его навыка точность (прежде — всегда рентгенолог). У
  карты смены — место пациента `spots.ultrasound`, фигурка `sonographer`, помещение
  обследования `ultrasound`. Картинка результата `ResultImage` — ещё и `us` (вид `appendix`,
  виден ли отросток). Схема сохранения прежняя.
- С 0.0.46 — перфорация и смерть (часть 28б): у операции `stay.op.complicated` — на момент
  разреза болезнь была в осложнённой стадии; у лежащего `stay.dies` — сутки, в ночь которых он
  умрёт (решено в конце операции). Исход `died`; в «мягком режиме» — `transferred` с
  `severe: true`; у случая стационара `end: 'died'`. В итогах дня `ward.died` и
  `surgery.complicated`; в разборе — `op.complicated` (болезнь, часы от начала, была ли уже
  при поступлении). У смены `meta.soft` — команда `soft { on }`: её подаёт сессия по настройке
  `softMode` перед любым действием. Схема сохранения прежняя.
- С 0.0.45 — операционная (часть 28а): у лежащего `stay.op` — операция: `tx`, когда решили
  оперировать (`queued`), операционная и хирург, начало и конец по часам смены, `done`,
  `complication`; пока `start` нет — ждёт в очереди операционной (по `queued`). Выбор места
  `surgery` — «В операционную» (пациент ложится на койку, как `admit`), команда `operate { id }`
  — с обхода; событие `opEnd`; в итогах дня `surgery` — операций, в срок, позже, осложнений; в
  разборе — `op.onTime` и `op.late` (часы от поступления и окно) и `op.complication`. В
  `economy.yaml` — `staff.surgery` (поправка доли осложнений по навыку хирурга, %) и
  `tariffs.omsOperation` (прибавка к случаю стационара с операцией). Схема сохранения прежняя.
- С 0.0.44 — скорая (часть 27): вид приёма `ambulance`; у привезённого `bay` — место в
  смотровой приёмного (нет — ждёт у входа), `sorted` — отсортировал ли врач (цвет — прежний
  `triage`), `scale` — цвет и баллы по шкале NEWS2 с флагами, как отсортировала бы медсестра,
  — для сверки; `scale.flag` — тревожный признак, что поднял цвет выше баллов. Привезённый —
  всегда `payer: oms`. Команда `sort { id, triage }`, событие для интерфейса `ambulance` (звук и
  автопауза), в итогах дня `ambulance` — привезли, отсортировали, недооценили, переоценили; в
  разборе приёма — строки `triage.under` и `triage.over` (с `flag`, если цвет поднял признак).
  Шкала — запись базы:
  `Score { id, name, params: { f, points: [от, до, баллы][] }[], oxygen, confusion,
  levels: { medium, single, high }, texts, sources, review }`; правила скорой — `economy.yaml`,
  `ambulance: { perDay, weight по тяжести, severe }`.
- С 0.0.43 — свой стационар (spec 2026-09-chapter-2, часть 26): статус пациента `admitted`
  и `stay` — койка (помещение и номер), день поступления, нынешний план и с каких суток он
  идёт, сколько раз его меняли (номер ветви зерна `ward:<пациент>:<смена>`), как пойдёт
  болезнь (`readyAfter`, `worseAfter`, `reaction`); у закрытого — `closed.stay`: сутки,
  обычный срок, как закончился (`discharged`, `early`, `transferred`). Команды `discharge`,
  `transfer`, `replan` — днём. В итогах дня `ward` — поступили, выписаны, из них рано,
  переведены, лежат, сумма суток и обычных сроков; в кассе `ward` — случаи и доход, из них
  прерванные и без показаний, и расход `expenses.ward` — койко-дни. Поля необязательные:
  `schemaVersion` прежний, сохранения 0.0.42 открываются как были — лежащих в них нет.

Храним неделю принятых (их исходы — в итогах следующих дней), тех, к кому вернутся, и лежащих;
ушедших и не принятых в прошлые дни — нет. После недели практики снимок — около 270 КБ.

## 3. Профиль и настройки

```ts
interface Profile {
  schemaVersion: number;
  doctor: { first: string; middle?: string; last: string; sex: 'm' | 'f'; portraitSeed: number };
  xp: Record<Id, number>;                // опыт по специальностям
  perks: Id[];
  stats: { cases: number; correct: number; defensible: number; costSum: number;
           timeToDxSum: number; deaths: number; redFlagsCaught: number; redFlagsMissed: number;
           antibioticsJustified: number; antibioticsTotal: number };
  achievements: Record<Id, { atReal: string }>;       // дата — реальная, только для показа
  seen: Id[];                            // «встречалось в практике»
  daily: { lastDate?: string; streak: number; best: number };
  archive: CaseRecord[];                 // последние 200 полностью, старше — итоги
}
```

`CaseRecord` — всё, что нужно разбору: правда, открытые результаты с временем,
команды случая, оценки, исход. Разбор строится из записи и базы той версии, что была
при случае (номер версии базы — в записи; если запись ссылается на заменённый
идентификатор, берётся `replacedBy`).

Сейчас (0.0.15, `src/state/profile.ts`) профиль меньше: `doctor: { first, last, sex }`
(отчества и портрета пока нет), `stats: { cases, correct, partly, wrong, grades, money }`,
`seen: Record<Id, number>` — сколько раз болезнь встречалась (настоящая, включая
сопутствующие, а не поставленная), и `archive` — последние 50 приёмов, новые первыми:
`{ key, seed, department, day, patient }`, где `patient` — пациент смены целиком (правда,
результаты, назначения, итог). Разбор строится из записи по нынешней базе. Опыт, навыки и
«Случай дня» придут со своими этапами. Файл читается поле за полем, как настройки; запись
архива без итога отбрасывается.

С 0.0.30 (spec 2026-09-profile, часть 16): `doctor.portrait` — номер одного из шести
портретов формы врача в наборе своего пола (нет — первый); в `stats` — `minutes` и `timed` (минуты врача и у
скольких приёмов они записаны: у прежних нет), `antibiotics: { given, indicated }` —
приёмы с антибиотиком и где все назначенные показаны настоящей болезни, `danger: { met,
caught }` — приёмы, где лечить надо не дома, и где место выбрано не ниже нужного. Звание
считается из `stats.cases` и не хранится. Прежний профиль читается с нулями.

Достижения (0.0.26) — `achievements: { got, days, run, gradeA, thrift, allergy, noLeftDays,
closedDays }`: полученные — `got[id] = { at, by }`, дата по часам телефона (ISO) и ключ
того, что принесло, — приёма (`seed:номер`) или дня (`режим:зерно:день`); по нему строка
«Достижение: …» стоит на итоге именно этого приёма или дня. Счётчики — рабочие дни, верных
подряд сейчас, приёмы на A, бережливые, с вопросом об аллергии перед лекарством, дни, когда
приняли всех; `closedDays` — ключи последних 60 закрытых дней, чтобы день не засчитался
дважды. Число приёмов и встреченные болезни — из `stats` и `seen`.

«Смена» (0.0.28) — `best: Record<больница, { overall, points, seen, arrived, seed, at }>`:
лучший результат в больнице — по общей оценке, затем по баллу, затем кого приняли больше.

«Случай дня» (0.0.27) — `daily: Record<'ГГГГ-ММ-ДД', { verdict, grade, base, at }>`: первая
попытка дня — вердикт, итоговая оценка, версия базы, когда сыгран; хранятся последние 60
дней, в списке — 30. Счёт сыгранных — `achievements.daily`. В архив приёмов и в итоги
практики случай дня не идёт: у него свой список, разбор — сразу после приёма.

Настройки: громкости четырёх каналов, вибрация, скорость по умолчанию, автопауза по
событиям, уровень подсказок по умолчанию, размер текста, «мягкий режим», язык,
увиденные подсказки обучения.

Сейчас (0.0.17, `src/state/settings.ts`) настроек шесть: громкость звуков (четыре
ступени), вибрация, автопауза на срочного и на результаты, отметка «оговорка первого
запуска прочитана», размер текста (`textScale`: 1, 1,15 или 1,3). Пять последних сбоев
для отчёта об ошибке — отдельный слот `errors`. Файл читается поле за полем: испорченное или незнакомое поле берётся
по умолчанию и не ломает остальные.

## 4. Файлы на телефоне

| Путь (в каталоге документов приложения) | Что лежит |
|------------------------------------------|-----------|
| `saves/<слот>/current.json` | текущее сохранение слота |
| `saves/<слот>/prev-1.json`, `prev-2.json` | две предыдущие копии |
| `profile.json` | профиль (§3) |
| `settings.json` | настройки |
| `crashlog.json` | последние сбои для отчёта об ошибке |

Слоты: `campaign-1`…`campaign-3`, `sandbox`, `shift` (незаконченная быстрая смена).
В веб-сборке те же ключи лежат в IndexedDB.

Сейчас (0.0.11) слотов два — `shift` и `settings`, файлы плоские: `saves/shift.json`,
`saves/shift.prev-1.json`, `saves/shift.prev-2.json` (запись — через `shift.json.tmp`) и
так же `saves/settings.json` с копиями — настройки пишутся тем же способом, что и
смена; в веб-сборке — `localStorage` с ключами `anamnez:saves/<файл>`.

**Перенос на другой телефон.** В отличие от «Вотчины», где автобэкап выключен ради
ключа устройства, здесь прятать нечего, а сервера, который хранил бы прогресс, нет.
Поэтому автобэкап Android **включён**: у Expo `android.allowBackup` по умолчанию `true`, а
правил бэкапа нет — система кладёт в копию все файлы приложения, в том числе каталог
документов с `saves/` (лимит системы — 25 МБ, у нас на порядок меньше). При смене телефона
с тем же аккаунтом Google прогресс вернётся сам.

Для телефонов без сервисов Google — файл (с 0.0.29, `src/state/transfer.ts`): «Настройки →
Перенос на другой телефон → Сохранить в файл / Открыть файл». Профиль, настройки и все
слоты партий — одним JSON `{ app: "anamnez", format: 1, version, savedAt, slots: { слот:
конверт } }`, имя — `anamnez-ГГГГ-ММ-ДД.json`. Пишет и читает его системное окно выбора из
`expo-file-system` (`Directory.pickDirectoryAsync` и `File.pickFileAsync`) — новых модулей и
сети не нужно; в веб-сборке — скачивание и выбор файла. Открытый файл заменяет те слоты,
что в нём есть, остальные остаются как были; прежние уходят в копию, как при обычной
записи. Чужой, испорченный, пустой файл и файл из более новой версии (формат новее или
партия ссылается на то, чего в базе нет) не открываются — с причиной. Миграции
(`06-architecture.md` §8) поднимают сохранение любой прошлой версии.

Ориентир размера сохранения — 200–500 КБ (карта 56 × 40 в RLE, до 60 активных
пациентов, журнал дня); профиль с архивом — до 2 МБ.
