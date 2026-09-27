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
    untreated?: { p: P; days: [number, number] };  // без действенного лечения: ухудшение и на какой день
    // позже (приёмное и скорая, этап 4) — осложнения новыми состояниями:
    // complications?: { after: [number, number]; when?: Cond; add: Id; p: P }[];
  };
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
  setting: {                             // где лечить; берётся самое высокое из подходящих
    default: Setting;
    param?: { name: string; map: Record<string, Setting> };  // по скрытому параметру: тяжесть
    redFlag?: Setting;                   // если у пациента есть красный флаг состояния
    risks?: { id: Id; setting: Setting }[];  // по фактору риска: пиелонефрит у беременной
  };
  score?: Id;                            // позже: шкала, по которой решают (CRB-65)
}
// Системы органов в порядке показа; у всего, с чем приходят, — обязательна (валидатор).
type BodySystem = 'airways' | 'lungs' | 'heart' | 'digestive' | 'urinary' | 'metabolic' | 'nerves';
// Амбулатория первой смены: дома, направить в стационар, вызвать скорую.
// ОРИТ и операция — с палатами и операционной (этап 4).
type Setting = 'home' | 'ward' | 'ambulance';

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
  kind: 'drug' | 'regimen' | 'procedure'; // позже: 'surgery'
  class?: string;                        // 'antibiotic.penicillin'
  route?: 'oral' | 'inhaled' | 'nasal' | 'iv' | 'im';
  cost: number;
  // cure — на причину: к выздоровлению с вероятностью p за days дней; relieve — облегчает
  effects: { on: Id; kind: 'cure' | 'relieve'; p: P; days: [number, number] }[];
  // противопоказание — фактор риска (аллергия) или состояние; reaction — вероятность
  // вреда, если назначить, когда оно у пациента есть (знал врач или нет)
  contraindications: { id: Id; level: 'relative' | 'absolute'; reaction: P }[];
  texts: { hint: Text };                 // «Что это?» простыми словами (05-content.md §4)
  sources: Source[]; review: Review; replacedBy?: Id;
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
}
interface Equipment {
  id: Id; name: Text; gen: Text; room: Id; sprite: 'machine' | 'xray'; upgradeOf?: Id;
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
  rooms: Id[];                           // производное: где работает
  texts: { hint: Text };
}
```

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
  economy: { cash: number; reputation: number; ledger: LedgerEntry[] };  // ledger — за текущий день; 0.0.20 — только cash
  undo?: { hospital; cash }[];           // «Отменить» на экране стройки, последние 20; «Готово» — пусто
  career?: { chapter: Id; missions: Record<Id, MissionState> };
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

- `meta` — версии схемы, базы и генератора, `mode: 'shift'`, зерно, сезон, отделение,
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

Храним неделю принятых (их исходы — в итогах следующих дней) и тех, к кому вернутся;
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
результаты, назначения, итог). Разбор строится из записи по нынешней базе. Опыт, навыки,
достижения и «Случай дня» придут со своими этапами. Файл читается поле за полем, как
настройки; запись архива без итога отбрасывается.

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
Поэтому автобэкап Android **включён** для `saves/` и `profile.json` (правила бэкапа в
`app.json`; лимит системы — 25 МБ, у нас на порядок меньше) — при смене телефона с
тем же аккаунтом Google прогресс вернётся сам. Для телефонов без сервисов Google —
«Настройки → Перенос → Сохранить в файл / Открыть файл»: профиль и слоты одним
архивом через «Поделиться». Миграции (`06-architecture.md` §8) поднимают сохранение
любой прошлой версии.

Ориентир размера сохранения — 200–500 КБ (карта 56 × 40 в RLE, до 60 активных
пациентов, журнал дня); профиль с архивом — до 2 МБ.
