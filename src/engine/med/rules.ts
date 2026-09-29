// Правила решения (spec 2026-09-chapter-2, часть 32): оттавские правила — хоть один признак, и снимок
// нужен; с частью 32г — и правило КТ при лёгкой черепно-мозговой травме: основные признаки (хватит
// одного), дополнительные (нужно не меньше двух), возраст как основной или дополнительный признак и
// круг тех, к кому правило применимо (была потеря сознания, амнезия или оглушение). Правило считает
// по тому, что известно; диагноз оно не ставит.
import type { ContentDb, Id, Rule } from '../../content/types';
import type { Observation } from './types';

export type RuleVerdict = 'yes' | 'no' | 'unknown';

export interface RuleCheck {
  verdict: RuleVerdict;
  /** правило к пациенту применимо; `undefined` — пока не проверили */
  applies: boolean | undefined;
  /** основные признаки, которые есть */
  main: Id[];
  /** возраст — основной признак */
  ageMain: boolean;
  /** дополнительные признаки, которые есть */
  minor: Id[];
  /** возраст — дополнительный признак */
  ageMinor: boolean;
  /** что ещё не проверено из того, что может изменить вывод */
  left: Id[];
}

/** Что известно о признаке: есть, нет, не проверяли. */
export type Known = (f: Id) => boolean | undefined;

/** Известное по наблюдениям: показал хоть раз — есть; проверяли и не показал — нет. */
export function knownOf(observations: readonly Observation[]): Known {
  return f => {
    let seen = false;
    for (const o of observations) {
      if (o.f !== f) continue;
      if (o.shown) return true;
      seen = true;
    }
    return seen ? false : undefined;
  };
}

/**
 * Вывод правила: «да» — есть основной признак или не меньше `minor.count` дополнительных, и правило
 * применимо; «нет» — неприменимо или уже никак не набрать; иначе — «пока неизвестно», и `left` —
 * что проверить. Возраст известен всегда.
 */
export function checkRule(rule: Rule, age: number, known: Known): RuleCheck {
  const req = rule.requires ?? [];
  const applies = req.length === 0 || req.some(f => known(f) === true) ? true : req.every(f => known(f) === false) ? false : undefined;
  const ageMain = (rule.age?.main !== undefined && age > rule.age.main) || (rule.age?.from !== undefined && age >= rule.age.from);
  const ageMinor = rule.age?.minor !== undefined && age >= rule.age.minor[0] && age <= rule.age.minor[1];
  const main = rule.any.filter(f => known(f) === true);
  const minorAll = rule.minor?.any ?? [];
  const minor = minorAll.filter(f => known(f) === true);
  const need = rule.minor?.count ?? Infinity;
  const count = minor.length + (ageMinor ? 1 : 0);
  const hit = ageMain || main.length > 0 || count >= need;
  const mainOpen = rule.any.filter(f => known(f) === undefined);
  const minorOpen = minorAll.filter(f => known(f) === undefined);
  const minorCanReach = count + minorOpen.length >= need;
  const canHit = hit || mainOpen.length > 0 || minorCanReach;
  const verdict: RuleVerdict = applies === false || !canHit ? 'no' : hit && applies === true ? 'yes' : 'unknown';
  const left =
    verdict !== 'unknown'
      ? []
      : [
          ...(applies === undefined ? req.filter(f => known(f) === undefined) : []),
          ...(hit ? [] : [...mainOpen, ...(minorCanReach ? minorOpen : [])]),
        ];
  return { verdict, applies, main, ageMain, minor, ageMinor, left: [...new Set(left)] };
}

/** Все признаки, от которых зависит вывод правила. */
export function ruleFindings(rule: Rule): Id[] {
  return [...new Set([...(rule.requires ?? []), ...rule.any, ...(rule.minor?.any ?? [])])];
}

/** Правила к жалобам пациента: жалоба из правила и возраст не меньше `ageMin`; по порядку id. */
export function rulesFor(db: ContentDb, patient: { complaints: readonly Id[]; age: number }): Rule[] {
  return Object.keys(db.rules)
    .sort()
    .map(id => db.rules[id])
    .filter(r => r.complaints.some(f => patient.complaints.includes(f)) && patient.age >= (r.ageMin ?? 0));
}

/**
 * Обследования, которые велят сделать положительные правила (часть 32д): оттавские правила сказали
 * «снимок нужен» — его делает разумный врач, даже почти уверенный в ушибе, и оплачивает страховая
 * (832_2, раздел 2.4: правила решают, нужен ли снимок). Отрицательное правило снимок не запрещает:
 * «можно не делать» — и разумный врач делает его, только если снимок что-то добавит к диагнозу.
 */
export function ruleExams(db: ContentDb, patient: { complaints: readonly Id[]; age: number }, observations: readonly Observation[]): Id[] {
  const known = knownOf(observations);
  return [...new Set(rulesFor(db, patient).filter(r => checkRule(r, patient.age, known).verdict === 'yes').flatMap(r => r.exams))];
}
