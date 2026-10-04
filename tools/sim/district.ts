// npm run district-sim — районная больница главы 2 (spec 2026-09-chapter-2, критерии приёмки 3 и 4):
// глава «Приёмное» с начала, 30 дней. Два врача на одних и тех же зёрнах:
//   разумный — сортирует привезённых по шкале с листа передачи; обследования разумного врача из
//     тех, что больница может сделать, анализы и снимки — отпускает ждать; где лечить — по плану
//     лечения и тому, что есть в больнице (свободная койка, операционная); на обходе выписывает,
//     когда можно, хуже — в операционную, если у болезни есть операция, иначе переводит;
//   ленивый — всех привезённых сортирует «зелёными», без обследований, по жалобам; на первом же
//     обходе выписывает всех, кого можно.
// Стационар и операционная окупаются, если случаи стационара (с операцией — и за неё) приносят не
// меньше, чем стоят их койко-дни и расходники операций, палаты и операционная (содержание,
// аппараты) и люди в них. Койко-дни и расходники — у закрытых случаев: кто ещё лежит на 30-й день,
// тот ещё не оплачен, и его траты — вместе с его оплатой, после (для сведения — и всё подряд).
// С 0.3.2 (spec 2026-10-chapter-3, часть 37) — и сроки: разумный лежащему в смотровой с болью в
// груди первым делом снимает ЭКГ у постели — в первые 10 минут от прихода.
// И карьера с начала (критерий этапа 4: обе главы проходятся от начала до конца): разумный в
// главе 1 открывает лабораторию, как велит задание, принимает, пока основные задания не выполнены,
// переходит в главу 2 и принимает, пока не выполнены и её.
// Флаги: --days 30, --runs 4 (зёрна), --season winter, --json.
import type { Id } from '../../src/content/types';
import { nextChapterOf } from '../../src/engine/campaign/campaign';
import { Rng } from '../../src/engine/core/rng';
import { expensesOf, incomeOf, type WardClose, wardIncome } from '../../src/engine/economy/economy';
import { sizeOf } from '../../src/engine/hospital/build';
import { examWhere } from '../../src/engine/hospital/requirements';
import { contextOf, posterior } from '../../src/engine/med/infer';
import { alsoSettings, recommendedSetting, settingFit } from '../../src/engine/med/plan';
import { choosePlan, decisionLimit, examMinutes, MIN_GAIN, nextStep, runDoctor, type Strategy } from '../../src/engine/med/policy';
import {
  apply, candidatesOf, current, freeBeds, hospitalCtx, inpatientsOf, moreUrgent, newCampaign, observationsOf, operationOf, targetPlace,
} from '../../src/engine/shift/engine';
import { targetStart, targetsFor } from '../../src/engine/shift/targets';
import { type Command, DAY, SHIFT_END, type ShiftPatient, type ShiftState } from '../../src/engine/shift/types';
import { daysIn, wardState } from '../../src/engine/shift/ward';
import { buildDb } from '../content/load';

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const DAYS = Number(arg('days', '30'));
/** карьера: дней на обе главы — не больше */
const CAREER_DAYS = 60;
const RUNS = Number(arg('runs', '4'));
const season = arg('season', 'winter') as 'winter' | 'spring' | 'summer' | 'autumn';
const asJson = process.argv.includes('--json');
const CHAPTER = 'chapter.hospital';
/** закрыть приём — рецепт, направление: 2 минуты (engine.ts, finish) */
const CLOSE_MIN = 2;

const { db, errors } = buildDb();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
const delayed = (id: Id) => {
  const e = db.exams[id];
  return e.kind === 'imaging' || e.kind === 'functional' || (e.time.turnaround ?? 0) + (e.time.report ?? 0) > 0;
};
/** помещения стационара и операционной — их содержание, аппараты и люди */
const WARD_ROOMS = new Set(['room.ward']);
const OR_ROOMS = new Set(['room.or']);

type Player = Extract<Strategy, 'rational' | 'lazy'>;
const PLAYERS: Player[] = ['rational', 'lazy'];

interface Run {
  profit: number; minCash: number; cash: number; reputation: number;
  arrived: number; seen: number; left: number; unseen: number; correct: number; wrong: number;
  /** по отделению болезни, которой болен на самом деле: принято и верно */
  departments: Record<Id, { seen: number; correct: number }>;
  ambulance: { arrived: number; sorted: number; under: number; over: number };
  ward: { admitted: number; discharged: number; early: number; transferred: number; died: number; stayDays: number; stayNorm: number; returnsWorse: number };
  ops: { done: number; onTime: number; late: number; complicated: number; waited: number; complications: number; good: number };
  /**
   * стационар и операционная за все дни, ₽: оплата случаев (из неё прибавка за операции), койко-дни
   * и расходники операций — всех и закрытых случаев, содержание и люди палат и операционной
   */
  money: {
    income: number; opIncome: number; bedDays: number; opConsumables: number; closedBedDays: number; closedOpCost: number;
    /** случаи с операцией: оплата целиком (тариф и прибавка) и их койко-дни */
    opCases: number; opCasesBedDays: number;
    wardUpkeep: number; wardStaff: number; orUpkeep: number; orStaff: number;
  };
  /** в какой день главы выполнено основное задание; нет — не выполнено */
  missions: Record<string, number | undefined>;
  /** стало хуже: вернулись хуже или с реакцией на лечение, умерли в стационаре */
  harmed: number;
  /** сроки (часть 37): у скольких приёмов срок был и у скольких выполнен */
  targets: { onTime: number; total: number };
}

/** Что стоят за день палаты и операционная: содержание помещений и аппаратов и зарплаты людей в них. */
function unitCosts(s: ShiftState) {
  const h = s.hospital!;
  const out = { wardUpkeep: 0, wardStaff: 0, orUpkeep: 0, orStaff: 0 };
  for (const r of h.rooms) {
    const unit = WARD_ROOMS.has(r.type) ? 'ward' : OR_ROOMS.has(r.type) ? 'or' : undefined;
    if (!unit) continue;
    let upkeep = sizeOf(db, r.type, r.size)?.upkeep ?? 0;
    for (const e of r.equipment) if (e) upkeep += db.equipment[e]?.upkeep ?? 0;
    const staff = (s.staff ?? []).filter(m => m.room === r.id).reduce((a, m) => a + m.salary, 0);
    if (unit === 'ward') {
      out.wardUpkeep += upkeep;
      out.wardStaff += staff;
    } else {
      out.orUpkeep += upkeep;
      out.orStaff += staff;
    }
  }
  return out;
}

/**
 * Сколько минут осталось до ближайшего срока на назначение или место, который уже идёт (подъём ST:
 * тромболизис — 10 минут от ЭКГ, перевод — 30 от прихода); такого нет — undefined.
 */
function minutesLeft(s: ShiftState, p: ShiftPatient): number | undefined {
  const left: number[] = [];
  for (const t of targetsFor(db, p, targetPlace(db, s, p))) {
    const start = targetStart(p, t);
    if ((t.treatments.length > 0 || t.settings.length > 0) && start !== undefined) left.push(t.minutes - (s.t - start) / 60);
  }
  return left.length > 0 ? Math.min(...left) : undefined;
}

function beliefsOf(s: ShiftState, p: ShiftPatient) {
  const obs = observationsOf(p);
  return { obs, beliefs: posterior(db, candidatesOf(db, p.departments ?? s.meta.department), obs, contextOf(db, p.patient, obs)) };
}

/**
 * Утренний обход: разумный выписывает, когда можно, хуже — в операционную (есть операция и она
 * возможна) или переводит; ленивый выписывает всех, кто не ждёт операции и не на столе.
 */
function rounds(s: ShiftState, player: Player, step: (cmd: Command) => void) {
  for (const p of inpatientsOf(s)) {
    const stay = p.stay!;
    if (stay.op && !stay.op.done) continue;
    const days = daysIn(stay, s.day);
    if (days < 1) continue;
    if (player === 'lazy') {
      step({ kind: 'discharge', id: p.id });
      continue;
    }
    const state = wardState(stay, days);
    if (state === 'ready') step({ kind: 'discharge', id: p.id });
    else if (state === 'worse' && !stay.op && p.closed && operationOf(db, p, p.closed.diagnosis)) {
      step({ kind: 'operate', id: p.id });
      if (!p.stay?.op) step({ kind: 'transfer', id: p.id });
    } else if (state === 'worse' || state === 'reaction') step({ kind: 'transfer', id: p.id });
  }
}

function playDay(s: ShiftState, player: Player) {
  const step = (cmd: Command) => apply(db, s, cmd);
  rounds(s, player, step);
  const ctx = hospitalCtx(db, s);
  const exams = Object.keys(db.exams).sort().filter(id => !('block' in examWhere(db, ctx.plan, ctx.working, ctx.staffed, id)));
  /** что врач ещё сделает у пациента: план — при первом вызове, дальше по одному обследованию */
  const todo = new Map<string, Id[]>();
  for (let guard = 0; guard < 20000; guard++) {
    // привезённых — сортировать: разумный — по шкале, ленивый — всех «зелёными»
    for (const p of Object.values(s.patients)) {
      if (p.kind !== 'ambulance' || p.status !== 'waiting' || p.sorted || !p.scale) continue;
      step({ kind: 'sort', id: p.id, triage: player === 'rational' ? p.scale.triage : 'green' });
    }
    const waiting = Object.values(s.patients).some(p => p.status === 'away' || p.status === 'coming' || (p.kind === 'ambulance' && p.status === 'waiting' && !p.sorted));
    if (s.t % DAY >= SHIFT_END && s.queue.length === 0 && !s.current && !waiting) break;
    if (!s.current && s.queue.length > 0) step({ kind: 'call', id: s.queue[0] });
    const p = current(s);
    if (!p) {
      step({ kind: 'advance', seconds: 60 });
      continue;
    }
    const candidates = candidatesOf(db, p.departments ?? s.meta.department);
    if (!todo.has(p.id)) {
      const list: Id[] = [];
      // срок (часть 37): разумный первым делом делает то, что надо успеть, — ЭКГ у постели
      if (player === 'rational') {
        for (const t of targetsFor(db, p, targetPlace(db, s, p))) {
          const e = t.exams.find(x => exams.includes(x) && !p.done.includes(x));
          if (e && !list.includes(e)) list.push(e);
        }
      }
      const plan = runDoctor(db, p.patient, player, Rng.seeded(s.meta.seed).fork(`sim:${p.id}`), { candidates, exams });
      const rest = plan.exams.filter(e => !p.done.includes(e) && !list.includes(e));
      list.push(...rest.filter(x => !delayed(x)), ...rest.filter(delayed));
      todo.set(p.id, list);
    }
    // привезли срочнее — разумный просит подождать того, кто в кабинете, и идёт к привезённому
    // (часть 37: ЭКГ при боли в груди — в первые 10 минут, а опрос может идти и полчаса); ждёт тот
    // результатов — ждёт их вне кабинета, а не пока ему назначат остальное (часть 39г)
    if (player === 'rational' && moreUrgent(s, p)) {
      step({ kind: 'sendAway' });
      continue;
    }
    // находка срока в пришедших результатах (подъём ST: тромболизис за 10 минут, перевод за 30) — план,
    // заготовленный при первом вызове по своему прогону, мог её не увидеть и ждать тропонина. Дальше
    // разумный идёт по пришедшему, шаг за шагом: нужное и успевающее до срока с закрытием приёма — или
    // решение, не дожидаясь назначенного раньше (spec 2026-10-chapter-3, часть 39г)
    const limit = player === 'rational' ? decisionLimit(db, observationsOf(p)) : undefined;
    const deadline = limit !== undefined;
    if (deadline) {
      const left = Math.min(limit, minutesLeft(s, p) ?? Infinity) - CLOSE_MIN;
      const fits = exams.filter(e => examMinutes(db.exams[e]) <= left);
      const ns = fits.length > 0 ? nextStep(db, p.patient, observationsOf(p), p.done, {}, { candidates, exams: fits, threshold: 0.9, minGain: MIN_GAIN }).step : undefined;
      todo.set(p.id, ns?.kind === 'exam' && !p.done.includes(ns.exam) ? [ns.exam] : []);
    }
    const next = todo.get(p.id)!.shift();
    if (next) {
      step({ kind: 'exam', exam: next });
      continue;
    }
    if (p.pending.length > 0 && !deadline) {
      if (s.queue.length > 0) {
        step({ kind: 'sendAway' });
        continue;
      }
      // ждать — до результатов или до приезда скорой (часть 37): тогда — к началу, сортировать
      // привезённого и отпустить ждать того, кто в кабинете
      step({ kind: 'waitResults' });
      if (p.pending.length > 0) continue;
    }
    const { obs, beliefs } = beliefsOf(s, p);
    const dx = beliefs[0].id;
    const tx = choosePlan(db, dx, obs, p.patient.age, { ward: freeBeds(db, s).length > 0, or: true });
    step({ kind: 'diagnose', id: dx });
    for (const id of tx.treatments) step({ kind: 'toggleTreatment', id });
    step({ kind: 'setting', setting: tx.setting });
    // своя палата или операционная не берёт (койки нет, операции нет) — выбор не принят: скорая
    if (p.draft.setting !== tx.setting) step({ kind: 'setting', setting: 'ambulance' });
    step({ kind: 'finish' });
    if (current(s)?.id === p.id) {
      step({ kind: 'setting', setting: 'ambulance' });
      step({ kind: 'finish' });
    }
  }
  step({ kind: 'closeDay' });
}

function run(seed: number, player: Player): Run {
  const s = newCampaign(db, { seed, season, career: 1, chapter: CHAPTER });
  const out: Run = {
    profit: 0, minCash: s.economy!.cash, cash: 0, reputation: 0,
    arrived: 0, seen: 0, left: 0, unseen: 0, correct: 0, wrong: 0, departments: {},
    ambulance: { arrived: 0, sorted: 0, under: 0, over: 0 },
    ward: { admitted: 0, discharged: 0, early: 0, transferred: 0, died: 0, stayDays: 0, stayNorm: 0, returnsWorse: 0 },
    ops: { done: 0, onTime: 0, late: 0, complicated: 0, waited: 0, complications: 0, good: 0 },
    money: { income: 0, opIncome: 0, bedDays: 0, opConsumables: 0, closedBedDays: 0, closedOpCost: 0, opCases: 0, opCasesBedDays: 0, wardUpkeep: 0, wardStaff: 0, orUpkeep: 0, orStaff: 0 },
    missions: {}, harmed: 0, targets: { onTime: 0, total: 0 },
  };
  const operated = new Set<string>();
  const closedStays = new Set<string>();
  for (let d = 0; d < DAYS; d++) {
    apply(db, s, { kind: 'nextDay' });
    if (!s.dayOpen) throw new Error(`${player}: смену не открыть`);
    playDay(s, player);
    const h = s.history[s.history.length - 1];
    const l = h.economy!.ledger;
    out.profit += incomeOf(l) - expensesOf(l);
    out.minCash = Math.min(out.minCash, h.economy!.cash);
    out.arrived += h.arrived;
    out.seen += h.seen;
    out.left += h.left;
    out.unseen += h.unseen;
    out.correct += h.correct;
    out.wrong += h.wrong;
    for (const k of Object.keys(out.ambulance) as (keyof Run['ambulance'])[]) out.ambulance[k] += h.ambulance?.[k] ?? 0;
    for (const t of Object.values(h.targets ?? {})) {
      out.targets.onTime += t.onTime;
      out.targets.total += t.total;
    }
    const w = h.ward;
    if (w) {
      out.ward.admitted += w.admitted;
      out.ward.discharged += w.discharged;
      out.ward.early += w.early;
      out.ward.transferred += w.transferred;
      out.ward.died += w.died ?? 0;
      out.ward.stayDays += w.stayDays;
      out.ward.stayNorm += w.stayNorm;
    }
    const o = h.surgery;
    if (o) {
      out.ops.done += o.done;
      out.ops.onTime += o.onTime;
      out.ops.late += o.late;
      out.ops.complicated += o.complicated ?? 0;
      out.ops.waited += o.waited ?? 0;
      out.ops.complications += o.complications;
      out.ops.good += o.good ?? 0;
    }
    out.money.income += l.ward?.income ?? 0;
    out.money.bedDays += l.expenses.ward ?? 0;
    const unit = unitCosts(s);
    out.money.wardUpkeep += unit.wardUpkeep;
    out.money.wardStaff += unit.wardStaff;
    out.money.orUpkeep += unit.orUpkeep;
    out.money.orStaff += unit.orStaff;
    for (const p of Object.values(s.patients)) {
      const op = p.stay?.op;
      if (op?.done && !operated.has(p.id)) {
        operated.add(p.id);
        out.money.opConsumables += db.treatments[op.tx].cost;
      }
      // случай стационара закрыт — его койко-дни и расходники, прибавка за операцию (как в closeStay)
      if (p.closed?.stay && p.stay && !closedStays.has(p.id)) {
        closedStays.add(p.id);
        const end = p.closed.stay.end;
        const chosen = p.stay.plan.setting === 'surgery' ? 'surgery' : 'admit';
        const over = settingFit(recommendedSetting(db, p.patient), chosen, alsoSettings(db, p.patient)) === 'over';
        const close: WardClose = over ? 'unindicated' : p.afterEarly ? 'repeat' : end === 'discharged' || end === 'died' ? 'full' : 'interrupted';
        out.money.closedBedDays += p.closed.stay.days * db.economy.ward.bedDay;
        if (op?.done) {
          const paid = wardIncome(db, p.closed.diagnosis, p.closed.grades.defensibility, close, op.tx);
          out.money.closedOpCost += db.treatments[op.tx].cost;
          out.money.opIncome += paid - wardIncome(db, p.closed.diagnosis, p.closed.grades.defensibility, close);
          out.money.opCases += paid;
          out.money.opCasesBedDays += p.closed.stay.days * db.economy.ward.bedDay;
        }
      }
      if (p.kind === 'return' && Math.floor(p.arriveT / DAY) + 1 === s.day && (p.returnReason === 'worse' || p.returnReason === 'reaction')) {
        out.harmed++;
        if (p.afterEarly) out.ward.returnsWorse++;
      }
      if (!p.closed || Math.floor(p.closed.at / DAY) + 1 !== s.day || p.by !== undefined) continue;
      const dept = db.conditions[p.patient.truth.conditions[0].id]?.department ?? '—';
      const x = (out.departments[dept] ??= { seen: 0, correct: 0 });
      x.seen++;
      if (p.closed.verdict === 'correct') x.correct++;
    }
  }
  out.harmed += out.ward.died;
  out.cash = s.economy!.cash;
  out.reputation = s.economy!.reputation ?? 0;
  for (const m of db.chapters[CHAPTER].missions.filter(x => x.main)) {
    const at = s.campaign?.done[m.id];
    out.missions[m.id] = at === undefined ? undefined : at - s.campaign!.since;
  }
  return out;
}

/**
 * Глава 1: лаборатория — на её месте в амбулатории посёлка (как в `campaign.test.ts`), с
 * анализатором; лаборант — как только он есть среди кандидатов. Строят и нанимают между сменами.
 */
function openLab(s: ShiftState) {
  if (!s.hospital!.rooms.some(r => r.type === 'room.lab')) {
    const rec = db.presets[db.chapters[s.campaign!.chapter].preset].rooms[0];
    const [dx, dy] = [s.hospital!.rooms[0].x - rec.x, s.hospital!.rooms[0].y - rec.y];
    apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.lab', size: 'S', x: 22 + dx, y: dy, rot: 0 } });
    const lab = s.hospital!.rooms.find(r => r.type === 'room.lab');
    if (!lab) throw new Error('карьера: лаборатория не встала на своё место');
    apply(db, s, { kind: 'build', cmd: { kind: 'buy', room: lab.id, equipment: 'eq.hematology_analyzer' } });
    apply(db, s, { kind: 'buildEnd' });
  }
  const lab = s.hospital!.rooms.find(r => r.type === 'room.lab')!;
  if ((s.staff ?? []).some(m => m.room === lab.id)) return;
  const tech = s.candidates?.find(c => c.role === 'role.lab_tech');
  if (tech) {
    apply(db, s, { kind: 'hire', id: tech.id });
    apply(db, s, { kind: 'assign', id: tech.id, room: lab.id });
  }
}

interface Career { chapter1?: number; chapter2?: number; minCash: number; days: number }

/** Карьера разумного с начала: в какой день каждой главы выполнены её основные задания. */
function career(seed: number): Career {
  const s = newCampaign(db, { seed, season, career: 1 });
  const out: Career = { minCash: s.economy!.cash, days: 0 };
  for (let d = 0; d < CAREER_DAYS; d++) {
    const c = s.campaign!;
    if (c.complete !== undefined) {
      const days = c.complete - c.since;
      if (c.chapter === 'chapter.district') out.chapter1 = days;
      else out.chapter2 = days;
      if (!nextChapterOf(db, c)) break;
      apply(db, s, { kind: 'nextChapter' });
      if (s.campaign!.chapter === c.chapter) throw new Error('карьера: в главу 2 не перейти');
    }
    if (s.campaign!.chapter === 'chapter.district') openLab(s);
    apply(db, s, { kind: 'nextDay' });
    if (!s.dayOpen) throw new Error('карьера: смену не открыть');
    playDay(s, 'rational');
    out.minCash = Math.min(out.minCash, s.economy!.cash);
    out.days = s.day;
  }
  return out;
}

const rub = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;
const pct = (a: number, b: number) => (100 * a) / Math.max(1, b);
const sum = (rs: Run[], f: (r: Run) => number) => rs.reduce((a, r) => a + f(r), 0);
const mean = (rs: Run[], f: (r: Run) => number) => sum(rs, f) / Math.max(1, rs.length);

const t0 = performance.now();
const runs = (pl: Player) => Array.from({ length: RUNS }, (_, i) => run(3500 + i, pl));
const results: Record<Player, Run[]> = { rational: runs('rational'), lazy: runs('lazy') };
const careers = Array.from({ length: RUNS }, (_, i) => career(3500 + i));
const seconds = Math.round((performance.now() - t0) / 1000);

/** траты палат и операционной: у закрытых случаев — их койко-дни и расходники; `all` — все, и тех, кто ещё лежит */
const costsOf = (r: Run, all = false) => (all ? r.money.bedDays + r.money.opConsumables : r.money.closedBedDays + r.money.closedOpCost)
  + r.money.wardUpkeep + r.money.wardStaff + r.money.orUpkeep + r.money.orStaff;
/** операционная со своими случаями: их койко-дни, расходники, содержание операционной и бригада */
const orCostsOf = (r: Run) => r.money.opCasesBedDays + r.money.closedOpCost + r.money.orUpkeep + r.money.orStaff;
function summarize(rs: Run[]) {
  return {
    profit: Math.round(mean(rs, r => r.profit)), profitMin: Math.min(...rs.map(r => r.profit)), profitMax: Math.max(...rs.map(r => r.profit)),
    minCash: Math.min(...rs.map(r => r.minCash)), reputation: Math.round(mean(rs, r => r.reputation)),
    unitIncome: Math.round(mean(rs, r => r.money.income)), unitCosts: Math.round(mean(rs, r => costsOf(r))), unitCostsAll: Math.round(mean(rs, r => costsOf(r, true))),
    opSurcharge: Math.round(mean(rs, r => r.money.opIncome)),
    orIncome: Math.round(mean(rs, r => r.money.opCases)), orCosts: Math.round(mean(rs, orCostsOf)),
    opsOnTime: pct(sum(rs, r => r.ops.onTime), sum(rs, r => r.ops.onTime + r.ops.late)),
    waited: pct(sum(rs, r => r.ops.waited), sum(rs, r => r.ops.done)),
    complicated: pct(sum(rs, r => r.ops.complicated), sum(rs, r => r.ops.done)),
    stayRatio: sum(rs, r => r.ward.stayDays) / Math.max(1, sum(rs, r => r.ward.stayNorm)),
    early: pct(sum(rs, r => r.ward.early), sum(rs, r => r.ward.discharged)),
    triageErrors: pct(sum(rs, r => r.ambulance.under + r.ambulance.over), sum(rs, r => r.ambulance.sorted)),
    returnsWorse: sum(rs, r => r.ward.returnsWorse) / Math.max(1, rs.length),
    died: sum(rs, r => r.ward.died) / Math.max(1, rs.length),
    harmed: pct(sum(rs, r => r.harmed), sum(rs, r => r.seen)),
    targetsOnTime: pct(sum(rs, r => r.targets.onTime), sum(rs, r => r.targets.total)),
    targetsTotal: sum(rs, r => r.targets.total),
  };
}
const summary: Record<Player, ReturnType<typeof summarize>> = { rational: summarize(results.rational), lazy: summarize(results.lazy) };
const [ra, la] = [summary.rational, summary.lazy];
const criteria = {
  // критерий 4: касса и окупаемость стационара с операционной
  cashNeverNegative: { ok: ra.minCash >= 0, text: `у разумного касса ни разу не в минусе: не ниже ${rub(ra.minCash)}` },
  unitsPay: { ok: ra.unitIncome >= ra.unitCosts, text: `стационар и операционная окупают койко-дни, расходники, помещения и людей: ${rub(ra.unitIncome)} против ${rub(ra.unitCosts)}` },
  orPays: { ok: ra.orIncome >= ra.orCosts, text: `случаи с операцией окупают операционную и бригаду: ${rub(ra.orIncome)} против ${rub(ra.orCosts)}` },
  // критерий 3: пороги стационара и операций у разумного
  opsOnTime: { ok: ra.opsOnTime >= 90, text: `операции в срок — не меньше 90 %: ${ra.opsOnTime.toFixed(1)} %` },
  waitedRare: { ok: ra.waited <= 5, text: `осложнились, пока ждали операции, — не больше 5 %: ${ra.waited.toFixed(1)} %` },
  stayWithinNorm: { ok: ra.stayRatio <= 1, text: `средний срок стационара — не выше обычного: ${(100 * ra.stayRatio).toFixed(0)} % обычного` },
  triageClean: { ok: ra.triageErrors <= 5, text: `ошибок сортировки скорой — не больше 5 %: ${ra.triageErrors.toFixed(1)} %` },
  // часть 37: ЭКГ при боли в груди в первые 10 минут
  targetsOnTime: { ok: ra.targetsTotal > 0 && ra.targetsOnTime >= 90, text: `сроки выполнены — не меньше 90 %: ${ra.targetsOnTime.toFixed(1)} % из ${ra.targetsTotal} (у ленивого ${la.targetsOnTime.toFixed(1)} %)` },
  // ленивый — с осложнениями и ранними выписками
  lazyEarly: { ok: la.early >= 50 && la.returnsWorse > ra.returnsWorse, text: `у ленивого ранние выписки — ${la.early.toFixed(0)} % выписанных, вернулись после них хуже — ${la.returnsWorse.toFixed(1)} за ${DAYS} дней (у разумного ${ra.returnsWorse.toFixed(1)})` },
  lazyComplications: { ok: la.harmed >= 2 * ra.harmed, text: `у ленивого хуже стало хотя бы вдвое чаще, чем у разумного: ${la.harmed.toFixed(1)} против ${ra.harmed.toFixed(1)} на 100 принятых` },
  lazyEarnsLess: { ok: la.profit < ra.profit, text: `ленивый зарабатывает меньше: ${rub(la.profit)} против ${rub(ra.profit)}` },
  // этап 4: обе главы проходятся от начала до конца
  careerComplete: {
    ok: careers.every(c => c.chapter1 !== undefined && c.chapter2 !== undefined),
    text: `карьера разумного: обе главы выполнены за ${CAREER_DAYS} дней на каждом зерне — глава 1 за ${careers.map(c => c.chapter1 ?? '—').join('/')} дн., глава 2 за ${careers.map(c => c.chapter2 ?? '—').join('/')} дн.`,
  },
  careerSolvent: { ok: careers.every(c => c.minCash >= 0), text: `в карьере касса ни разу не в минусе: не ниже ${rub(Math.min(...careers.map(c => c.minCash)))}` },
};
const passed = Object.values(criteria).every(c => c.ok);

if (asJson) {
  console.log(JSON.stringify({ days: DAYS, runs: RUNS, season, contentVersion: db.contentVersion, summary, careers, criteria: Object.fromEntries(Object.entries(criteria).map(([k, c]) => [k, c.ok])) }, null, 2));
  process.exit(passed ? 0 : 1);
}

const ch = db.chapters[CHAPTER];
console.log(`Районная больница главы «${ch.name.ru}»: ${DAYS} дней × ${RUNS} зёрен, сезон ${season}, база ${db.contentVersion}, ${seconds} с`);
console.log(`В кассе на старте: ${rub(ch.budget)}`);
const names: Record<Player, string> = { rational: 'Разумный', lazy: 'Ленивый' };
for (const pl of PLAYERS) {
  const rs = results[pl];
  const n = rs.length * DAYS;
  const x = summary[pl];
  const f = (g: (r: Run) => number) => sum(rs, g);
  console.log(`\n${names[pl]}`);
  console.log(`  в день: пришли ${(f(r => r.arrived) / n).toFixed(1)}, приняты ${pct(f(r => r.seen), f(r => r.arrived)).toFixed(1)} %, ушли ${pct(f(r => r.left), f(r => r.arrived)).toFixed(1)} %, не приняты ${pct(f(r => r.unseen), f(r => r.arrived)).toFixed(1)} %; верно ${pct(f(r => r.correct), f(r => r.seen)).toFixed(1)} %`);
  const depts = [...new Set(rs.flatMap(r => Object.keys(r.departments)))].sort();
  console.log(`  верно по отделениям: ${depts.map(d => `${d.replace('dept.', '')} ${pct(f(r => r.departments[d]?.correct ?? 0), f(r => r.departments[d]?.seen ?? 0)).toFixed(1)} % из ${f(r => r.departments[d]?.seen ?? 0)}`).join(', ')}`);
  console.log(`  скорая: ${(f(r => r.ambulance.arrived) / n).toFixed(1)} в день; ошибок сортировки ${x.triageErrors.toFixed(1)} % (недооценили ${f(r => r.ambulance.under)}, переоценили ${f(r => r.ambulance.over)} из ${f(r => r.ambulance.sorted)})`);
  console.log(`  сроки: в срок ${x.targetsOnTime.toFixed(1)} % из ${x.targetsTotal}`);
  console.log(`  стационар: положили ${f(r => r.ward.admitted)}, выписали ${f(r => r.ward.discharged)} (рано ${x.early.toFixed(1)} %, вернулись хуже ${f(r => r.ward.returnsWorse)}), перевели ${f(r => r.ward.transferred)}, умерли ${f(r => r.ward.died)}; срок ${(100 * x.stayRatio).toFixed(0)} % обычного`);
  console.log(`  операции: ${f(r => r.ops.done)}, в срок ${x.opsOnTime.toFixed(1)} %, осложнённых на столе ${x.complicated.toFixed(1)} % (из них — пока ждали ${x.waited.toFixed(1)} % всех операций), осложнений после ${pct(f(r => r.ops.complications), f(r => r.ops.done)).toFixed(1)} %`);
  const per = (g: (r: Run) => number) => rub(f(g) / rs.length);
  console.log(`  стационар и операционная за ${DAYS} дней: случаи ${rub(x.unitIncome)} против ${rub(x.unitCosts)} — койко-дни закрытых ${per(r => r.money.closedBedDays)}, расходники операций ${per(r => r.money.closedOpCost)}, палаты ${per(r => r.money.wardUpkeep)}, медсёстры палат ${per(r => r.money.wardStaff)}, операционная ${per(r => r.money.orUpkeep)}, бригада ${per(r => r.money.orStaff)}; со всеми койко-днями и расходниками, и тех, кто ещё лежит, — против ${rub(x.unitCostsAll)}`);
  console.log(`  из них случаи с операцией: ${rub(x.orIncome)} (прибавка за операции с их расходниками — ${rub(x.opSurcharge)}) против ${rub(x.orCosts)} — их койко-дни, расходники, операционная и бригада`);
  console.log(`  стало хуже (вернулись хуже или с реакцией, умерли): ${x.harmed.toFixed(1)} на 100 принятых`);
  console.log(`  прибыль за ${DAYS} дней: ${rub(x.profit)} (${rub(x.profitMin)} … ${rub(x.profitMax)}); касса не ниже ${rub(x.minCash)}; репутация ${x.reputation}`);
  const main = ch.missions.filter(m => m.main).map(m => m.id);
  console.log(`  основные задания, день главы: ${main.map(id => `${id} ${rs.map(r => r.missions[id] ?? '—').join('/')}`).join('; ')}`);
}
console.log(`\nКарьера разумного с начала: ${careers.map(c => `глава 1 — ${c.chapter1 ?? '—'} дн., глава 2 — ${c.chapter2 ?? '—'} дн., касса не ниже ${rub(c.minCash)}`).join('; ')}`);
console.log('\nКритерии (spec 2026-09-chapter-2, приёмка 3 и 4; этап 4 — 10-roadmap.md; сроки — spec 2026-10-chapter-3, часть 37):');
for (const c of Object.values(criteria)) console.log(`  ${c.ok ? 'да ' : 'НЕТ'} ${c.text}`);
process.exit(passed ? 0 : 1);
