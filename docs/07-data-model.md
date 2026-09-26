# Данные

Три вида данных: **медицинская база** (одинакова у всех, едет в приложении), **состояние
партии** (сохранение), **профиль и настройки** (общие для всех партий). Правила
наполнения базы — [`05-content.md`](05-content.md); смысл полей — в
[`04-medical-model.md`](04-medical-model.md). Типы ниже — договор; при появлении кода
источником правды станут `src/content/types.ts` и `src/engine/core/state.ts`, а этот
документ будет ссылаться на них и объяснять «почему».

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
  kind: 'disease' | 'injury' | 'syndrome' | 'state';
  severity: 'minor' | 'moderate' | 'serious' | 'critical';
  epidemiology: {
    prevalence: P;                      // из полосы распространённости
    age: { min: number; max?: number; peak?: [number, number] };
    sex?: { m: number; f: number };     // относительные веса
    season?: { winter: number; spring: number; summer: number; autumn: number };
    risks?: { id: Id; x: number }[];    // множители: фактор риска или состояние
    chronic?: boolean;                  // бывает сопутствующим
  };
  params?: Record<string, Record<string, number>>;       // скрытые параметры: значение → вес
  course: {
    stages: { id: string; days: [number, number]; needs?: 'effective_treatment' }[];
    untreated?: { after: [number, number]; when?: Cond; add: Id; p: P }[];
    selfLimiting?: boolean;
  };
  findings: Link[];                     // связи «состояние → признак»
  vitals?: VitalShift[];                // сдвиги витальных по стадиям и тяжести
  confirm: Id[] | 'clinical';
  redFlags?: Id[];
  expect?: { exam?: Id; treatment?: Id; within: Minutes | 'day' }[];
  treatment: {
    firstLine: Id[]; acceptable: Id[]; supportive: Id[];
    notIndicated: Id[]; harmful: Id[];
    setting: Partial<Record<'mild' | 'moderate' | 'severe', 'home' | 'ward' | 'icu' | 'surgery' | 'transfer'>>;
    score?: Id;
  };
  texts: { summary: Text; lay?: Text };  // lay — как называют пациенты
  pearls?: Text[];                       // «что запомнить»: 2–3 вывода для разбора и энциклопедии
  simplified?: string;                   // что упрощено и почему
  sources: Source[]; review: Review;
  replacedBy?: Id;
}

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
  kind: 'sym' | 'sign' | 'vital' | 'lab' | 'img' | 'ecg';
  system?: string;                       // respiratory, cardiac, …
  leak: P;                               // фон популяции
  redFlag?: boolean;
  attrs?: Record<string, string[]>;      // допустимые атрибуты
  lab?: { test: Id; unit: string; ref: [number, number]; threshold: number; dir: 'high' | 'low' };
  texts: {
    complaint?: TemplateSet;             // от лица пациента
    present: TemplateSet;                // строка осмотра или протокола
    absent?: TemplateSet;                // отрицательный результат
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
  room?: Id; equipment?: Id[]; staff?: Id[];     // что нужно, чтобы сделать
  time: { procedure: Minutes; report?: Minutes; turnaround?: Minutes };
  cost: number; consumables?: number;
  discomfort: 0 | 1 | 2 | 3; radiation?: 'none' | 'low' | 'medium' | 'high';
  contraindications?: { id: Id; level: 'relative' | 'absolute' }[];
  checks: { f: Id; sens: P; spec: P }[];         // какие признаки проверяет и как точно
  modifiers?: { by: Id; sens?: number; spec?: number }[];  // ожирение, навык, уровень аппарата
  texts: { summary: Text };
  sources: Source[]; review: Review; replacedBy?: Id;
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
  kind: 'drug' | 'procedure' | 'surgery' | 'regimen';
  class?: string;                        // 'antibiotic.penicillin'
  route?: 'oral' | 'iv' | 'im' | 'inhaled' | 'topical';
  room?: Id; staff?: Id[]; time?: Minutes; cost: number;
  effects: { on: Id; kind: 'cure' | 'relieve'; p?: P; days?: [number, number]; findings?: Id[] }[];
  contraindications?: { id: Id; level: 'relative' | 'absolute' }[];
  sideEffects?: { add: Id; p: P; if?: Id }[];
  sources: Source[]; review: Review; replacedBy?: Id;
}

interface RoomType {
  id: Id; name: Text; department?: Id;
  sizes: { id: 'S' | 'M' | 'L'; w: number; h: number; layout: ObjectPlacement[] }[];
  requires: { equipment?: Id[]; staff?: Id[]; minArea: number };
  capacity?: number;                     // койки, места ожидания
  cost: number; upkeep: number;
}
interface Equipment {
  id: Id; name: Text; rooms: Id[]; tier?: number; upgradeOf?: Id;
  price: number; upkeep: number; reliability: P;       // шанс поломки за день работы
  speed: number; quality: number;                      // множители времени и точности
  footprint: [number, number];
}
interface StaffRole { id: Id; name: Text; salary: [number, number]; rooms: Id[]; performs: Id[] }
```

## 2. Состояние партии

Один сериализуемый объект. Показаны главные части; правда пациента хранится рядом с
тем, что о нём знает игрок, но наружу выходит только «вид» (`06-architecture.md` §7).

```ts
interface GameState {
  meta: {
    schemaVersion: number; contentVersion: number; rngVersion: number;
    mode: 'campaign' | 'shift' | 'daily' | 'sandbox';
    difficulty: 'student' | 'resident' | 'doctor' | 'professor';
    soft: boolean;                       // «мягкий режим»
    seed: number; chapter?: Id;
  };
  clock: { t: number; day: number; speed: 0 | 1 | 2 | 4 };   // t — игровые секунды
  rng: Record<string, [number, number, number, number]>;      // состояние ветвей
  events: ScheduledEvent[];              // очередь событий (куча)
  hospital: {
    w: number; h: number; cells: string;  // клетки сетки, RLE-строка
    rooms: RoomInstance[]; equipment: EquipmentInstance[];
    staff: StaffMember[]; candidates: StaffMember[];
  };
  people: Agent[];                       // кто где идёт: маршрут и время выхода
  patients: Record<string, Patient>;     // активные и недавние
  queue: string[];                       // порядок очереди
  orders: Order[];                       // назначенные обследования и лечение
  economy: { cash: number; reputation: number; ledger: LedgerEntry[] };  // ledger — за текущий день
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

Настройки: громкости четырёх каналов, вибрация, скорость по умолчанию, автопауза по
событиям, уровень подсказок по умолчанию, размер текста, «мягкий режим», язык,
увиденные подсказки обучения.

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
