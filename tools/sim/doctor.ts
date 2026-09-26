// npm run doctor — «виртуальный врач» по базе (`docs/05-content.md` §6, `docs/09-testing.md` §3).
// Три стратегии на одних и тех же пациентах: разумный, ленивый, «всё подряд».
// Флаги: --n 10000 (пациентов), --season winter|spring|summer|autumn|all, --json (для CI).
import { Rng } from '../../src/engine/core/rng';
import { generatePatient } from '../../src/engine/med/generate';
import { runDoctor, type Strategy } from '../../src/engine/med/policy';
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

interface Tally { n: number; correct: number; correctGroup: number; money: number; minutes: number; exams: number; confusion: Record<string, number>; perCondition: Record<string, { n: number; correct: number; correctGroup: number }> }
const empty = (): Tally => ({ n: 0, correct: 0, correctGroup: 0, money: 0, minutes: 0, exams: 0, confusion: {}, perCondition: {} });
const strategies: Strategy[] = ['rational', 'lazy', 'shotgun'];
const tally: Record<Strategy, Tally> = { rational: empty(), lazy: empty(), shotgun: empty() };
const timing: Record<Strategy, number> = { rational: 0, lazy: 0, shotgun: 0 };

const t0 = performance.now();
for (let i = 0; i < N; i++) {
  const season = seasons[i % seasons.length];
  const patient = generatePatient(db, 9_000_000 + i, { department, season });
  const truth = patient.truth.conditions[0].id;
  for (const s of strategies) {
    const t = performance.now();
    const r = runDoctor(db, patient, s, Rng.seeded(patient.seed).fork(`doctor:${s}`), { candidates, exams, threshold });
    timing[s] += performance.now() - t;
    const x = tally[s];
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
  console.log('\nТочность разумного врача по болезням:');
  for (const [id, v] of Object.entries(rational.perCondition)) console.log(`  ${id.padEnd(28)} ${v.accuracy.toFixed(1).padStart(5)} %  до группы ${v.groupAccuracy.toFixed(1).padStart(5)} %  (n=${v.n})`);
  console.log('\nЧастые путаницы разумного врача:');
  for (const [k, v] of rational.topConfusions) console.log(`  ${k}: ${v}`);
  console.log('\nПороги (05-content.md §6):');
  for (const [k, t] of Object.entries(thresholds)) console.log(`  ${t.ok ? 'да ' : 'НЕТ'} ${k}: ${t.value.toFixed(2)} (нужно ${t.need})`);
}
