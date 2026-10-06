// npm run doctor — «виртуальный врач» по базе (`docs/05-content.md` §6, `docs/09-testing.md` §3).
// Три стратегии на одних и тех же пациентах: разумный, ленивый, «всё подряд»; и нанятый врач
// своей больницы по навыку 1–5 (spec 2026-09-hired-doctors) — тот же разумный с порогами навыка.
// Флаги: --n 10000 (пациентов), --season winter|spring|summer|autumn|all, --json (для CI),
// --variety — больные с «Разнообразием» (spec 2026-10-variety): основное заболевание по сглаженным
// частотам, вывод врача — по частотам жизни; пороги — для сведения.
// --departments therapy,surgery,trauma — больница с приёмным (spec 2026-09-chapter-2, часть 30):
// пациенты и кандидаты из этих отделений, пороги разумного врача — и у каждого отделения (часть
// 35); нет — амбулатория, одна терапия. С неврологией (spec 2026-10-chapter-3, часть 46а) — больница
// главы 3: пороги и у кардиологии и неврологии (болезни таблицы «Медицина главы») — по их больным,
// отобранным из того же потока (`--profile-n`, по умолчанию 600 в каждой группе), и прицельный прогон
// «ОКС и инсульт в смотровой приёмного» (`--focus-n`, по умолчанию 300 больных каждой болезнью):
// диагноз, сроки, тромболизис без противопоказаний, ленивый — без ЭКГ и с опозданиями. Порог не
// выполнен — выход с кодом 1.
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { observe, type OutcomeKind } from '../../src/engine/med/course';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient, patientAt, presentingWeight } from '../../src/engine/med/generate';
import { contextOf, posterior } from '../../src/engine/med/infer';
import { evaluatePlan, type Plan, primaryOf, selfLimits, type Venue } from '../../src/engine/med/plan';
import { choosePlan, type DoctorPhase, type DoctorResult, examCost, examMinutes, MIN_GAIN, nextStep, runDoctor, type Strategy } from '../../src/engine/med/policy';
import { type Grade, scoreCase } from '../../src/engine/med/score';
import type { Observation, Patient } from '../../src/engine/med/types';
import { targetResults, type TargetPlace } from '../../src/engine/shift/targets';
import type { ResultBatch } from '../../src/engine/shift/types';
import { buildDb } from '../content/load';

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const N = Number(arg('n', '3000'));
const seasonArg = arg('season', 'all');
const asJson = process.argv.includes('--json');
const variety = process.argv.includes('--variety');
const threshold = Number(arg('threshold', '0.9'));
/** нанятый врач по навыку — на первых стольких пациентах: навык 5 берётся из прогона разумного */
const HN = Math.min(N, Number(arg('hired-n', '1000')));
/** прицельный прогон главы 3: больных каждой болезнью */
const FOCUS_N = Number(arg('focus-n', '300'));
/** кардиология и неврология главы 3: больных каждой группы */
const PROFILE_N = Number(arg('profile-n', '600'));

const { db, errors } = buildDb();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
const department = 'dept.therapy';
const departments = arg('departments', 'therapy').split(',').map(d => `dept.${d.trim()}`);
const unknownDept = departments.filter(d => !Object.values(db.conditions).some(c => c.department === d));
if (unknownDept.length) {
  console.error(`нет болезней отделения ${unknownDept.join(', ')}`);
  process.exit(1);
}
const candidates = Object.keys(db.conditions).filter(id => db.conditions[id].presenting && departments.includes(db.conditions[id].department));
const exams = Object.keys(db.exams).sort();
const SEASONS = ['winter', 'spring', 'summer', 'autumn'] as const;
const seasons = seasonArg === 'all' ? SEASONS : SEASONS.filter(x => x === seasonArg);
if (seasons.length === 0) {
  console.error(`неизвестный сезон ${seasonArg}: ${SEASONS.join(', ')} или all`);
  process.exit(1);
}

interface Tally {
  n: number; correct: number; correctGroup: number; money: number; minutes: number; exams: number;
  confusion: Record<string, number>; perCondition: Record<string, { n: number; correct: number; correctGroup: number }>;
  /** оценки случая и исходы (`04-medical-model.md` §9–10) */
  overall: Record<Grade, number>; treatment: Record<Grade, number>; outcomes: Record<OutcomeKind, number>;
  /** антибиотик там, где он не показан (ОРВИ, бронхит, грипп) */
  needlessAntibiotic: number;
}
const grades = (): Record<Grade, number> => ({ A: 0, B: 0, C: 0, D: 0 });
const empty = (): Tally => ({
  n: 0, correct: 0, correctGroup: 0, money: 0, minutes: 0, exams: 0, confusion: {}, perCondition: {},
  overall: grades(), treatment: grades(), outcomes: { recovered: 0, improved: 0, unchanged: 0, worse: 0, reaction: 0, transferred: 0, admitted: 0, died: 0 }, needlessAntibiotic: 0,
});
const costOf = (r: DoctorResult) => r.exams.reduce((a, id) => a + examCost(db, id), 0);
const strategies: Strategy[] = ['rational', 'lazy', 'shotgun'];
const tally: Record<Strategy, Tally> = { rational: empty(), lazy: empty(), shotgun: empty() };
/** разумный на первых HN пациентах — это нанятый врач навыка 5 */
interface Case { truth: string; correct: boolean; correctGroup: boolean; money: number; minutes: number; exams: number; needless: boolean; reaction: boolean }
const rationalCases: Case[] = [];
const timing: Record<Strategy, number> = { rational: 0, lazy: 0, shotgun: 0 };
/**
 * Кардиология и неврология главы 3 (spec 2026-10-chapter-3, критерий приёмки 3) — болезни таблицы «Медицина
 * главы»: в базе это терапия и неврология, а пороги — свои у каждой.
 */
const PROFILES: Record<'cardiology' | 'neurology', Id[]> = {
  cardiology: ['cond.acs', 'cond.angina_stable', 'cond.af', 'cond.svt', 'cond.vt', 'cond.av_block', 'cond.adhf', 'cond.hypertensive_crisis', 'cond.bp_uncontrolled', 'cond.pericarditis', 'cond.aortic_dissection', 'cond.pe'],
  neurology: ['cond.stroke_ischemic', 'cond.tia', 'cond.ich', 'cond.sah', 'cond.seizure', 'cond.status_epilepticus', 'cond.bell_palsy', 'cond.hypoglycemia'],
};
/** больница главы 3 — с неврологией */
const chapter3 = departments.includes('dept.neurology');

/** Пациент на минуту решения (часть 41а): копия с окнами по часам на это время и прежние значения. */
function decidedAt(patient: Patient, minutes: number): { copy: Patient; before: Record<string, string> } {
  const at = patientAt(db, patient, minutes);
  return { copy: at.patient, before: at.before };
}

const t0 = performance.now();
for (let i = 0; i < N; i++) {
  const season = seasons[i % seasons.length];
  const patient = generatePatient(db, 9_000_000 + i, { department, departments, season, ...(variety ? { variety: true } : {}) });
  const truth = patient.truth.conditions[0].id;
  const cond = db.conditions[truth];
  const present = new Set(patient.truth.findings.map(f => f.f));
  let rationalCost = 0;
  for (const s of strategies) {
    const t = performance.now();
    const r = runDoctor(db, patient, s, Rng.seeded(patient.seed).fork(`doctor:${s}`), { candidates, exams, threshold });
    timing[s] += performance.now() - t;
    if (s === 'rational') rationalCost = costOf(r);
    const x = tally[s];
    // окна по часам — на минуту решения этого врача (часть 41а): у каждого своё время
    const { copy, before } = decidedAt(patient, r.minutes);
    const ev = evaluatePlan(db, copy, r.plan, r.observations, { minutes: r.minutes }, before);
    const outcome = observe(db, copy, r.plan, ev, Rng.seeded(patient.seed).fork(`outcome:${s}`));
    const score = scoreCase({
      verdict: r.correct ? 'correct' : r.correctGroup ? 'partly' : 'wrong',
      confidence: r.confidence, cost: costOf(r), rationalCost, plan: ev, outcome, selfLimiting: selfLimits(db, primaryOf(patient)), ...(cond.settles ? { settles: true } : {}),
      redFlags: (cond.redFlags ?? []).filter(f => present.has(f)).map(f => ({ f, seen: r.observations.some(o => o.f === f && o.shown) })),
    });
    x.overall[score.overall]++;
    x.treatment[score.treatment]++;
    x.outcomes[outcome.kind]++;
    const needless = selfLimits(db, primaryOf(patient)) && ev.roles.some(v => v.role === 'notIndicated' && db.treatments[v.tx].class?.startsWith('antibiotic.'));
    if (needless) x.needlessAntibiotic++;
    if (s === 'rational' && i < HN) {
      rationalCases.push({ truth, correct: r.correct, correctGroup: r.correctGroup, money: r.money, minutes: r.minutes, exams: r.exams.length, needless, reaction: outcome.kind === 'reaction' });
    }
    x.n++;
    x.money += r.money;
    x.minutes += r.minutes;
    x.exams += r.exams.length;
    const pc = (x.perCondition[truth] ??= { n: 0, correct: 0, correctGroup: 0 });
    pc.n++;
    if (r.correctGroup) { x.correctGroup++; pc.correctGroup++; }
    if (r.correct) { x.correct++; pc.correct++; } else {
      const key = `${truth} → ${r.diagnosis}`;
      x.confusion[key] = (x.confusion[key] ?? 0) + 1;
    }
  }
}
const total = performance.now() - t0;

// Нанятый врач (spec 2026-09-hired-doctors): те же пациенты и те же результаты обследований, что у
// разумного (ветвь `doctor:rational`), пороги — навыка из economy.yaml. Навык 5 — это и есть
// разумный врач, его приёмы берутся из прогона выше; навыки 1–4 — на тех же первых HN пациентах.
const SKILLS = [1, 2, 3, 4, 5] as const;
interface Hired { skill: number; cases: Case[] }
const t1 = performance.now();
const hired: Hired[] = SKILLS.map(skill => {
  const d = db.economy.staff.doctor;
  const [thr, gain, forget] = [d.threshold[skill - 1] / 100, d.minGain[skill - 1] / 1000, d.forget[skill - 1]];
  if (thr === threshold && gain === 0.02 && forget === 0) return { skill, cases: rationalCases };
  const cases: Case[] = [];
  for (let i = 0; i < HN; i++) {
    const season = seasons[i % seasons.length];
    const patient = generatePatient(db, 9_000_000 + i, { department, departments, season, ...(variety ? { variety: true } : {}) });
    const truth = patient.truth.conditions[0].id;
    const forgot = Rng.seeded(patient.seed).fork('forget');
    const r = runDoctor(db, patient, 'rational', Rng.seeded(patient.seed).fork('doctor:rational'), {
      candidates, exams, threshold: thr, minGain: gain, skipAsk: q => forget > 0 && forgot.fork(q).chance(forget * 100),
    });
    const { copy, before } = decidedAt(patient, r.minutes);
    const ev = evaluatePlan(db, copy, r.plan, r.observations, { minutes: r.minutes }, before);
    const outcome = observe(db, copy, r.plan, ev, Rng.seeded(patient.seed).fork('outcome:rational'));
    const needless = selfLimits(db, primaryOf(patient)) && ev.roles.some(v => v.role === 'notIndicated' && db.treatments[v.tx].class?.startsWith('antibiotic.'));
    cases.push({ truth, correct: r.correct, correctGroup: r.correctGroup, money: r.money, minutes: r.minutes, exams: r.exams.length, needless, reaction: outcome.kind === 'reaction' });
  }
  return { skill, cases };
});
const hiredMs = performance.now() - t1;

const pct = (a: number, b: number) => (b ? (100 * a) / b : 0);
/** средняя по болезням точность до группы: частая болезнь не вытягивает редкие */
const balancedOf = (conds: { n: number; correctGroup: number }[]) => conds.reduce((a, v) => a + pct(v.correctGroup, v.n), 0) / Math.max(1, conds.length);
const report = strategies.map(s => {
  const x = tally[s];
  const conds = Object.values(x.perCondition);
  // по отделениям (spec 2026-09-chapter-2, часть 35): пациенты, больные болезнью отделения
  const byDepartment = Object.fromEntries(departments.map(d => {
    const own = Object.entries(x.perCondition).filter(([id]) => db.conditions[id].department === d).map(([, v]) => v);
    const n = own.reduce((a, v) => a + v.n, 0);
    return [d, { patients: n, groupAccuracy: pct(own.reduce((a, v) => a + v.correctGroup, 0), n), balanced: balancedOf(own) }];
  }));
  return {
    strategy: s,
    accuracy: pct(x.correct, x.n),
    /** с точностью до группы с одинаковой тактикой */
    groupAccuracy: pct(x.correctGroup, x.n),
    balanced: balancedOf(conds),
    byDepartment,
    money: x.money / x.n,
    minutes: x.minutes / x.n,
    exams: x.exams / x.n,
    msPerPatient: timing[s] / x.n,
    perCondition: Object.fromEntries(Object.entries(x.perCondition).sort().map(([k, v]) => [k, { n: v.n, accuracy: pct(v.correct, v.n), groupAccuracy: pct(v.correctGroup, v.n) }])),
    overall: Object.fromEntries(Object.entries(x.overall).map(([g, v]) => [g, pct(v, x.n)])) as Record<Grade, number>,
    treatment: Object.fromEntries(Object.entries(x.treatment).map(([g, v]) => [g, pct(v, x.n)])) as Record<Grade, number>,
    outcomes: Object.fromEntries(Object.entries(x.outcomes).map(([k, v]) => [k, pct(v, x.n)])) as Record<OutcomeKind, number>,
    needlessAntibiotic: pct(x.needlessAntibiotic, x.n),
    topConfusions: Object.entries(x.confusion).sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
});
const [rational, lazy, shotgun] = report;
const hiredReport = hired.map(({ skill, cases }) => {
  const n = cases.length;
  const per: Record<string, { n: number; g: number }> = {};
  for (const c of cases) {
    const x = (per[c.truth] ??= { n: 0, g: 0 });
    x.n++;
    if (c.correctGroup) x.g++;
  }
  const count = (f: (c: Case) => boolean) => cases.filter(f).length;
  const sum = (f: (c: Case) => number) => cases.reduce((a, c) => a + f(c), 0) / Math.max(1, n);
  return {
    skill, patients: n, accuracy: pct(count(c => c.correct), n), groupAccuracy: pct(count(c => c.correctGroup), n),
    balanced: Object.values(per).reduce((a, v) => a + pct(v.g, v.n), 0) / Math.max(1, Object.keys(per).length),
    money: sum(c => c.money), minutes: sum(c => c.minutes), exams: sum(c => c.exams), needlessAntibiotic: pct(count(c => c.needless), n), reactions: pct(count(c => c.reaction), n),
  };
});
const byGroup = hiredReport.map(h => h.groupAccuracy);
// Пороги 05-content.md §6: точность — до группы с одинаковой тактикой; ленивый сравнивается
// с разумным по сбалансированной точности — иначе самая частая болезнь (ОРВИ больше
// половины обращений) вытягивает его сама.
interface Threshold { value: number; need: string; ok: boolean; /** для сведения — почему: в код выхода не идёт */ info?: string }
// нанятые врачи — пороги амбулатории, где их проверяли (spec 2026-09-hired-doctors); в больнице с
// приёмным хирургию и травму различает и навык 1, разница навыков уже — это для сведения (часть 35)
const practice = departments.length === 1 && departments[0] === department;
const notPractice = practice ? undefined : 'порог амбулатории';
const thresholds: Record<string, Threshold> = {
  rationalAccuracy: { value: rational.groupAccuracy, need: '≥ 90', ok: rational.groupAccuracy >= 90 },
  rationalBalanced: { value: rational.balanced, need: '≥ 85', ok: rational.balanced >= 85 },
  lazyGap: { value: rational.balanced - lazy.balanced, need: '≥ 25 п. п. ниже разумного', ok: rational.balanced - lazy.balanced >= 25 },
  shotgunCostRatio: { value: shotgun.money / Math.max(1, rational.money), need: '≥ 3', ok: shotgun.money >= 3 * rational.money },
  // лечение (spec 2026-09-first-shift): разумный врач почти не вредит и не даёт антибиотик без показаний
  rationalReactions: { value: rational.outcomes.reaction, need: '≤ 1 %', ok: rational.outcomes.reaction <= 1 },
  rationalNeedlessAntibiotic: { value: rational.needlessAntibiotic, need: '≤ 3 %', ok: rational.needlessAntibiotic <= 3 },
  // нанятые врачи (spec 2026-09-hired-doctors, критерий 1): точность растёт с навыком; навык 5 —
  // почти разумный, навык 1 — лучше ленивого, но заметно хуже навыка 3
  hiredSkill5: { value: byGroup[4], need: '≥ 88', ok: byGroup[4] >= 88, info: notPractice },
  hiredGrows: { value: byGroup[4] - byGroup[0], need: 'растёт с каждым навыком', ok: byGroup.every((v, i) => i === 0 || v >= byGroup[i - 1]), info: notPractice },
  hiredSkill1: { value: byGroup[0], need: `выше ленивого (${lazy.groupAccuracy.toFixed(1)}) и ниже навыка 3 (${byGroup[2].toFixed(1)})`, ok: byGroup[0] > lazy.groupAccuracy && byGroup[0] < byGroup[2], info: notPractice },
  // сбалансированная — редкие болезни: у навыка 1 разница с разумным видна сильнее
  hiredBalancedGap: { value: hiredReport[4].balanced - hiredReport[0].balanced, need: '≥ 8 п. п. между навыком 1 и 5', ok: hiredReport[4].balanced - hiredReport[0].balanced >= 8, info: notPractice },
};
// больница с приёмным (spec 2026-09-chapter-2, критерий приёмки 3): пороги разумного — и у каждого
// отделения, по его больным: терапия не прячется за лёгкую для врача травму. Больных отделения
// меньше `DEPT_MIN` — у редких болезней по два-три человека, сбалансированная скачет от одного
// промаха: для сведения
const DEPT_MIN = 150;
if (departments.length > 1) {
  for (const d of departments) {
    const x = rational.byDepartment[d];
    const k = d.replace('dept.', '');
    const few = x.patients < DEPT_MIN ? `больных отделения меньше ${DEPT_MIN}` : undefined;
    thresholds[`rationalAccuracy:${k}`] = { value: x.groupAccuracy, need: '≥ 90', ok: x.groupAccuracy >= 90, info: few };
    thresholds[`rationalBalanced:${k}`] = { value: x.balanced, need: '≥ 85', ok: x.balanced >= 85, info: few };
  }
}
// Кардиология и неврология главы 3 (критерий приёмки 3, часть 46а): в потоке больницы их больных 4 и 2 % — на
// 3000 пациентов сотня и полсотни, и пороги были бы для сведения. Поэтому из того же потока (зёрна с 8 000 000)
// отбираются больные каждой группы, пока их не наберётся `PROFILE_N`: болезни — с частотами этой больницы.
// Пороги — как у отделений: до группы ≥ 90 %, сбалансированная ≥ 85 %.
type Profile = keyof typeof PROFILES;
interface ProfileTally {
  patients: number; accuracy: number; groupAccuracy: number; balanced: number;
  perCondition: Record<string, { n: number; groupAccuracy: number }>; topConfusions: [string, number][];
}
function profileTally(people: readonly Patient[], s: Strategy): ProfileTally {
  const per: Record<string, { n: number; correct: number; correctGroup: number }> = {};
  const confusion: Record<string, number> = {};
  for (const p of people) {
    const truth = p.truth.conditions[0].id;
    const r = runDoctor(db, p, s, Rng.seeded(p.seed).fork(`doctor:${s}`), { candidates, exams, threshold });
    const pc = (per[truth] ??= { n: 0, correct: 0, correctGroup: 0 });
    pc.n++;
    if (r.correctGroup) pc.correctGroup++;
    if (r.correct) pc.correct++;
    else confusion[`${truth} → ${r.diagnosis}`] = (confusion[`${truth} → ${r.diagnosis}`] ?? 0) + 1;
  }
  const all = Object.values(per);
  return {
    patients: people.length,
    accuracy: pct(all.reduce((a, v) => a + v.correct, 0), people.length),
    groupAccuracy: pct(all.reduce((a, v) => a + v.correctGroup, 0), people.length),
    balanced: balancedOf(all),
    perCondition: Object.fromEntries(Object.entries(per).sort().map(([k, v]) => [k, { n: v.n, groupAccuracy: pct(v.correctGroup, v.n) }])),
    topConfusions: Object.entries(confusion).sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
}
const t3 = performance.now();
const profilePeople: Record<Profile, Patient[]> = { cardiology: [], neurology: [] };
// больных группы в потоке нет (больница без терапии) — не дольше чем 100 зёрен на каждого нужного
for (let i = 0; chapter3 && i < 100 * PROFILE_N && Object.values(profilePeople).some(x => x.length < PROFILE_N); i++) {
  const p = generatePatient(db, 8_000_000 + i, { department, departments, season: seasons[i % seasons.length], ...(variety ? { variety: true } : {}) });
  for (const k of Object.keys(PROFILES) as Profile[]) {
    if (profilePeople[k].length < PROFILE_N && PROFILES[k].includes(p.truth.conditions[0].id)) profilePeople[k].push(p);
  }
}
const profiles = chapter3
  ? (Object.keys(PROFILES) as Profile[]).map(k => ({ profile: k, rational: profileTally(profilePeople[k], 'rational'), lazy: profileTally(profilePeople[k], 'lazy') }))
  : [];
const profileMs = performance.now() - t3;
for (const f of profiles) {
  const few = f.rational.patients < PROFILE_N ? `больных группы в потоке меньше ${PROFILE_N}` : undefined;
  thresholds[`profileAccuracy:${f.profile}`] = { value: f.rational.groupAccuracy, need: '≥ 90', ok: f.rational.groupAccuracy >= 90, info: few };
  thresholds[`profileBalanced:${f.profile}`] = { value: f.rational.balanced, need: '≥ 85', ok: f.rational.balanced >= 85, info: few };
}

// Глава 3 (spec 2026-10-chapter-3, критерий приёмки 3, часть 46а): ОКС и инсульт в смотровой приёмного — у
// постели монитор с дефибриллятором, есть КТ, ПИТ, палата и операционная. Больные — те, у кого болезнь обычна
// (возраст, пол, факторы риска), формы — по частотам; врач видит их сразу по приходе. Минуты — как в смене: у
// постели — процедура, снимок — 2 минуты назначить, процедура и описание, анализ — с ожиданием результата;
// разумный ждёт каждый результат (в смене он ждёт только нужный — там сроки не хуже). Сроки — тем же кодом,
// что в смене (`targetResults`). Тромболизис с противопоказанием — о котором знал или не спросил; спросил, а
// расспрос не открыл (точность вопроса меньше 100 %), — для сведения.
const ED_BEDSIDE: readonly Id[] = ['eq.monitor_defib'];
const ED_VENUE: Venue = { bedside: ED_BEDSIDE, icu: true, ward: true, or: true };
const LYSIS: readonly Id[] = ['tx.thrombolysis', 'tx.thrombolysis_stroke', 'tx.thrombolysis_pe'];
const FOCUS: readonly Id[] = ['cond.acs', 'cond.stroke_ischemic'];
const atBedside = (id: Id) => db.exams[id]?.bedside?.equipment.every(e => ED_BEDSIDE.includes(e)) === true;
/** минут до результата, как в смене */
function edMinutes(id: Id): number {
  const e = db.exams[id];
  if (atBedside(id)) return e.bedside!.time.procedure;
  return e.kind === 'imaging' || e.kind === 'functional' ? 2 + examMinutes(e) : examMinutes(e);
}
const edPlace: TargetPlace = { roomType: () => 'room.emergency', bedside: atBedside, can: () => true };
interface EdCase { correct: boolean; onTime: number; targets: number; ecg: boolean; lysis: boolean; contra: boolean; missed: boolean; minutes: number; byTarget: Record<string, [number, number]> }

function edCase(patient: Patient, lazy: boolean): EdCase {
  const obs: Observation[] = complaintObservations(patient);
  const done: Id[] = [];
  const results: ResultBatch[] = [];
  const rng = Rng.seeded(patient.seed).fork('doctor:rational');
  let t = 0;
  let decision: { diagnosis: Id; plan: Plan };
  if (lazy) {
    const top = posterior(db, candidates, obs, contextOf(db, patient, obs))[0];
    decision = { diagnosis: top.id, plan: choosePlan(db, top.id, obs, patient, { ...ED_VENUE, minutes: 0 }) };
  } else {
    let phase: DoctorPhase = {};
    for (;;) {
      const r = nextStep(db, patient, obs, done, phase, { candidates, exams, threshold, minGain: MIN_GAIN, venue: { ...ED_VENUE, minutes: t } });
      phase = r.phase;
      if (r.step.kind === 'decide') {
        decision = r.step;
        break;
      }
      const id = r.step.exam;
      const o = runExam(db, patient, id, rng.fork(`exam:${done.length}:${id}`));
      obs.push(...o);
      done.push(id);
      t += edMinutes(id);
      results.push({ exam: id, obs: o, at: t * 60, step: done.length });
    }
  }
  const seen = { patient, bay: { room: 'ed', bed: 0 }, results, arriveT: 0 };
  const targets = targetResults(db, seen, edPlace, { t: t * 60, plan: decision.plan });
  const { copy, before } = decidedAt(patient, t);
  const ev = evaluatePlan(db, copy, decision.plan, obs, { ...ED_VENUE, minutes: t }, before);
  const lysisBad = ev.violations.filter(v => LYSIS.includes(v.tx));
  const byTarget: Record<string, [number, number]> = {};
  for (const x of targets) {
    const b = (byTarget[x.id] ??= [0, 0]);
    b[1]++;
    if (x.grade === 'A') b[0]++;
  }
  return {
    correct: decision.diagnosis === primaryOf(patient).id,
    onTime: targets.filter(x => x.grade === 'A').length,
    targets: targets.length,
    ecg: done.includes('exam.ecg'),
    lysis: decision.plan.treatments.some(tx => LYSIS.includes(tx)),
    contra: lysisBad.some(v => v.known || !v.asked),
    missed: lysisBad.some(v => v.asked && !v.known),
    minutes: t,
    byTarget,
  };
}

/** Больные с болезнью `cond`, у которых она обычна, — по порядку зёрен. */
function typical(cond: Id, n: number): Patient[] {
  const out: Patient[] = [];
  for (let seed = 7_100_000; out.length < n; seed++) {
    const p = generatePatient(db, seed, { department, departments, season: seasons[out.length % seasons.length], primary: cond, carried: db.economy.ambulance.weight });
    const chronic = p.truth.conditions.filter(x => x.role === 'comorbid').map(x => x.id);
    if (presentingWeight(db.conditions[cond], { sex: p.sex, age: p.age, season: p.season, risks: p.truth.risks, chronic }) > 0) out.push(p);
  }
  return out;
}

function tallyEd(cases: EdCase[]) {
  const n = cases.length;
  const count = (f: (c: EdCase) => boolean) => cases.filter(f).length;
  const byTarget: Record<string, [number, number]> = {};
  for (const c of cases) {
    for (const [k, [a, b]] of Object.entries(c.byTarget)) {
      const x = (byTarget[k] ??= [0, 0]);
      x[0] += a;
      x[1] += b;
    }
  }
  const onTime = cases.reduce((a, c) => a + c.onTime, 0);
  const targets = cases.reduce((a, c) => a + c.targets, 0);
  return {
    patients: n, accuracy: pct(count(c => c.correct), n), onTime, targets, onTimeShare: pct(onTime, targets), ecg: pct(count(c => c.ecg), n),
    lysis: count(c => c.lysis), lysisContra: count(c => c.contra), lysisMissed: count(c => c.missed), minutes: cases.reduce((a, c) => a + c.minutes, 0) / Math.max(1, n), byTarget,
  };
}

const t2 = performance.now();
const focus = chapter3 ? FOCUS.map(cond => {
  const people = typical(cond, FOCUS_N);
  return { condition: cond, rational: tallyEd(people.map(p => edCase(p, false))), lazy: tallyEd(people.map(p => edCase(p, true))) };
}) : [];
const focusMs = performance.now() - t2;
if (chapter3) {
  const sum = (who: 'rational' | 'lazy', k: 'onTime' | 'targets' | 'lysisContra') => focus.reduce((a, f) => a + f[who][k], 0);
  for (const f of focus) {
    thresholds[`focus:${f.condition.replace('cond.', '')}`] = { value: f.rational.accuracy, need: '≥ 90', ok: f.rational.accuracy >= 90 };
  }
  const rationalOnTime = pct(sum('rational', 'onTime'), sum('rational', 'targets'));
  const lazyOnTime = pct(sum('lazy', 'onTime'), sum('lazy', 'targets'));
  thresholds.focusTargets = { value: rationalOnTime, need: '≥ 90', ok: rationalOnTime >= 90 };
  thresholds.focusLysisContra = { value: sum('rational', 'lysisContra'), need: '0 — о противопоказании знал или не спросил', ok: sum('rational', 'lysisContra') === 0 };
  const lazyEcg = Math.max(...focus.map(f => f.lazy.ecg));
  thresholds.focusLazy = {
    value: lazyOnTime, need: `без ЭКГ и в срок реже разумного (${rationalOnTime.toFixed(1)}) не меньше чем на 25 п. п.`, ok: lazyEcg === 0 && lazyOnTime <= rationalOnTime - 25,
  };
}

// с разнообразием (spec 2026-10-variety) пороги — для сведения: они про частоты жизни
if (variety) for (const t of Object.values(thresholds)) t.info ??= 'больные с разнообразием';
const passed = Object.values(thresholds).every(t => t.ok || t.info);

if (asJson) {
  console.log(JSON.stringify({ contentVersion: db.contentVersion, contentHash: db.hash, departments, patients: N, seasons, threshold, totalMs: total, report, hired: hiredReport, profiles, focus, thresholds, passed }, null, 2));
} else {
  console.log(`База ${db.contentVersion} (${db.hash}), отделения ${departments.join(', ')}, пациентов ${N}, сезоны: ${seasons.join(', ')}, порог разумного врача ${threshold}${variety ? ', больные — с разнообразием' : ''}`);
  console.log(`Время: ${(total / 1000).toFixed(2)} с на всех трёх врачей (${(total / N).toFixed(2)} мс на пациента)\n`);
  const names: Record<Strategy, string> = { rational: 'разумный', lazy: 'ленивый', shotgun: 'всё подряд' };
  for (const r of report) {
    console.log(`${names[r.strategy].padEnd(11)} точность ${r.accuracy.toFixed(1).padStart(5)} %  до группы ${r.groupAccuracy.toFixed(1).padStart(5)} %  сбалансированная ${r.balanced.toFixed(1).padStart(5)} %   ${r.money.toFixed(0).padStart(5)} ₽   ${r.minutes.toFixed(0).padStart(4)} мин   обследований ${r.exams.toFixed(1)}   ${r.msPerPatient.toFixed(2)} мс/пациент`);
  }
  if (departments.length > 1) {
    console.log('\nПо отделениям (больные болезнью отделения; до группы / сбалансированная):');
    for (const d of departments) {
      const cells = report.map(r => `${names[r.strategy]} ${r.byDepartment[d].groupAccuracy.toFixed(1).padStart(5)} / ${r.byDepartment[d].balanced.toFixed(1).padStart(5)} %`);
      console.log(`  ${d.padEnd(13)} ${pct(rational.byDepartment[d].patients, N).toFixed(1).padStart(4)} % пациентов   ${cells.join('   ')}`);
    }
  }
  const abcd = (g: Record<Grade, number>) => (['A', 'B', 'C', 'D'] as Grade[]).map(k => g[k].toFixed(0)).join('/');
  console.log('\nЛечение и исходы (оценки A/B/C/D, %):');
  for (const r of report) {
    const o = r.outcomes;
    console.log(`${names[r.strategy].padEnd(11)} случай ${abcd(r.overall).padEnd(12)} лечение ${abcd(r.treatment).padEnd(12)} выздоровел ${(o.recovered + o.improved).toFixed(1).padStart(5)} %  хуже ${o.worse.toFixed(1).padStart(4)} %  реакция ${o.reaction.toFixed(1).padStart(4)} %  переведён ${o.transferred.toFixed(1).padStart(4)} %  без изменений ${o.unchanged.toFixed(1).padStart(4)} %  антибиотик без показаний ${r.needlessAntibiotic.toFixed(1).padStart(4)} %`);
  }
  console.log('\nТочность разумного врача по болезням (доля среди пациентов; с чем путает чаще всего):');
  const mixedUp = (id: string) => Object.entries(tally.rational.confusion)
    .filter(([k]) => k.startsWith(`${id} → `)).sort((a, b) => b[1] - a[1]).slice(0, 2)
    .map(([k, v]) => `${k.slice(id.length + 3)} ${v}`).join(', ');
  for (const [id, v] of Object.entries(rational.perCondition)) {
    console.log(`  ${id.padEnd(28)} ${v.accuracy.toFixed(1).padStart(5)} %  до группы ${v.groupAccuracy.toFixed(1).padStart(5)} %  ${pct(v.n, N).toFixed(1).padStart(4)} % пациентов${mixedUp(id) ? `  → ${mixedUp(id)}` : ''}`);
  }
  console.log('\nЧастые путаницы разумного врача:');
  for (const [k, v] of rational.topConfusions) console.log(`  ${k}: ${v}`);
  console.log(`\nНанятый врач по навыку (economy.yaml, staff.doctor; первые ${HN} пациентов; ${(hiredMs / 1000).toFixed(1)} с):`);
  for (const h of hiredReport) {
    console.log(`  навык ${h.skill}  точность ${h.accuracy.toFixed(1).padStart(5)} %  до группы ${h.groupAccuracy.toFixed(1).padStart(5)} %  сбалансированная ${h.balanced.toFixed(1).padStart(5)} %   ${h.money.toFixed(0).padStart(5)} ₽   ${h.minutes.toFixed(0).padStart(4)} мин   обследований ${h.exams.toFixed(1)}   антибиотик без показаний ${h.needlessAntibiotic.toFixed(1)} %   реакция ${h.reactions.toFixed(1)} %`);
  }
  if (chapter3) {
    console.log(`\nКардиология и неврология главы 3 — больные группы из потока больницы (по ${PROFILE_N}; ${(profileMs / 1000).toFixed(1)} с; до группы / сбалансированная):`);
    for (const f of profiles) {
      const cells = (['rational', 'lazy'] as const).map(who => `${names[who]} ${f[who].groupAccuracy.toFixed(1).padStart(5)} / ${f[who].balanced.toFixed(1).padStart(5)} %`);
      console.log(`  ${f.profile.padEnd(11)} ${String(f.rational.patients).padStart(4)}   ${cells.join('   ')}`);
      console.log(`    ${Object.entries(f.rational.perCondition).map(([k, v]) => `${k.replace('cond.', '')} ${v.groupAccuracy.toFixed(0)} % из ${v.n}`).join(', ')}`);
      if (f.rational.topConfusions.length > 0) console.log(`    путает: ${f.rational.topConfusions.map(([k, v]) => `${k.replace(/cond\./g, '')}: ${v}`).join(', ')}`);
    }
    console.log(`\nОКС и инсульт в смотровой приёмного (по ${FOCUS_N} больных; ${(focusMs / 1000).toFixed(1)} с):`);
    for (const f of focus) {
      for (const who of ['rational', 'lazy'] as const) {
        const x = f[who];
        const lines = Object.entries(x.byTarget).map(([k, [a, b]]) => `${k.replace('target.', '')} ${a}/${b}`).join(', ');
        console.log(`  ${f.condition.padEnd(21)} ${names[who].padEnd(9)} верно ${x.accuracy.toFixed(1).padStart(5)} %   сроки ${x.onTimeShare.toFixed(1).padStart(5)} % (${lines})   ЭКГ ${x.ecg.toFixed(0)} %   тромболизис ${x.lysis}, с противопоказанием ${x.lysisContra}, расспрос не открыл ${x.lysisMissed}   ${x.minutes.toFixed(0)} мин`);
      }
    }
  }
  console.log('\nПороги (05-content.md §6):');
  for (const [k, t] of Object.entries(thresholds)) console.log(`  ${t.ok ? 'да ' : 'НЕТ'} ${k}: ${t.value.toFixed(2)} (нужно ${t.need})${t.info ? ` — для сведения: ${t.info}` : ''}`);
}
process.exit(passed ? 0 : 1);
