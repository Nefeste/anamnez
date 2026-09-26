// npm run doctor — «виртуальный врач» по базе (`docs/05-content.md` §6, `docs/09-testing.md` §3).
// Три стратегии на одних и тех же пациентах: разумный, ленивый, «всё подряд».
// Флаги: --n 10000 (пациентов), --season winter|spring|summer|autumn|all, --json (для CI).
import { Rng } from '../../src/engine/core/rng';
import { observe, type OutcomeKind } from '../../src/engine/med/course';
import { generatePatient } from '../../src/engine/med/generate';
import { evaluatePlan } from '../../src/engine/med/plan';
import { type DoctorResult, examCost, runDoctor, type Strategy } from '../../src/engine/med/policy';
import { type Grade, scoreCase } from '../../src/engine/med/score';
import { buildDb } from '../content/load';

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const N = Number(arg('n', '3000'));
const seasonArg = arg('season', 'all');
const asJson = process.argv.includes('--json');
const threshold = Number(arg('threshold', '0.9'));

const { db, errors } = buildDb();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
const department = 'dept.therapy';
const candidates = Object.keys(db.conditions).filter(id => db.conditions[id].presenting && db.conditions[id].department === department);
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
  overall: grades(), treatment: grades(), outcomes: { recovered: 0, improved: 0, unchanged: 0, worse: 0, reaction: 0, transferred: 0 }, needlessAntibiotic: 0,
});
const costOf = (r: DoctorResult) => r.exams.reduce((a, id) => a + examCost(db, id), 0);
const strategies: Strategy[] = ['rational', 'lazy', 'shotgun'];
const tally: Record<Strategy, Tally> = { rational: empty(), lazy: empty(), shotgun: empty() };
const timing: Record<Strategy, number> = { rational: 0, lazy: 0, shotgun: 0 };

const t0 = performance.now();
for (let i = 0; i < N; i++) {
  const season = seasons[i % seasons.length];
  const patient = generatePatient(db, 9_000_000 + i, { department, season });
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
    const ev = evaluatePlan(db, patient, r.plan, r.observations);
    const outcome = observe(db, patient, r.plan, ev, Rng.seeded(patient.seed).fork(`outcome:${s}`));
    const score = scoreCase({
      verdict: r.correct ? 'correct' : r.correctGroup ? 'partly' : 'wrong',
      confidence: r.confidence, cost: costOf(r), rationalCost, plan: ev, outcome, selfLimiting: cond.selfLimiting === true,
      redFlags: (cond.redFlags ?? []).filter(f => present.has(f)).map(f => ({ f, seen: r.observations.some(o => o.f === f && o.shown) })),
    });
    x.overall[score.overall]++;
    x.treatment[score.treatment]++;
    x.outcomes[outcome.kind]++;
    if (cond.selfLimiting && ev.roles.some(v => v.role === 'notIndicated' && db.treatments[v.tx].class?.startsWith('antibiotic.'))) x.needlessAntibiotic++;
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

const pct = (a: number, b: number) => (b ? (100 * a) / b : 0);
const report = strategies.map(s => {
  const x = tally[s];
  const conds = Object.values(x.perCondition);
  return {
    strategy: s,
    accuracy: pct(x.correct, x.n),
    /** с точностью до группы с одинаковой тактикой */
    groupAccuracy: pct(x.correctGroup, x.n),
    /** средняя по болезням точность до группы: частая болезнь не вытягивает редкие */
    balanced: conds.reduce((a, v) => a + pct(v.correctGroup, v.n), 0) / Math.max(1, conds.length),
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
// Пороги 05-content.md §6: точность — до группы с одинаковой тактикой; ленивый сравнивается
// с разумным по сбалансированной точности — иначе самая частая болезнь (ОРВИ больше
// половины обращений) вытягивает его сама.
const thresholds = {
  rationalAccuracy: { value: rational.groupAccuracy, need: '≥ 90', ok: rational.groupAccuracy >= 90 },
  rationalBalanced: { value: rational.balanced, need: '≥ 85', ok: rational.balanced >= 85 },
  lazyGap: { value: rational.balanced - lazy.balanced, need: '≥ 25 п. п. ниже разумного', ok: rational.balanced - lazy.balanced >= 25 },
  shotgunCostRatio: { value: shotgun.money / Math.max(1, rational.money), need: '≥ 3', ok: shotgun.money >= 3 * rational.money },
  // лечение (spec 2026-09-first-shift): разумный врач почти не вредит и не даёт антибиотик без показаний
  rationalReactions: { value: rational.outcomes.reaction, need: '≤ 1 %', ok: rational.outcomes.reaction <= 1 },
  rationalNeedlessAntibiotic: { value: rational.needlessAntibiotic, need: '≤ 3 %', ok: rational.needlessAntibiotic <= 3 },
};

if (asJson) {
  console.log(JSON.stringify({ contentVersion: db.contentVersion, contentHash: db.hash, patients: N, seasons, threshold, totalMs: total, report, thresholds }, null, 2));
} else {
  console.log(`База ${db.contentVersion} (${db.hash}), отделение ${department}, пациентов ${N}, сезоны: ${seasons.join(', ')}, порог разумного врача ${threshold}`);
  console.log(`Время: ${(total / 1000).toFixed(2)} с на всех трёх врачей (${(total / N).toFixed(2)} мс на пациента)\n`);
  const names: Record<Strategy, string> = { rational: 'разумный', lazy: 'ленивый', shotgun: 'всё подряд' };
  for (const r of report) {
    console.log(`${names[r.strategy].padEnd(11)} точность ${r.accuracy.toFixed(1).padStart(5)} %  до группы ${r.groupAccuracy.toFixed(1).padStart(5)} %  сбалансированная ${r.balanced.toFixed(1).padStart(5)} %   ${r.money.toFixed(0).padStart(5)} ₽   ${r.minutes.toFixed(0).padStart(4)} мин   обследований ${r.exams.toFixed(1)}   ${r.msPerPatient.toFixed(2)} мс/пациент`);
  }
  const abcd = (g: Record<Grade, number>) => (['A', 'B', 'C', 'D'] as Grade[]).map(k => g[k].toFixed(0)).join('/');
  console.log('\nЛечение и исходы (оценки A/B/C/D, %):');
  for (const r of report) {
    const o = r.outcomes;
    console.log(`${names[r.strategy].padEnd(11)} случай ${abcd(r.overall).padEnd(12)} лечение ${abcd(r.treatment).padEnd(12)} выздоровел ${(o.recovered + o.improved).toFixed(1).padStart(5)} %  хуже ${o.worse.toFixed(1).padStart(4)} %  реакция ${o.reaction.toFixed(1).padStart(4)} %  переведён ${o.transferred.toFixed(1).padStart(4)} %  без изменений ${o.unchanged.toFixed(1).padStart(4)} %  антибиотик без показаний ${r.needlessAntibiotic.toFixed(1).padStart(4)} %`);
  }
  console.log('\nТочность разумного врача по болезням:');
  for (const [id, v] of Object.entries(rational.perCondition)) console.log(`  ${id.padEnd(28)} ${v.accuracy.toFixed(1).padStart(5)} %  до группы ${v.groupAccuracy.toFixed(1).padStart(5)} %  (n=${v.n})`);
  console.log('\nЧастые путаницы разумного врача:');
  for (const [k, v] of rational.topConfusions) console.log(`  ${k}: ${v}`);
  console.log('\nПороги (05-content.md §6):');
  for (const [k, t] of Object.entries(thresholds)) console.log(`  ${t.ok ? 'да ' : 'НЕТ'} ${k}: ${t.value.toFixed(2)} (нужно ${t.need})`);
}
