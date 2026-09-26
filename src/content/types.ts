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
  kind: 'disease' | 'injury' | 'syndrome' | 'state';
  severity: 'minor' | 'moderate' | 'serious' | 'critical';
  /** выпадает ли основным заболеванием (false — только сопутствующим) */
  presenting: boolean;
  /** относительный вес распространённости (из полосы) */
  weight: number;
  age: { min: number; max: number; peak?: [number, number] };
  sex?: { m: number; f: number };
  season?: Record<Season, number>;
  /** множители веса от факторов риска и сопутствующих состояний */
  risks?: { id: Id; x: number }[];
  /** без этих состояний не бывает (обострение ХОБЛ — только при ХОБЛ) */
  requires?: Id[];
  /** как часто бывает сопутствующим (хроническим) */
  chronic?: { p: P; ageMin?: number; risks?: { id: Id; x: number }[] };
  params?: Record<string, Record<string, number>>;
  stages: Stage[];
  /** в какие дни болезни обычно обращаются: [от, до] */
  presentation?: [number, number];
  findings: Link[];
  confirm: Id[] | 'clinical';
  redFlags?: Id[];
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
  attrs?: Record<string, Record<string, Text>>;
  value?: NumericSpec;
  texts: {
    complaint?: Text[];
    present: Text[];
    absent?: Text[];
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
  room?: Id;
  /** минуты: сама процедура, описание, ожидание результата */
  time: { procedure: number; report?: number; turnaround?: number };
  cost: number;
  discomfort: 0 | 1 | 2 | 3;
  radiation?: 'none' | 'low' | 'medium' | 'high';
  checks: ExamCheck[];
  texts: { summary: Text };
  sources: Source[];
  review: Review;
}

export interface Risk {
  id: Id;
  name: Text;
  /** распространённость по полу */
  p: { m: P; f: P };
  ageMin?: number;
  findings: Link[];
  review: Review;
}

export type Season = 'winter' | 'spring' | 'summer' | 'autumn';

export interface ContentDb {
  contentVersion: number;
  hash: string;
  conditions: Record<Id, Condition>;
  findings: Record<Id, Finding>;
  exams: Record<Id, Exam>;
  risks: Record<Id, Risk>;
  /** производное: какие обследования проверяют признак */
  revealedBy: Record<Id, Id[]>;
}
