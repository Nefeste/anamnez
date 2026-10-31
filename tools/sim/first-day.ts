// bun tools/sim/first-day.ts — первые дни главы 1 глазами новичка (spec 2026-10-publish-ready, часть 100, вопрос 67):
// сколько больных уходят, не дождавшись, у разумного врача и у новичка на одних и тех же зёрнах, сложность «Студент»
// (её лист новой карьеры выбирает сам).
//   разумный — обследования разумного врача (policy), анализы и снимки — отпускает ждать, пока принимает следующего;
//   новичок — те же обследования и столько же сверх них из тех, что есть в больнице (осваивает вкладки и спрашивает
//     всё подряд), результаты ждёт в кабинете, зовёт по порядку очереди;
//   ученик — тот же новичок, но научен отпускать ждать результатов (как разумный): сколько даёт эта подсказка.
// Флаги: --runs 40 (зёрна), --days 2, --season winter.
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { examWhere } from '../../src/engine/hospital/requirements';
import { runDoctor } from '../../src/engine/med/policy';
import { apply, atDoctor, brokenOf, candidatesOf, current, hospitalCtx, isOut, newCampaign } from '../../src/engine/shift/engine';
import { type Command, DAY, SHIFT_END, type ShiftPatient, type ShiftState } from '../../src/engine/shift/types';
import { buildDb } from '../content/load';

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const RUNS = Number(arg('runs', '40'));
const DAYS = Number(arg('days', '2'));
const season = arg('season', 'winter') as 'winter' | 'spring' | 'summer' | 'autumn';

const { db, errors } = buildDb();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

type Player = 'rational' | 'novice' | 'learner';
const PLAYERS: readonly Player[] = ['rational', 'novice', 'learner'];
const NAMES: Record<Player, string> = { rational: 'Разумный', novice: 'Новичок', learner: 'Новичок, отпускает ждать результатов' };
interface Day { arrived: number; seen: number; left: number; unseen: number; waits: number[]; visits: number[] }

function decide(s: ShiftState, p: ShiftPatient, diagnosis: Id, treatments: readonly Id[], setting: Parameters<typeof apply>[2] & { kind: 'setting' }) {
  const step = (cmd: Command) => apply(db, s, cmd);
  step({ kind: 'diagnose', id: diagnosis });
  for (const id of treatments) step({ kind: 'toggleTreatment', id });
  step(setting);
  if (p.draft.setting !== setting.setting) step({ kind: 'setting', setting: 'ambulance' });
  step({ kind: 'finish' });
  if (current(s)?.id === p.id) {
    step({ kind: 'setting', setting: 'ambulance' });
    step({ kind: 'finish' });
  }
}

function playDay(s: ShiftState, player: Player, seed: number): Day {
  const step = (cmd: Command) => apply(db, s, cmd);
  const ctx = hospitalCtx(db, s);
  const exams = Object.keys(db.exams).sort().filter(id => !('block' in examWhere(db, ctx.plan, ctx.working, ctx.staffed, id, brokenOf(s))));
  // сверх плана новичок берёт то, что под рукой: расспрос и осмотр руками — по порядку базы
  const handy = exams.filter(id => ['ask', 'physical', 'bedside'].includes(db.exams[id].kind));
  const todo = new Map<string, Id[]>();
  const plans = new Map<string, ReturnType<typeof runDoctor>>();
  const waits: number[] = [];
  const visits: number[] = [];
  let since = 0;
  for (let guard = 0; guard < 20000; guard++) {
    for (const p of Object.values(s.patients)) {
      if (p.kind !== 'ambulance' || p.status !== 'waiting' || p.sorted || !p.scale) continue;
      step({ kind: 'sort', id: p.id, triage: p.scale.triage });
    }
    const coming = Object.values(s.patients).some(p => ['away', 'coming', 'intake'].includes(p.status));
    if (s.t % DAY >= SHIFT_END && s.queue.length === 0 && !s.current && !coming) break;
    if (!s.current && s.queue.length > 0) {
      const id = s.queue[0];
      const q = s.patients[id];
      if (q.step === 0) waits.push((s.t - q.arriveT) / 60);
      since = s.t;
      step({ kind: 'call', id });
      if (!s.current) continue;
    }
    const p = current(s);
    if (!p) {
      step({ kind: 'advance', seconds: 60 });
      continue;
    }
    if (!todo.has(p.id)) {
      const plan = runDoctor(db, p.patient, 'rational', Rng.seeded(seed).fork(`sim:${p.id}`), { candidates: candidatesOf(db, p.departments ?? s.meta.department), exams });
      plans.set(p.id, plan);
      const own = plan.exams.filter(e => !p.done.includes(e));
      const extra = player !== 'rational' ? handy.filter(e => !own.includes(e) && !p.done.includes(e)).slice(0, Math.max(2, own.length)) : [];
      todo.set(p.id, [...own, ...extra]);
    }
    const next = todo.get(p.id)![0];
    if (next) {
      if (isOut(s, p) && atDoctor(db, s, p, next)) {
        step(player !== 'novice' && s.queue.length > 0 && p.pending.length > 0 ? { kind: 'sendAway' } : { kind: 'waitResults' });
        continue;
      }
      todo.get(p.id)!.shift();
      step({ kind: 'exam', exam: next });
      continue;
    }
    if (p.pending.length > 0) {
      if (player !== 'novice' && s.queue.length > 0) {
        step({ kind: 'sendAway' });
        continue;
      }
      step({ kind: 'waitResults' });
      if (p.pending.length > 0) continue;
    }
    const plan = plans.get(p.id)!;
    decide(s, p, plan.diagnosis, plan.plan.treatments, { kind: 'setting', setting: plan.plan.setting });
    visits.push((s.t - since) / 60);
  }
  step({ kind: 'closeDay' });
  const h = s.history[s.history.length - 1];
  return { arrived: h.arrived, seen: h.seen, left: h.left, unseen: h.unseen, waits, visits };
}

const t0 = performance.now();
const out: Record<Player, Day[][]> = { rational: [], novice: [], learner: [] };
for (let i = 0; i < RUNS; i++) {
  for (const player of PLAYERS) {
    const seed = 4200 + i;
    const s = newCampaign(db, { seed, season, career: 1, difficulty: 'student' });
    const days: Day[] = [];
    for (let d = 0; d < DAYS; d++) {
      apply(db, s, { kind: 'nextDay' });
      if (!s.dayOpen) throw new Error(`${player}: смену не открыть`);
      days.push(playDay(s, player, seed));
    }
    out[player].push(days);
  }
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(0)} %`;
console.log(`Глава 1, «Студент», зёрен ${RUNS}, сезон ${season}, ${Math.round(performance.now() - t0)} мс`);
for (const player of PLAYERS) {
  console.log(`\n${NAMES[player]}`);
  for (let d = 0; d < DAYS; d++) {
    const days = out[player].map(x => x[d]);
    const arrived = days.reduce((a, x) => a + x.arrived, 0);
    const left = days.reduce((a, x) => a + x.left, 0);
    const unseen = days.reduce((a, x) => a + x.unseen, 0);
    const seen = days.reduce((a, x) => a + x.seen, 0);
    const worst = Math.max(...days.map(x => x.left));
    console.log(`  день ${d + 1}: пришли ${(arrived / RUNS).toFixed(1)}, приняты ${pct(seen, arrived)}, ушли ${pct(left, arrived)} (хуже всего — ${worst}), не успели ${pct(unseen, arrived)}; ` +
      `ожидание ${avg(days.flatMap(x => x.waits)).toFixed(0)} мин, приём ${avg(days.flatMap(x => x.visits)).toFixed(0)} мин`);
  }
}
