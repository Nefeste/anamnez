// npm run shift-sim — темп смены (spec 2026-09-first-shift): успевает ли врач принять
// очередь. Два игрока на одних и тех же сменах:
//   разумный — обследования разумного врача (policy), анализы и снимки назначает и
//     отпускает ждать, пока принимает следующего;
//   терпеливый — те же обследования, но ждёт каждый результат в кабинете.
// Флаги: --shifts 200, --season winter|spring|summer|autumn.
import { Rng } from '../../src/engine/core/rng';
import { runDoctor } from '../../src/engine/med/policy';
import { apply, candidatesOf, current, newShift } from '../../src/engine/shift/engine';
import { DAY, SHIFT_END, type ShiftState } from '../../src/engine/shift/types';
import { buildDb } from '../content/load';

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const SHIFTS = Number(arg('shifts', '200'));
const season = arg('season', 'winter') as 'winter' | 'spring' | 'summer' | 'autumn';

const { db, errors } = buildDb();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
const candidates = candidatesOf(db, 'dept.therapy');
const exams = Object.keys(db.exams).sort();
const delayed = (id: string) => {
  const e = db.exams[id];
  return e.kind === 'imaging' || e.kind === 'functional' || (e.time.turnaround ?? 0) + (e.time.report ?? 0) > 0;
};

type Player = 'rational' | 'patient';

interface Tally {
  shifts: number; arrived: number; seen: number; left: number; unseen: number;
  /** ожидание до первого вызова, минуты */
  waitSum: number; waitMax: number; waitN: number;
  /** врач занят пациентами (часы шли делами), доля смены 08:00–14:00 */
  busySum: number;
  /** когда закрыт последний случай, минуты после 14:00 */
  overtimeSum: number;
  leftByTriage: Record<string, number>;
}

function play(seed: number, player: Player): { s: ShiftState; waits: number[]; busy: number; lastClose: number } {
  const s = newShift(db, { seed, season });
  const plans = new Map<string, ReturnType<typeof runDoctor>>();
  const waits: number[] = [];
  let busy = 0;
  let lastClose = 0;
  const step = (cmd: Parameters<typeof apply>[2]) => {
    const t = s.t;
    apply(db, s, cmd);
    if (cmd.kind !== 'advance') busy += s.t - t;
  };
  for (let guard = 0; guard < 5000; guard++) {
    const end = s.t % DAY >= SHIFT_END && s.queue.length === 0 && !s.current && !Object.values(s.patients).some(p => p.status === 'away' || p.status === 'coming');
    if (end) break;
    if (!s.current && s.queue.length > 0) {
      const id = s.queue[0];
      const p = s.patients[id];
      if (p.step === 0) waits.push((s.t - p.arriveT) / 60);
      step({ kind: 'call', id });
    }
    const p = current(s);
    if (!p) {
      step({ kind: 'advance', seconds: 60 });
      continue;
    }
    let plan = plans.get(p.id);
    if (!plan) {
      plan = runDoctor(db, p.patient, 'rational', Rng.seeded(seed).fork(`sim:${p.id}`), { candidates, exams });
      plans.set(p.id, plan);
      const todo = plan.exams.filter(e => !p.done.includes(e));
      for (const e of todo.filter(x => !delayed(x))) step({ kind: 'exam', exam: e });
      for (const e of todo.filter(delayed)) step({ kind: 'exam', exam: e });
      if (p.pending.length > 0) {
        if (player === 'rational' && s.queue.length > 0) {
          step({ kind: 'sendAway' });
          continue;
        }
        while (p.pending.length > 0) step({ kind: 'waitResults' });
      }
    } else if (p.pending.length > 0) {
      while (p.pending.length > 0) step({ kind: 'waitResults' });
    }
    step({ kind: 'diagnose', id: plan.diagnosis });
    for (const tx of plan.plan.treatments) step({ kind: 'toggleTreatment', id: tx });
    step({ kind: 'setting', setting: plan.plan.setting });
    step({ kind: 'finish' });
    lastClose = s.t;
  }
  apply(db, s, { kind: 'closeDay' });
  return { s, waits, busy, lastClose };
}

const tallies: Record<Player, Tally> = {
  rational: { shifts: 0, arrived: 0, seen: 0, left: 0, unseen: 0, waitSum: 0, waitMax: 0, waitN: 0, busySum: 0, overtimeSum: 0, leftByTriage: {} },
  patient: { shifts: 0, arrived: 0, seen: 0, left: 0, unseen: 0, waitSum: 0, waitMax: 0, waitN: 0, busySum: 0, overtimeSum: 0, leftByTriage: {} },
};

const t0 = performance.now();
for (let i = 0; i < SHIFTS; i++) {
  for (const player of ['rational', 'patient'] as const) {
    const { s, waits, busy, lastClose } = play(1000 + i, player);
    const h = s.history[0];
    const t = tallies[player];
    t.shifts++;
    t.arrived += h.arrived;
    t.seen += h.seen;
    t.left += h.left;
    t.unseen += h.unseen;
    for (const w of waits) {
      t.waitSum += w;
      t.waitN++;
      t.waitMax = Math.max(t.waitMax, w);
    }
    t.busySum += busy / (SHIFT_END - 8 * 3600);
    t.overtimeSum += Math.max(0, lastClose - SHIFT_END) / 60;
    for (const p of Object.values(s.patients)) if (p.status === 'left') t.leftByTriage[p.triage] = (t.leftByTriage[p.triage] ?? 0) + 1;
  }
}

const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(1)} %`;
console.log(`Смен: ${SHIFTS}, сезон ${season}, ${Math.round(performance.now() - t0)} мс`);
for (const [name, t] of Object.entries(tallies)) {
  console.log(`\n${name === 'rational' ? 'Разумный (отпускает ждать результатов)' : 'Терпеливый (ждёт результаты в кабинете)'}`);
  console.log(`  пришли за смену: ${(t.arrived / t.shifts).toFixed(1)}; приняты ${pct(t.seen, t.arrived)}, ушли, не дождавшись, ${pct(t.left, t.arrived)}, не успели ${pct(t.unseen, t.arrived)}`);
  console.log(`  ушли по срочности: ${JSON.stringify(t.leftByTriage)}`);
  console.log(`  ожидание до вызова: в среднем ${(t.waitSum / Math.max(1, t.waitN)).toFixed(0)} мин, дольше всех ${t.waitMax.toFixed(0)} мин`);
  console.log(`  врач занят делами: ${pct(t.busySum, t.shifts)} смены; после 14:00 — ${(t.overtimeSum / t.shifts).toFixed(0)} мин`);
}
