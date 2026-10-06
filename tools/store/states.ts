// Состояния смены для снимков магазина (tools/store/render.ts). Их пишет движок — так же,
// как их записала бы игра, — и они каждый раз одинаковые: зерно подбирается по условию, а
// движок детерминирован (ADR 0004). Изменится база — подберётся другое зерно, а если
// условие не выполнится ни на одном, инструмент скажет об этом, а не снимет что попало.
import type { ContentDb, Id } from '../../src/content/types';
import { choosePlan } from '../../src/engine/med/policy';
import { apply, current, freeBeds, inpatientsOf, newCampaign, newSandbox, newShift, observationsOf } from '../../src/engine/shift/engine';
import { type Command, DAY, SHIFT_END, SHIFT_SCHEMA_VERSION, type ShiftState } from '../../src/engine/shift/types';
import { daysIn, wardState } from '../../src/engine/shift/ward';

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

function run(db: ContentDb, s: ShiftState, cmds: Command[]) {
  for (const c of cmds) apply(db, s, c);
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
    // жалобы — только от инфаркта: попутная «болит горло» у него на снимке сбивала бы с толку
    const own = p.patient.complaints.every(c => db.conditions['cond.acs'].findings.some(l => l.f === c));
    if (ecg.obs.some(o => o.f === 'ecg.st_elevation' && o.shown) && p.patient.complaints.includes('sym.chest_pain_pressing') && own) return s;
  }
  throw new Error('acsCase: не нашлось инфаркта с подъёмом ST на ЭКГ');
}

/** Своя больница до открытия: готовая амбулатория на участке песочницы, бюджет «обычный». */
export function sandboxState(db: ContentDb): ShiftState {
  return newSandbox(db, { seed: 1, ...winter, start: 'clinic', budget: db.economy.sandbox.budgets.normal });
}

/** Привезённых — отсортировать, как их цвет по шкале с листа передачи. */
function sortAll(db: ContentDb, s: ShiftState) {
  for (const p of Object.values(s.patients)) if (p.kind === 'ambulance' && !p.sorted && p.status === 'waiting') apply(db, s, { kind: 'sort', id: p.id, triage: p.scale!.triage });
}

/**
 * Принять первого из очереди быстро в больнице с палатами и операционной: жалобы, диагноз —
 * настоящий, лечение и место — по плану, со своей койкой и операционной; операционная не берёт —
 * скорая.
 */
function seeHere(db: ContentDb, s: ShiftState) {
  const id = s.queue[0];
  const truth = truthOf(s, id);
  run(db, s, [{ kind: 'call', id }, { kind: 'exam', exam: 'exam.ask_complaints' }, { kind: 'diagnose', id: truth }]);
  const p = current(s)!;
  const chosen = choosePlan(db, truth, observationsOf(p), p.patient.age, { ward: freeBeds(db, s).length > 0, or: true });
  run(db, s, [...chosen.treatments.map(tx => ({ kind: 'toggleTreatment', id: tx }) as Command), { kind: 'setting', setting: chosen.setting }, { kind: 'finish' }]);
  if (current(s)?.id === id) run(db, s, [{ kind: 'setting', setting: 'ambulance' }, { kind: 'finish' }]);
}

/** Утренний обход: выписать, кому можно; хуже — перевести. */
function rounds(db: ContentDb, s: ShiftState) {
  for (const p of inpatientsOf(s)) {
    if (p.stay!.op && !p.stay!.op.done) continue;
    const state = wardState(p.stay!, daysIn(p.stay!, s.day));
    if (state === 'ready') apply(db, s, { kind: 'discharge', id: p.id });
    else if (state === 'worse' || state === 'reaction') apply(db, s, { kind: 'transfer', id: p.id });
  }
}

/**
 * Районная больница главы 2 «Приёмное» (spec 2026-09-chapter-2, часть 35) на третий день главы —
 * подсказки первой смены позади. Два дня врач принимает всех (`seeHere`), утром — обход. На
 * третий — в разгаре: несколько приняты, в палатах лежат, в очереди трое и больше разной
 * срочности, врач свободен — и через минуту-две скорая привезёт больного (на снимке —
 * автопауза и внизу «сортировать»).
 */
export function districtState(db: ContentDb): ShiftState {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const s = newCampaign(db, { seed, ...winter, career: 1, chapter: 'chapter.hospital' });
    for (let d = 1; d <= 2; d++) {
      apply(db, s, { kind: 'nextDay' });
      rounds(db, s);
      for (let guard = 0; guard < 2000; guard++) {
        sortAll(db, s);
        const waiting = Object.values(s.patients).some(p => p.status === 'away' || p.status === 'coming' || (p.kind === 'ambulance' && p.status === 'waiting' && !p.sorted));
        if (s.t % DAY >= SHIFT_END && s.queue.length === 0 && !current(s) && !waiting) break;
        if (!current(s) && s.queue.length > 0) seeHere(db, s);
        else apply(db, s, { kind: 'advance', seconds: MIN });
      }
      apply(db, s, { kind: 'closeDay' });
    }
    apply(db, s, { kind: 'nextDay' });
    rounds(db, s);
    let seen = 0;
    for (let m = 0; m < 5 * 60 && s.t % DAY < SHIFT_END; m++) {
      sortAll(db, s);
      const mixed = new Set(s.queue.map(id => s.patients[id].triage)).size >= 2;
      if (!current(s) && seen >= 3 && s.queue.length >= 3 && mixed && inpatientsOf(s).length >= 4) {
        const probe = clone(s);
        const notices = apply(db, probe, { kind: 'advance', seconds: 2 * MIN });
        if (notices.some(n => n.kind === 'ambulance')) return s;
      }
      if (!current(s) && s.queue.length >= 4) {
        seeHere(db, s);
        seen++;
      }
      apply(db, s, { kind: 'advance', seconds: MIN });
    }
  }
  throw new Error('districtState: не нашлось дня, когда скорая везёт больного к очереди, а в палатах лежат');
}

/**
 * Первая смена сосудистого отделения (spec 2026-10-chapter-3, часть 45б): глава 3 с начала, кабинет КТ работает, скорая
 * привезла инсульт в окне — в смотровой под монитором, вызван; осмотр, глюкоза, КТ и вопрос, когда началось,
 * сделаны, КТ описана — крови внутри черепа нет. Письма прочитаны, подсказки заведующей показаны: их листа на снимке
 * нет. Инфаркт и паралич лица первой смены ждут в очереди — на снимке их не видно.
 */
export function strokeCtCase(db: ContentDb): ShiftState {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const s = newCampaign(db, { seed, ...winter, career: 1, chapter: 'chapter.vascular' });
    s.campaign!.letters = s.campaign!.letters.map(l => ({ ...l, read: true }));
    s.campaign!.tips = { shown: Object.values(db.tips).map(t => t.id) };
    apply(db, s, { kind: 'nextDay' });
    const stroke = Object.values(s.patients).find(p => p.kind === 'ambulance' && truthOf(s, p.id) === 'cond.stroke_ischemic');
    if (!stroke) continue;
    for (let m = 0; m < 8 * 60 && stroke.status === 'coming'; m++) apply(db, s, { kind: 'advance', seconds: MIN });
    if (stroke.status !== 'waiting' || current(s)) continue;
    run(db, s, [
      { kind: 'sort', id: stroke.id, triage: 'red' },
      { kind: 'call', id: stroke.id },
      { kind: 'exam', exam: 'exam.neuro_exam' },
      { kind: 'exam', exam: 'exam.glucometer' },
      { kind: 'exam', exam: 'exam.ct_head' },
      { kind: 'exam', exam: 'exam.ask_stroke' },
    ]);
    const p = current(s);
    if (p?.id !== stroke.id) continue;
    while (p.pending.length > 0) apply(db, s, { kind: 'waitResults' });
    const ct = p.results.find(r => r.exam === 'exam.ct_head');
    // КТ без крови и без ранних признаков — тромболизис можно; жалобы — только от инсульта
    const own = p.patient.complaints.every(c => db.conditions['cond.stroke_ischemic'].findings.some(l => l.f === c));
    if (ct && !ct.obs.some(o => o.shown) && own) return s;
  }
  throw new Error('strokeCtCase: не нашлось инсульта первой смены отделения, у которого КТ без находок');
}
