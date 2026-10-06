// Сроки (spec 2026-10-chapter-3, часть 37): что сделать и за сколько минут от прихода — ЭКГ при
// боли в груди за 10 минут. Отсчёт — от прихода в больницу; сделано — пришёл результат. С частью 39б
// — и от находки (тромболизис за 10 минут от ЭКГ с подъёмом ST), и решения: назначение и перевод
// сделаны в минуту, когда врач закрыл приём. С частью 48а (spec 2026-10-chapter-4) — и от правила:
// антибиотик при сепсисе — от того, как qSOFA дал 2 балла.
import type { ContentDb, Id, Setting, Target } from '../../content/types';
import { complaintObservations } from '../med/exams';
import { checkRule, knownOf } from '../med/rules';
import type { Grade } from '../med/score';
import type { Observation } from '../med/types';
import type { ShiftPatient } from './types';

/** Срок закрытого приёма: через сколько минут от начала отсчёта сделано; нет — не сделали. */
export interface TargetResult {
  id: Id;
  minutes?: number;
  limit: number;
  grade: Grade;
}

/** Где лежит пациент: вид помещения по его номеру, что ему можно сделать у постели и что — в этой больнице. */
export interface TargetPlace {
  roomType(room: string): Id | undefined;
  bedside(exam: Id): boolean;
  /** у постели или в работающем кабинете этой больницы (часть 43г) */
  can(exam: Id): boolean;
}

/** Решение врача (часть 39б): когда закрыл приём и что назначил, куда направил. */
export interface TargetDecision {
  t: number;
  plan: { treatments: readonly Id[]; setting: Setting };
}

type Seen = Pick<ShiftPatient, 'patient' | 'bay' | 'results'>;
/** Что нужно, чтобы найти начало отсчёта: приход, результаты и (у отсчёта от правила, часть 48а) жалобы и возраст. */
type Timed = Pick<ShiftPatient, 'arriveT' | 'results'> & Partial<Pick<ShiftPatient, 'patient'>>;

/** Когда пришёл первый результат, показавший одну из находок срока; не показал — undefined. */
function foundAt(p: Pick<ShiftPatient, 'results'>, t: Target): number | undefined {
  const at = p.results.filter(r => r.obs.some(o => o.shown && t.findings.includes(o.f))).reduce((m, r) => Math.min(m, r.at), Infinity);
  return at === Infinity ? undefined : at;
}

/**
 * Когда правило срока впервые сказало «да» (spec 2026-10-chapter-4, часть 48а): по жалобам и результатам, пришедшим к
 * тому времени, — qSOFA 2 и больше у больного с признаками инфекции. Правило к жалобам не применимо или «да» так и не
 * сказало — undefined.
 */
function ruleAt(db: ContentDb, p: Pick<ShiftPatient, 'results'> & Partial<Pick<ShiftPatient, 'patient'>>, t: Target): number | undefined {
  const rule = t.rule === undefined ? undefined : db.rules[t.rule];
  const patient = p.patient;
  if (!rule || !patient || !rule.complaints.some(f => patient.complaints.includes(f)) || patient.age < (rule.ageMin ?? 0)) return undefined;
  const obs: Observation[] = complaintObservations(patient);
  for (const r of [...p.results].sort((a, b) => a.at - b.at)) {
    obs.push(...r.obs);
    if (checkRule(rule, patient, knownOf(obs)).verdict === 'yes') return r.at;
  }
  return undefined;
}

/**
 * Кому срок: по жалобе при поступлении или по находке, которую уже показали обследования (часть 39б); у срока от
 * правила (часть 48а) — кому правило сказало «да», а с находками — и у кого есть одна из них (антибиотик в первый
 * час — при давлении ниже 90).
 */
function whose(db: ContentDb, p: Pick<ShiftPatient, 'patient' | 'results'>, t: Target): boolean {
  if (t.from === 'rule') return ruleAt(db, p, t) !== undefined && (t.findings.length === 0 || foundAt(p, t) !== undefined);
  return t.complaints.some(f => p.patient.complaints.includes(f)) || foundAt(p, t) !== undefined;
}

/** Срок снят (часть 44б): обследование показало находку из «кроме» — периферический парез лица, это не инсульт. */
const excepted = (p: Pick<ShiftPatient, 'results'>, t: Target) =>
  t.except !== undefined && p.results.some(r => r.obs.some(o => o.shown && t.except!.includes(o.f)));

/**
 * Какие сроки к пациенту относятся: жалоба при поступлении — из записи — или находка, которую уже
 * показали обследования (часть 39б), кроме снятых находкой из «кроме» (часть 44б); и, если срок для
 * лежащих в помещении (смотровая приёмного), он лежит там, а у срока на обследование одно из них ему
 * можно сделать у постели — монитор стоит и
 * смотровая работает: без него в срок не успеть не по вине игрока (смотровая из сохранений до 0.3.2
 * — без монитора, пока его не купят). У срока без помещения одно из его обследований можно сделать в
 * этой больнице (часть 43г): КТ при подозрении на инсульт — там, где есть КТ; в районной больнице его
 * нет, и срок не выполнить тоже не по вине игрока.
 */
export function targetsFor(db: ContentDb, p: Seen, at: TargetPlace): Target[] {
  return Object.values(db.targets).filter(t => whose(db, p, t)
    && !excepted(p, t)
    && (t.room
      ? p.bay !== undefined && at.roomType(p.bay.room) === t.room && (t.exams.length === 0 || t.exams.some(e => at.bedside(e)))
      : t.exams.length === 0 || t.exams.some(e => at.can(e))));
}

/**
 * Сколько минут до конца ближайшего идущего срока (часть 43г): отсчёт начался, а сделано ещё нет; срок
 * вышел — меньше нуля. Идущих сроков нет — undefined.
 */
export function dueIn(db: ContentDb, p: Seen & Pick<ShiftPatient, 'arriveT'>, at: TargetPlace, now: number): number | undefined {
  let left: number | undefined;
  for (const t of targetsFor(db, p, at)) {
    const start = targetStart(db, p, t);
    if (start === undefined || minutesTo(db, p, t) !== undefined) continue;
    const m = t.minutes - (now - start) / 60;
    if (left === undefined || m < left) left = m;
  }
  return left;
}

/** В срок — A; до полутора сроков — B, до двух — C; позже или не сделано — D. */
export function targetGrade(minutes: number | undefined, limit: number): Grade {
  if (minutes === undefined) return 'D';
  if (minutes <= limit) return 'A';
  if (minutes <= limit * 1.5) return 'B';
  if (minutes <= limit * 2) return 'C';
  return 'D';
}

/** С какого момента отсчёт: приход, результат с находкой (часть 39б) или результат, после которого правило сказало «да» (часть 48а). */
export function targetStart(db: ContentDb, p: Timed, t: Target): number | undefined {
  return t.from === 'finding' ? foundAt(p, t) : t.from === 'rule' ? ruleAt(db, p, t) : p.arriveT;
}

/** Сделано ли решением (часть 39б): назначение в плане или место — то самое. */
const decided = (t: Target, d: TargetDecision) => t.treatments.some(tx => d.plan.treatments.includes(tx)) || t.settings.includes(d.plan.setting);

/**
 * Через сколько минут от начала отсчёта сделано: первый пришедший результат обследования срока или,
 * у срока на назначение и место, решение (часть 39б). Нет — undefined.
 */
export function minutesTo(db: ContentDb, p: Timed, t: Target, decision?: TargetDecision): number | undefined {
  const start = targetStart(db, p, t);
  if (start === undefined) return undefined;
  const exam = p.results.filter(r => t.exams.includes(r.exam)).reduce((m, r) => Math.min(m, r.at), Infinity);
  const at = Math.min(exam, decision && decided(t, decision) ? decision.t : Infinity);
  return at === Infinity ? undefined : Math.round((at - start) / 60);
}

/** Остаётся у нас (часть 41а): в палате, ПИТ, реанимации (часть 47) или операционной; переведённому срок — там, куда везут. */
const STAYS: readonly Setting[] = ['admit', 'icu', 'ricu', 'surgery'];

/**
 * Сроки закрытого приёма. Срок на назначение или место — только тем, кому его сделали (часть 39б):
 * тромболизис, которого не назначили, — строка «Не сделано до перевода» (часть 39а), а не второй
 * штраф сроком; перевод — тем, кого перевели. Срок «только остающимся» (часть 41а: тест глотания) —
 * тем, кого оставили у себя.
 */
export function targetResults(db: ContentDb, p: Seen & Pick<ShiftPatient, 'arriveT'>, at: TargetPlace, decision?: TargetDecision): TargetResult[] {
  return targetsFor(db, p, at)
    .filter(t => !t.stays || (decision !== undefined && STAYS.includes(decision.plan.setting)))
    .filter(t => t.exams.length > 0 || (decision !== undefined && decided(t, decision)))
    .map(t => {
      const minutes = minutesTo(db, p, t, decision);
      return { id: t.id, ...(minutes !== undefined ? { minutes } : {}), limit: t.minutes, grade: targetGrade(minutes, t.minutes) };
    });
}
