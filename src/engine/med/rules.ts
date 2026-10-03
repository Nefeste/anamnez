// Правила решения (spec 2026-09-chapter-2, часть 32): оттавские правила — хоть один признак, и снимок
// нужен; с частью 32г — и правило КТ при лёгкой черепно-мозговой травме: основные признаки (хватит
// одного), дополнительные (нужно не меньше двух), возраст как основной или дополнительный признак и
// круг тех, к кому правило применимо (была потеря сознания, амнезия или оглушение). С частью 33а —
// шкала Уэллса и D-димер при боли в ноге: признаки, при которых правило не применяют (тяж по ходу
// подкожной вены — это тромбофлебит), и «правило ещё не решено — узнать, что осталось». Правило
// считает по тому, что известно; диагноз оно не ставит.
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
 * что проверить. Возраст известен всегда. Есть признак из `excludes` — правило не применяется (часть
 * 33а); пока его не видели, правило считается применимым: ждать проверки всего не нужно.
 */
export function checkRule(rule: Rule, age: number, known: Known): RuleCheck {
  const req = rule.requires ?? [];
  const excluded = (rule.excludes ?? []).some(f => known(f) === true);
  const applies = excluded ? false : req.length === 0 || req.some(f => known(f) === true) ? true : req.every(f => known(f) === false) ? false : undefined;
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
  // пункты правила, которое проверяют только применимым (часть 39а), ждут, пока оно применится
  const waits = rule.onlyIfApplies === true && applies !== true;
  const left =
    verdict !== 'unknown'
      ? []
      : [
          ...(applies === undefined ? req.filter(f => known(f) === undefined) : []),
          ...(hit || waits ? [] : [...mainOpen, ...(minorCanReach ? minorOpen : [])]),
        ];
  return { verdict, applies, main, ageMain, minor, ageMinor, left: [...new Set(left)] };
}

/** Все признаки, от которых зависит вывод правила. */
export function ruleFindings(rule: Rule): Id[] {
  return [...new Set([...(rule.requires ?? []), ...(rule.excludes ?? []), ...rule.any, ...(rule.minor?.any ?? [])])];
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

/**
 * Что узнать, чтобы правило решилось (часть 33а): правило к жалобе применимо, а вывода ещё нет —
 * обследования, которые проверят хоть один из оставшихся признаков (`left`). Шкала Уэллса меньше
 * двух, а D-димер неизвестен — D-димер (960_1, раздел 2.3, критерий качества 3: при низкой
 * вероятности ТГВ — D-димер); при травме головы не знают об антикоагулянтах — вопрос о лекарствах.
 * Сначала — то, что проверит больше оставшихся признаков: при боли в голеностопе — осмотр
 * голеностопа (болезненность лодыжек и четыре шага), а не стопы (только четыре шага). Обследование
 * правила уже сделано — решать, нужно ли оно, поздно: такое правило не доводят. Поровну — дешевле
 * (`cost`), потом по идентификатору. Разумный врач делает первое из них, страховая их оплачивает.
 */
export function openRuleExams(db: ContentDb, patient: { complaints: readonly Id[]; age: number }, observations: readonly Observation[], cost: (exam: Id) => number = () => 0): Id[] {
  const known = knownOf(observations);
  const done = new Set(observations.map(o => o.exam));
  const covers = new Map<Id, number>();
  for (const r of rulesFor(db, patient)) {
    if (r.exams.length > 0 && r.exams.every(e => done.has(e))) continue;
    const x = checkRule(r, patient.age, known);
    if (x.verdict !== 'unknown') continue;
    for (const f of x.left) for (const e of db.revealedBy[f] ?? []) covers.set(e, (covers.get(e) ?? 0) + 1);
  }
  return [...covers.keys()].sort((a, b) => covers.get(b)! - covers.get(a)! || cost(a) - cost(b) || (a < b ? -1 : 1));
}
