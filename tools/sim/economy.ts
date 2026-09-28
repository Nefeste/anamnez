// npm run economy-sim — баланс своей больницы (spec 2026-09-own-hospital, критерий приёмки 4):
// песочница с готовой амбулатории, 30 дней. Врачи — как в `doctor.ts`, но обследования только
// те, что больница может сделать, и игрок, как в `shift.ts`, отпускает ждать результатов:
//   разумный — обследования разумного врача;
//   «всё подряд» — все доступные обследования;
//   ленивый — без обследований, по жалобам;
//   и разумный в той же амбулатории без лаборатории и рентгена (снесены, их люди уволены), и —
//   для сведения — в самой простой: регистратура, ожидание, кабинет врача, санузел;
//   разумный и нанятый терапевт навыка 3 или 1 во втором кабинете, с ординаторской
//   (spec 2026-09-hired-doctors, критерий 2).
// Флаги: --days 30, --runs 8 (зёрна), --budget modest|normal|generous, --season winter, --json.
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { confirmed, expensesOf, incomeOf, type Ledger, PAYERS, type Payer } from '../../src/engine/economy/economy';
import { sizeOf } from '../../src/engine/hospital/build';
import { salaryOf } from '../../src/engine/hospital/staff';
import { examWhere } from '../../src/engine/hospital/requirements';
import { expectedGain, knownFacts, posterior } from '../../src/engine/med/infer';
import { choosePlan, examCost, runDoctor, type Strategy } from '../../src/engine/med/policy';
import type { Grade } from '../../src/engine/med/score';
import { apply, candidatesOf, current, hospitalCtx, newSandbox, observationsOf } from '../../src/engine/shift/engine';
import { type Command, DAY, SHIFT_END, type ShiftPatient, type ShiftState } from '../../src/engine/shift/types';
import { buildDb } from '../content/load';

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const DAYS = Number(arg('days', '30'));
const RUNS = Number(arg('runs', '8'));
const budgetKey = arg('budget', 'normal') as 'modest' | 'normal' | 'generous';
const season = arg('season', 'winter') as 'winter' | 'spring' | 'summer' | 'autumn';
const asJson = process.argv.includes('--json');

const { db, errors } = buildDb();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
const candidates = candidatesOf(db, 'dept.therapy');
const delayed = (id: Id) => {
  const e = db.exams[id];
  return e.kind === 'imaging' || e.kind === 'functional' || (e.time.turnaround ?? 0) + (e.time.report ?? 0) > 0;
};

interface Scenario {
  key: string; title: string; strategy: Strategy; without?: Id[]; /** назначает всё платное сразу, до расспроса */ prefetch?: boolean;
  /** нанятый терапевт этого навыка во втором кабинете (с ординаторской) */
  therapist?: number;
}
const SCENARIOS: Scenario[] = [
  { key: 'rational', title: 'Разумный', strategy: 'rational' },
  { key: 'shotgun', title: '«Всё подряд»', strategy: 'shotgun' },
  { key: 'lazy', title: 'Ленивый', strategy: 'lazy' },
  // для сведения: назначает все анализы, снимок и экспресс-тесты сразу, до расспроса, — окупается ли
  { key: 'prefetch', title: 'Разумный, но всё платное — сразу, до расспроса', strategy: 'rational', prefetch: true },
  { key: 'bare', title: 'Разумный без лаборатории и рентгена', strategy: 'rational', without: ['room.lab', 'room.xray'] },
  // для сведения: без всех кабинетов обследований — только регистратура, ожидание, кабинет врача, санузел
  { key: 'minimal', title: 'Разумный в самой простой амбулатории', strategy: 'rational', without: ['room.lab', 'room.xray', 'room.triage', 'room.procedure', 'room.ecg'] },
  // нанятые врачи: второй кабинет и ординаторская справа от амбулатории, коридор продлён к ним
  { key: 'therapist3', title: 'Разумный и терапевт навыка 3 во втором кабинете', strategy: 'rational', therapist: 3 },
  { key: 'therapist1', title: 'Разумный и терапевт навыка 1 во втором кабинете', strategy: 'rational', therapist: 1 },
];

interface Run {
  profit: number; minCash: number; reputation: number; value: number; byColleague: number;
  arrived: number; seen: number; left: number; unseen: number; correct: number; wrong: number;
  income: Record<Payer, number>; expenses: Ledger['expenses']; payers: Record<Payer, number>;
  defensibility: Record<Grade, number>; unconfirmed: number; oms: number; cut: number; unindicated: number;
  repPath: number[];
}

const unconfirmedBy: Record<string, number> = {};

/** Во что обошлась бы больница сейчас: помещения, аппараты, коридор. */
function valueOf(s: ShiftState): number {
  const h = s.hospital!;
  let v = h.corridor.length * db.economy.corridor.cost;
  for (const r of h.rooms) {
    v += sizeOf(db, r.type, r.size)?.cost ?? 0;
    for (const e of r.equipment) if (e) v += db.equipment[e]?.price ?? 0;
  }
  return v;
}

function start(seed: number, sc: Scenario): ShiftState {
  const s = newSandbox(db, { seed, season, start: 'clinic', budget: db.economy.sandbox.budgets[budgetKey] });
  if (sc.without) {
    for (const r of s.hospital!.rooms.filter(x => sc.without!.includes(x.type))) apply(db, s, { kind: 'build', cmd: { kind: 'demolish', room: r.id } });
    for (const m of (s.staff ?? []).filter(x => !x.room)) apply(db, s, { kind: 'fire', id: m.id });
    apply(db, s, { kind: 'buildEnd' });
  }
  if (sc.therapist) {
    // коридор — вправо от амбулатории; сверху ординаторская, снизу второй кабинет дверью к коридору
    const cells: [number, number][] = [];
    for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
    apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
    apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.staff', size: 'S', x: 30, y: 0, rot: 0 } });
    apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.office', size: 'M', x: 30, y: 10, rot: 2 } });
    apply(db, s, { kind: 'buildEnd' });
    const office = s.hospital!.rooms[s.hospital!.rooms.length - 1];
    if (office.type !== 'room.office') throw new Error('второй кабинет не построен');
    const role = 'role.therapist';
    s.staff = [...(s.staff ?? []), { id: 'h1', role, sex: 'f', seed: 1, skill: sc.therapist, salary: salaryOf(db, role, sc.therapist), room: office.id, days: 0 }];
  }
  return s;
}

const THRESHOLD = 0.9;
const MIN_GAIN = 0.02;

function beliefsOf(p: ShiftPatient) {
  const obs = observationsOf(p);
  const known = knownFacts(db, obs);
  const ctx = { sex: p.patient.sex, age: p.patient.age, season: p.patient.season, knownRisks: known.risks, knownConditions: known.conditions };
  return { obs, ctx, beliefs: posterior(db, candidates, obs, ctx) };
}

/**
 * Разумный врач смотрит на то, что пришло в смене: не уверен — ещё обследование, самое полезное
 * на единицу цены (как `runDoctor`). Назначил анализ или снимок — ждать результата: `true`.
 */
function topUp(s: ShiftState, p: ShiftPatient, exams: Id[]): boolean {
  for (let i = 0; i < exams.length; i++) {
    const { obs, ctx, beliefs } = beliefsOf(p);
    if (beliefs[0].p >= THRESHOLD) return false;
    const observed = new Set(obs.map(o => o.f));
    let best: Id | undefined;
    let bestScore = 0;
    for (const id of exams) {
      if (p.done.includes(id)) continue;
      const gain = expectedGain(db, id, beliefs, ctx, observed);
      if (gain < MIN_GAIN) continue;
      const score = gain / examCost(db, id);
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }
    if (!best) return false;
    apply(db, s, { kind: 'exam', exam: best });
    if (p.pending.length > 0) return true;
  }
  return false;
}

/** Диагноз не подтверждён, а подтвердить можно, — самое дешёвое из «Как подтвердить»; ждать результата: `true`. */
function confirmFor(s: ShiftState, p: ShiftPatient, exams: Id[]): boolean {
  const dx = beliefsOf(p).beliefs[0].id;
  const c = db.conditions[dx].confirm;
  if (c === 'clinical' || confirmed(db, dx, p.done)) return false;
  const can = c.filter(x => exams.includes(x)).sort((a, b) => examCost(db, a) - examCost(db, b));
  if (can.length === 0) return false;
  apply(db, s, { kind: 'exam', exam: can[0] });
  if (p.pending.length === 0) return false;
  if (s.queue.length > 0) apply(db, s, { kind: 'sendAway' });
  else while (p.pending.length > 0) apply(db, s, { kind: 'waitResults' });
  return true;
}

function playDay(s: ShiftState, strategy: Strategy, prefetch = false) {
  const ctx = hospitalCtx(db, s);
  const exams = Object.keys(db.exams).sort().filter(id => !('block' in examWhere(db, ctx.plan, ctx.working, ctx.staffed, id)));
  const started = new Set<string>();
  const step = (cmd: Command) => apply(db, s, cmd);
  for (let guard = 0; guard < 5000; guard++) {
    const end = s.t % DAY >= SHIFT_END && s.queue.length === 0 && !s.current
      && !Object.values(s.patients).some(p => p.status === 'away' || p.status === 'coming' || (p.by !== undefined && (p.status === 'inRoom' || p.status === 'waiting')));
    if (end) break;
    if (!s.current && s.queue.length > 0) step({ kind: 'call', id: s.queue[0] });
    const p = current(s);
    if (!p) {
      step({ kind: 'advance', seconds: 60 });
      continue;
    }
    if (!started.has(p.id)) {
      // план обследований — как у врача этой стратегии; назначить всё, что он назначил бы
      started.add(p.id);
      if (prefetch) for (const e of exams.filter(x => db.exams[x].cost > 0 && !p.done.includes(x))) step({ kind: 'exam', exam: e });
      const plan = runDoctor(db, p.patient, strategy, Rng.seeded(s.meta.seed).fork(`sim:${p.id}`), { candidates, exams });
      const todo = plan.exams.filter(e => !p.done.includes(e));
      for (const e of todo.filter(x => !delayed(x))) step({ kind: 'exam', exam: e });
      for (const e of todo.filter(delayed)) step({ kind: 'exam', exam: e });
    }
    // результатов ждать: есть другие — отпустить на обследования, нет — ждать в кабинете
    if (p.pending.length === 0 && strategy === 'rational') topUp(s, p, exams);
    if (p.pending.length > 0) {
      if (s.queue.length > 0) {
        step({ kind: 'sendAway' });
        continue;
      }
      while (p.pending.length > 0) step({ kind: 'waitResults' });
      if (strategy === 'rational' && topUp(s, p, exams)) continue;
    }
    // разумный подтверждает диагноз, как требует экспертиза ОМС, — если больница может
    if (strategy === 'rational' && confirmFor(s, p, exams)) continue;
    // диагноз и лечение — по тому, что пришло в смене
    const { obs, beliefs } = beliefsOf(p);
    const dx = beliefs[0].id;
    const tx = choosePlan(db, dx, obs);
    step({ kind: 'diagnose', id: dx });
    for (const id of tx.treatments) step({ kind: 'toggleTreatment', id });
    step({ kind: 'setting', setting: tx.setting });
    step({ kind: 'finish' });
  }
  step({ kind: 'closeDay' });
}

function run(seed: number, sc: Scenario): Run {
  const s = start(seed, sc);
  const out: Run = {
    profit: 0, minCash: s.economy!.cash, reputation: 0, value: valueOf(s), byColleague: 0,
    arrived: 0, seen: 0, left: 0, unseen: 0, correct: 0, wrong: 0,
    income: { oms: 0, dms: 0, self: 0 }, expenses: { salaries: 0, equipment: 0, rooms: 0, consumables: 0, interest: 0 }, payers: { oms: 0, dms: 0, self: 0 },
    defensibility: { A: 0, B: 0, C: 0, D: 0 }, unconfirmed: 0, oms: 0, cut: 0, unindicated: 0, repPath: [],
  };
  for (let d = 0; d < DAYS; d++) {
    apply(db, s, { kind: 'nextDay' });
    if (!s.dayOpen) throw new Error(`${sc.key}: смену не открыть`);
    playDay(s, sc.strategy, sc.prefetch);
    const h = s.history[s.history.length - 1];
    const e = h.economy!;
    out.profit += incomeOf(e.ledger) - expensesOf(e.ledger);
    out.minCash = Math.min(out.minCash, e.cash);
    for (const k of PAYERS) out.income[k] += e.ledger.income[k];
    for (const k of Object.keys(out.expenses) as (keyof Ledger['expenses'])[]) out.expenses[k] = (out.expenses[k] ?? 0) + (e.ledger.expenses[k] ?? 0);
    out.cut += e.ledger.audit.cut;
    out.unindicated += e.ledger.audit.unindicated;
    const col = Object.values(h.colleagues ?? {});
    out.arrived += h.arrived;
    out.seen += col.reduce((n, c) => n + c.seen, h.seen);
    out.left += h.left;
    out.unseen += h.unseen;
    out.correct += col.reduce((n, c) => n + c.correct, h.correct);
    out.wrong += col.reduce((n, c) => n + c.wrong, h.wrong);
    out.byColleague += col.reduce((n, c) => n + c.seen, 0);
    out.repPath.push(e.reputation.to);
    for (const p of Object.values(s.patients)) {
      if (!p.closed || Math.floor(p.closed.at / DAY) + 1 !== s.day) continue;
      const payer = p.payer ?? 'oms';
      out.payers[payer]++;
      if (payer !== 'oms') continue;
      out.oms++;
      out.defensibility[p.closed.grades.defensibility]++;
      if (!confirmed(db, p.closed.diagnosis, p.done)) {
        out.unconfirmed++;
        if (process.env.ECON_DEBUG) unconfirmedBy[`${sc.key}:${p.closed.diagnosis}`] = (unconfirmedBy[`${sc.key}:${p.closed.diagnosis}`] ?? 0) + 1;
      }
    }
  }
  out.reputation = s.economy!.reputation ?? 0;
  return out;
}

const rub = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;
const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(1)} %`;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

const t0 = performance.now();
const results: Record<string, Run[]> = {};
for (const sc of SCENARIOS) results[sc.key] = Array.from({ length: RUNS }, (_, i) => run(7000 + i, sc));

const value = results.rational[0].value;
const startCash = Math.floor((db.economy.sandbox.budgets[budgetKey] * db.economy.sandbox.clinicShare) / 100);
const summary = Object.fromEntries(SCENARIOS.map(sc => {
  const rs = results[sc.key];
  return [sc.key, {
    profit: Math.round(mean(rs.map(r => r.profit))), profitMin: Math.min(...rs.map(r => r.profit)), profitMax: Math.max(...rs.map(r => r.profit)),
    minCash: Math.min(...rs.map(r => r.minCash)), reputation: Math.round(mean(rs.map(r => r.reputation))),
    reputationMin: Math.min(...rs.map(r => r.reputation)), reputationMax: Math.max(...rs.map(r => r.reputation)),
  }];
}));
const seenShare = (key: string) => results[key].reduce((a, r) => a + r.seen, 0) / Math.max(1, results[key].reduce((a, r) => a + r.arrived, 0));
const criteria = {
  rationalNeverNegative: summary.rational.minCash >= 0,
  rationalProfitShare: Math.round((100 * summary.rational.profit) / value),
  rationalProfitInRange: summary.rational.profit >= value / 4 && summary.rational.profit <= value,
  shotgunEarnsLess: summary.shotgun.profit < summary.rational.profit,
  lazyReputationBelow40: summary.lazy.reputation < 40,
  bareEarnsLess: summary.bare.profit < summary.rational.profit,
  // нанятые врачи (spec 2026-09-hired-doctors, критерий 2)
  therapistPays: summary.therapist3.profit > summary.rational.profit,
  therapistSeesMore: seenShare('therapist3') > seenShare('rational'),
  weakTherapistWorse: summary.therapist1.profit < summary.therapist3.profit && summary.therapist1.reputation < summary.therapist3.reputation,
};

if (asJson) {
  console.log(JSON.stringify({ days: DAYS, runs: RUNS, budget: budgetKey, season, value, startCash, summary, criteria }, null, 2));
  process.exit(Object.entries(criteria).every(([k, v]) => k === 'rationalProfitShare' || v) ? 0 : 1);
}

console.log(`Песочница с готовой амбулатории: ${DAYS} дней × ${RUNS} зёрен, бюджет ${budgetKey}, сезон ${season}, ${Math.round((performance.now() - t0) / 1000)} с`);
console.log(`Цена готовой амбулатории: ${rub(value)}; в кассе на старте: ${rub(startCash)}`);
for (const sc of SCENARIOS) {
  const rs = results[sc.key];
  const n = rs.length * DAYS;
  const sum = <K extends keyof Run>(k: K) => rs.reduce((a, r) => a + (r[k] as number), 0);
  const inc = (p: Payer) => rs.reduce((a, r) => a + r.income[p], 0) / n;
  const exp = (k: keyof Ledger['expenses']) => rs.reduce((a, r) => a + (r.expenses[k] ?? 0), 0) / n;
  const payers = (p: Payer) => rs.reduce((a, r) => a + r.payers[p], 0);
  const grades = (g: Grade) => rs.reduce((a, r) => a + r.defensibility[g], 0);
  const oms = sum('oms');
  const x = summary[sc.key];
  console.log(`\n${sc.title}${sc.without ? ` (цена ${rub(rs[0].value)})` : ''}`);
  console.log(`  в день: пришли ${(sum('arrived') / n).toFixed(1)}, приняты ${pct(sum('seen'), sum('arrived'))}${sc.therapist ? ` (из них терапевтом ${pct(sum('byColleague'), sum('seen'))})` : ''}, ушли ${pct(sum('left'), sum('arrived'))}, не приняты ${pct(sum('unseen'), sum('arrived'))}; верно ${pct(sum('correct'), sum('seen'))}, ошибок ${pct(sum('wrong'), sum('seen'))}`);
  console.log(`  плательщики: ОМС ${pct(payers('oms'), sum('seen'))}, ДМС ${pct(payers('dms'), sum('seen'))}, платно ${pct(payers('self'), sum('seen'))}; ОМС: обоснованность A/B/C/D ${(['A', 'B', 'C', 'D'] as const).map(g => pct(grades(g), oms)).join(' / ')}, не подтверждено ${pct(sum('unconfirmed'), oms)}`);
  console.log(`  доход в день: ОМС ${rub(inc('oms'))}, ДМС ${rub(inc('dms'))}, платно ${rub(inc('self'))}; экспертиза сняла ${rub(sum('cut') / n)}, обследований без показаний ${(sum('unindicated') / n).toFixed(1)}`);
  console.log(`  расход в день: зарплаты ${rub(exp('salaries'))}, аппараты ${rub(exp('equipment'))}, помещения ${rub(exp('rooms'))}, расходники ${rub(exp('consumables'))}, проценты ${rub(exp('interest'))}`);
  console.log(`  прибыль за ${DAYS} дней: ${rub(x.profit)} (${rub(x.profitMin)} … ${rub(x.profitMax)}) — ${pct(x.profit, value)} цены амбулатории; касса не ниже ${rub(x.minCash)}`);
  const path = rs.map(r => r.repPath);
  const at = (d: number) => Math.round(mean(path.map(p => p[Math.min(d, p.length - 1)])));
  console.log(`  репутация: день 5 — ${at(4)}, 10 — ${at(9)}, 20 — ${at(19)}, ${DAYS} — ${x.reputation} (${x.reputationMin} … ${x.reputationMax})`);
}
if (process.env.ECON_DEBUG) console.log(Object.entries(unconfirmedBy).sort((a, b) => b[1] - a[1]).slice(0, 30));
console.log('\nКритерии (spec 2026-09-own-hospital, приёмка 4):');
const yes = (ok: boolean) => (ok ? 'да ' : 'НЕТ');
console.log(`  ${yes(criteria.rationalNeverNegative)} у разумного касса ни разу не в минусе`);
console.log(`  ${yes(criteria.rationalProfitInRange)} прибыль разумного за ${DAYS} дней — от четверти до всей цены амбулатории: ${criteria.rationalProfitShare} %`);
console.log(`  ${yes(criteria.shotgunEarnsLess)} «всё подряд» зарабатывает меньше разумного`);
console.log(`  ${yes(criteria.lazyReputationBelow40)} у ленивого репутация ниже 40: ${summary.lazy.reputation}`);
console.log(`  ${yes(criteria.bareEarnsLess)} без лаборатории и рентгена — меньше, чем с ними`);
console.log('Критерии (spec 2026-09-hired-doctors, приёмка 2):');
console.log(`  ${yes(criteria.therapistPays)} с терапевтом навыка 3 прибыль больше, чем без него: ${rub(summary.therapist3.profit)} против ${rub(summary.rational.profit)}`);
console.log(`  ${yes(criteria.therapistSeesMore)} с ним принимают больше: ${(100 * seenShare('therapist3')).toFixed(1)} % против ${(100 * seenShare('rational')).toFixed(1)} %`);
console.log(`  ${yes(criteria.weakTherapistWorse)} с терапевтом навыка 1 прибыль и репутация ниже, чем с навыком 3: ${rub(summary.therapist1.profit)}, ${summary.therapist1.reputation} против ${rub(summary.therapist3.profit)}, ${summary.therapist3.reputation}`);
