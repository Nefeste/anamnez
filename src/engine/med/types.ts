// Пациент и наблюдения (`docs/04-medical-model.md`, `docs/07-data-model.md` §2).
//
// `truth` — правда: её видит только движок и разбор закрытого случая (ADR 0009,
// `docs/06-architecture.md` §7). Интерфейс получает наблюдения — то, что показали
// обследования, включая ошибки.
import type { Id, Season } from '../../content/types';

export type Sex = 'm' | 'f';

export interface ActiveCondition {
  id: Id;
  role: 'primary' | 'comorbid';
  /** день болезни на момент обращения */
  day: number;
  stage: string;
  /** скрытые параметры случая: сторона, тяжесть… */
  params: Record<string, string>;
}

export interface TrueFinding {
  f: Id;
  /** что вызвало признак: состояние, фактор риска или фон популяции */
  cause: Id | 'leak';
  attrs?: Record<string, string>;
}

export interface PatientTruth {
  /** основное — первым */
  conditions: ActiveCondition[];
  risks: Id[];
  /** только имеющиеся признаки */
  findings: TrueFinding[];
  /** истинные значения всех числовых показателей — и в норме, и нет */
  values: Record<Id, number>;
}

export interface Patient {
  seed: number;
  sex: Sex;
  age: number;
  season: Season;
  department: Id;
  truth: PatientTruth;
  /** жалобы, которые пациент назовёт сам, главная — первой */
  complaints: Id[];
}

/** Что показало обследование про один признак. */
export interface Observation {
  f: Id;
  /** показало «есть» (может быть ошибкой) */
  shown: boolean;
  value?: number;
  attrs?: Record<string, string>;
  /** каким обследованием; 'complaint' — пациент сказал сам */
  exam: Id | 'complaint';
}
