// Состояния смены для снимков магазина (tools/store/render.ts). Их пишет движок — так же,
// как их записала бы игра, — и они каждый раз одинаковые: зерно подбирается по условию, а
// движок детерминирован (ADR 0004). Изменится база — подберётся другое зерно, а если
// условие не выполнится ни на одном, инструмент скажет об этом, а не снимет что попало.
import type { ContentDb, Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { choosePlan, runDoctor } from '../../src/engine/med/policy';
import { apply, candidatesOf, current, newSandbox, newShift, observationsOf } from '../../src/engine/shift/engine';
import { type Command, DAY, SHIFT_END, SHIFT_SCHEMA_VERSION, type ShiftState } from '../../src/engine/shift/types';

const MIN = 60;
const SEEDS = 3000;
// «Студент» — как у нового игрока: на снимках видны подсказки «Похоже на» (03-game-design.md §14)
const winter = { season: 'winter' as const, difficulty: 'student' as const };

/** Сохранение слота партии, как его пишет игра (src/state/saves.ts). */
export function envelope(s: ShiftState): string {
  return JSON.stringify({ schemaVersion: SHIFT_SCHEMA_VERSION, savedAt: 'store', data: s });
}

const truthOf = (s: ShiftState, id: string): Id => s.patients[id].patient.truth.conditions[0].id;
const clone = (s: ShiftState): ShiftState => JSON.parse(JSON.stringify(s));
const delayed = (db: ContentDb, id: Id) => {
  const e = db.exams[id];
  return e.kind === 'imaging' || e.kind === 'functional' || (e.time.turnaround ?? 0) + (e.time.report ?? 0) > 0;
};

function run(db: ContentDb, s: ShiftState, cmds: Command[]) {
  for (const c of cmds) apply(db, s, c);
}

/**
 * Принять пациента, как разумный врач из «виртуального врача»: его обследования, его
 * диагноз и лечение; анализы и снимки — отпустить ждать, если в очереди есть кто-то ещё.
 */
function playDay(db: ContentDb, s: ShiftState, seed: number) {
  const candidates = candidatesOf(db, s.meta.department);
  const exams = Object.keys(db.exams).sort();
  const plans = new Map<string, ReturnType<typeof runDoctor>>();
  for (let guard = 0; guard < 4000; guard++) {
    const idle = !s.current && s.queue.length === 0;
    const over = s.t % DAY >= SHIFT_END && idle && !Object.values(s.patients).some(p => p.status === 'away' || p.status === 'coming');
    if (over) break;
    if (!s.current && s.queue.length > 0) apply(db, s, { kind: 'call', id: s.queue[0] });
    const p = current(s);
    if (!p) {
      apply(db, s, { kind: 'advance', seconds: MIN });
      continue;
    }
    let plan = plans.get(p.id);
    if (!plan) {
      plan = runDoctor(db, p.patient, 'rational', Rng.seeded(seed).fork(`store:${p.id}`), { candidates, exams });
      plans.set(p.id, plan);
      const todo = plan.exams.filter(e => !p.done.includes(e));
      for (const e of todo.filter(x => !delayed(db, x))) apply(db, s, { kind: 'exam', exam: e });
      for (const e of todo.filter(x => delayed(db, x))) apply(db, s, { kind: 'exam', exam: e });
      if (p.pending.length > 0 && s.queue.length > 0) {
        apply(db, s, { kind: 'sendAway' });
        continue;
      }
    }
    while (p.pending.length > 0) apply(db, s, { kind: 'waitResults' });
    const chosen = choosePlan(db, plan.diagnosis, observationsOf(p));
    run(db, s, [{ kind: 'diagnose', id: plan.diagnosis }, ...chosen.treatments.map(id => ({ kind: 'toggleTreatment', id }) as Command), { kind: 'setting', setting: chosen.setting }, { kind: 'finish' }]);
  }
}

/**
 * Очередь в разгаре: принят первый, второй ушёл на анализ, в очереди трое и больше, среди
 * них — пневмония, и через минуту-две придёт «красный» (на снимке — автопауза).
 */
export function queueState(db: ContentDb): ShiftState {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const s = newShift(db, { seed, ...winter });
    apply(db, s, { kind: 'advance', seconds: 30 * MIN });
    if (s.queue.length < 2) continue;
    const first = s.queue[0];
    const truth = truthOf(s, first);
    run(db, s, [{ kind: 'call', id: first }, { kind: 'exam', exam: 'exam.ask_complaints' }, { kind: 'exam', exam: 'exam.ask_chronic' }, { kind: 'diagnose', id: truth }]);
    for (const tx of choosePlan(db, truth, observationsOf(current(s)!)).treatments) apply(db, s, { kind: 'toggleTreatment', id: tx });
    apply(db, s, { kind: 'finish' });
    if (s.queue.length === 0) continue;
    run(db, s, [{ kind: 'call', id: s.queue[0] }, { kind: 'exam', exam: 'exam.ask_complaints' }, { kind: 'exam', exam: 'exam.cbc' }, { kind: 'sendAway' }]);
    for (let m = 0; m < 150 && s.t % DAY < SHIFT_END; m++) {
      const mixed = new Set(s.queue.map(id => s.patients[id].triage)).size >= 2;
      if (s.queue.length >= 3 && mixed && s.queue.some(id => truthOf(s, id) === 'cond.pneumonia_cap') && Object.values(s.patients).some(p => p.status === 'away')) {
        const probe = clone(s);
        const notices = apply(db, probe, { kind: 'advance', seconds: 2 * MIN });
        if (notices.some(n => n.kind === 'arrived' && n.triage === 'red')) return s;
      }
      apply(db, s, { kind: 'advance', seconds: MIN });
    }
  }
  throw new Error('queueState: не нашлось смены с очередью, пневмонией и «красным» на подходе');
}

/**
 * В кабинете пациент с пневмонией лёгкой тяжести: расспрос, аускультация, об аллергии
 * спросили, снимок пришёл и показал инфильтрат — «Новое» сверху.
 */
export function pneumoniaCase(db: ContentDb): ShiftState {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const s = newShift(db, { seed, ...winter });
    apply(db, s, { kind: 'advance', seconds: 30 * MIN });
    const id = s.queue.find(x => truthOf(s, x) === 'cond.pneumonia_cap' && s.patients[x].patient.truth.conditions[0].params.severity === 'mild');
    if (!id || s.patients[id].patient.truth.risks.includes('risk.allergy_penicillin')) continue;
    run(db, s, [
      { kind: 'call', id },
      { kind: 'exam', exam: 'exam.ask_complaints' },
      { kind: 'exam', exam: 'exam.ask_allergies' },
      { kind: 'exam', exam: 'exam.lung_auscultation' },
      { kind: 'exam', exam: 'exam.xray_chest' },
    ]);
    const p = current(s)!;
    while (p.pending.length > 0) apply(db, s, { kind: 'waitResults' });
    const xray = p.results.find(r => r.exam === 'exam.xray_chest')!;
    const shown = xray.obs.some(o => o.f === 'img.cxr_infiltrate' && o.shown);
    const crackles = p.results.some(r => r.obs.some(o => o.f === 'sign.crackles_local' && o.shown));
    if (!shown || !crackles || p.patient.complaints.length < 2) continue;
    // приём, который на снимке закончится: диагноз, амоксициллин, режим, дома — и оценка
    // честная, без «бережливости D»: снимок здесь был нужен и разумному врачу
    const probe = clone(s);
    run(db, probe, [{ kind: 'diagnose', id: 'cond.pneumonia_cap' }, { kind: 'toggleTreatment', id: 'tx.amoxicillin' }, { kind: 'toggleTreatment', id: 'tx.rest_fluids' }, { kind: 'setting', setting: 'home' }, { kind: 'finish' }]);
    const grades = probe.patients[id].closed!.grades;
    if (grades.overall === 'A' && (grades.thrift === 'A' || grades.thrift === 'B') && grades.defensibility === 'A') return s;
  }
  throw new Error('pneumoniaCase: не нашлось пневмонии, у которой снимок показал инфильтрат');
}

/** В кабинете — давящая боль за грудиной, на ЭКГ подъём ST (инфаркт): пора звать скорую. */
export function acsCase(db: ContentDb): ShiftState {
  for (let seed = 1; seed <= SEEDS * 3; seed++) {
    const s = newShift(db, { seed, ...winter });
    const acs = Object.values(s.patients).find(p => p.patient.truth.conditions[0].id === 'cond.acs' && p.kind !== 'return');
    if (!acs) continue;
    apply(db, s, { kind: 'advance', seconds: acs.arriveT - s.t });
    if (s.patients[acs.id].status !== 'waiting') continue;
    run(db, s, [
      { kind: 'call', id: acs.id },
      { kind: 'exam', exam: 'exam.ask_complaints' },
      { kind: 'exam', exam: 'exam.ask_chest_pain' },
      { kind: 'exam', exam: 'exam.ecg' },
    ]);
    const p = current(s)!;
    while (p.pending.length > 0) apply(db, s, { kind: 'waitResults' });
    const ecg = p.results.find(r => r.exam === 'exam.ecg')!;
    if (ecg.obs.some(o => o.f === 'ecg.st_elevation' && o.shown) && p.patient.complaints.includes('sym.chest_pain_pressing')) return s;
  }
  throw new Error('acsCase: не нашлось инфаркта с подъёмом ST на ЭКГ');
}

/** Три дня практики разумного врача, третий закрыт: итоги с приёмами и вестями о прошлых. */
export function summaryState(db: ContentDb): ShiftState {
  for (let seed = 1; seed <= 200; seed++) {
    const s = newShift(db, { seed, ...winter });
    for (let d = 1; d <= 3; d++) {
      playDay(db, s, seed);
      apply(db, s, { kind: 'closeDay' });
      if (d < 3) apply(db, s, { kind: 'nextDay' });
    }
    const h = s.history[s.history.length - 1];
    const news = Object.values(s.patients).filter(p => p.closed && p.closed.plan.setting === 'home' && Math.floor(p.closed.at / DAY) + 1 + p.closed.outcome.day === h.day);
    if (h.seen >= 10 && h.correct >= h.seen - 3 && news.length >= 2) return s;
  }
  throw new Error('summaryState: не нашлось трёх дней с вестями о прошлых пациентах');
}

/** Своя больница до открытия: готовая амбулатория на участке песочницы, бюджет «обычный». */
export function sandboxState(db: ContentDb): ShiftState {
  return newSandbox(db, { seed: 1, ...winter, start: 'clinic', budget: db.economy.sandbox.budgets.normal });
}
