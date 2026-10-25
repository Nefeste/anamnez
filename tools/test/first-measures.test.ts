// Первые меры у скорой (часть 95, вопрос 58, spec 2026-10-first-measures): кислород, инфузия, глюкоза, давящая повязка в
// смотровой приёмного. Тяжёлому без нужной меры каждые 20–40 минут хуже на ступень, после четвёртой — остановка и смерть, в
// «мягком режиме» — перевод; мера держит. Монитор — лист передачи со сдвигами; правило разумного врача — по известному.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { carriedWeight } from '../../src/engine/med/generate';
import { scoreBase } from '../../src/engine/med/score';
import { apply, newCampaign } from '../../src/engine/shift/engine';
import { arrestStep, bayVitals, measureOf, measuresDue, needsOf, severeFor, stepSeconds, valueKey } from '../../src/engine/shift/measures';
import { type Notice, SHIFT_SCHEMA_VERSION, type ShiftPatient, type ShiftState } from '../../src/engine/shift/types';
import { T } from '../../src/i18n';
import { noteText } from '../../src/state/caseView';
import { memoryStore, saveSlot } from '../../src/state/saves';
import {
  alarmIn, callPatient, closeDay, forgetShift, giveMeasure, loadShift, setSpeed, setStore, shiftCaseView, shiftState, shiftView, sortAmbulance, tick,
} from '../../src/state/session';

const MIN = 60;

/**
 * Первый день с привезённым, которому нужна мера `measure`: глава 2, зёрна по порядку; больного кладут в смотровую —
 * смена стоит на этой минуте. Возвращает смену, его и события, случившиеся до того.
 */
function severeArrival(measure: string, soft = false): { s: ShiftState; p: ShiftPatient } {
  for (let seed = 1; seed < 200; seed++) {
    const s = newCampaign(db, { seed, season: 'winter', career: 1, chapter: 'chapter.hospital' });
    if (soft) apply(db, s, { kind: 'soft', on: true });
    for (let d = 1; d <= 3; d++) {
      apply(db, s, { kind: 'nextDay' });
      for (let i = 0; i < 7 * 60; i++) {
        apply(db, s, { kind: 'advance', seconds: MIN });
        const p = Object.values(s.patients).find(q => q.id.startsWith(`${s.day}-`) && q.bayT !== undefined && needsOf(db, q).some(m => m.id === measure));
        if (p) return { s, p };
      }
      apply(db, s, { kind: 'closeDay' });
    }
  }
  throw new Error(`нет привезённого с нуждой ${measure}`);
}

/** Прожить минуты, собирая события этого больного. */
function live(s: ShiftState, minutes: number, id: string): Notice[] {
  const out: Notice[] = [];
  for (let i = 0; i < minutes; i++) out.push(...apply(db, s, { kind: 'advance', seconds: MIN }).filter(n => 'id' in n && n.id === id));
  return out;
}

describe('первые меры: база', () => {
  test('четыре меры по порядку кнопок, у каждой — своё назначение из базы; давящая повязка — новое назначение', () => {
    expect(Object.values(db.measures).map(m => [m.id, m.tx, m.abc])).toEqual([
      ['measure.oxygen', 'tx.oxygen_mask', 'B'], ['measure.fluids', 'tx.iv_fluids', 'C'], ['measure.glucose', 'tx.dextrose_iv', 'D'], ['measure.bleeding', 'tx.pressure_dressing', 'C'],
    ]);
    for (const m of Object.values(db.measures)) {
      expect(db.treatments[m.tx]).toBeDefined();
      expect(arrestStep(m)).toBe(4);
      expect(m.every).toEqual([20, 40]);
    }
    expect(measureOf(db, 'tx.pressure_dressing')?.id).toBe('measure.bleeding');
  });

  test('большую рану головы с кровопотерей скорая везёт — вес неотложной на долю больших; маленькую — нет', () => {
    const c = db.conditions['cond.head_wound'];
    expect(c.carried).toEqual({ when: { extent: ['large'] }, severity: 'critical' });
    const w = carriedWeight(c, db.economy.ambulance.weight);
    expect(w).toBeCloseTo(db.economy.ambulance.weight.critical * 0.1, 5);
    expect(carriedWeight({ ...c, carried: undefined }, db.economy.ambulance.weight)).toBe(0);
  });
});

describe('первые меры: ухудшение по часам', () => {
  test('без меры — три ступени, на четвёртой код синий, через 10 минут смерть; приём закрыт смертью', () => {
    const { s, p } = severeArrival('measure.oxygen');
    const m = db.measures['measure.oxygen'];
    const step = stepSeconds(s, p, m);
    expect(step).toBeGreaterThanOrEqual(20 * MIN);
    expect(step).toBeLessThanOrEqual(40 * MIN);
    const spo2 = bayVitals(db, s, p).values[valueKey(db, 'vital.spo2_low')];
    const notices = live(s, Math.ceil((4 * step) / MIN) + 11, p.id);
    expect(notices.filter(n => n.kind === 'worse').map(n => (n.kind === 'worse' ? n.step : 0))).toEqual([1, 2, 3]);
    expect(notices.some(n => n.kind === 'code')).toBe(true);
    expect(notices.some(n => n.kind === 'died' && !n.soft)).toBe(true);
    expect(p.closed?.ed).toBe(true);
    expect(p.closed?.outcome.kind).toBe('died');
    expect(p.closed?.grades.safety).toBe('D');
    expect(p.closed?.measures?.find(x => x.measure === m.id)).toMatchObject({ steps: 4 });
    expect(s.summary.ambulance?.measures?.died).toBe(1);
    // монитор за минуту до остановки: сатурация ниже на 9, спутанность
    const before = bayVitals(db, s, p, p.bayT! + 4 * step - MIN);
    expect(before.values[valueKey(db, 'vital.spo2_low')]).toBe(spo2 - 9);
    expect(before.added).toContain('sym.confusion');
  }, 120_000);

  test('«мягкий режим»: вместо смерти — перевод в тяжёлом состоянии, без кода синего', () => {
    const { s, p } = severeArrival('measure.oxygen', true);
    const step = stepSeconds(s, p, db.measures['measure.oxygen']);
    const notices = live(s, Math.ceil((4 * step) / MIN) + 2, p.id);
    expect(notices.some(n => n.kind === 'code')).toBe(false);
    expect(notices.some(n => n.kind === 'died' && n.soft)).toBe(true);
    expect(p.closed?.outcome).toMatchObject({ kind: 'transferred', severe: true });
  }, 120_000);

  test('мера сразу — хуже не становится; монитор: сатурация к цели; в листе назначений — отмечена, снять нельзя', () => {
    const { s, p } = severeArrival('measure.oxygen');
    apply(db, s, { kind: 'measure', id: p.id, tx: 'tx.oxygen_mask' });
    expect(p.measures).toEqual([{ tx: 'tx.oxygen_mask', at: s.t, done: s.t + 2 * MIN }]);
    expect(p.draft.treatments).toContain('tx.oxygen_mask');
    const notices = live(s, 3 * 60, p.id);
    expect(notices.filter(n => n.kind === 'worse' || n.kind === 'code' || n.kind === 'died')).toEqual([]);
    const target = p.patient.truth.conditions[0].id === 'cond.copd_exacerbation' ? 90 : 94;
    expect(bayVitals(db, s, p).values[valueKey(db, 'vital.spo2_low')]).toBeGreaterThanOrEqual(target);
    // назначить второй раз — ничего; снять из листа назначений — нельзя
    apply(db, s, { kind: 'measure', id: p.id, tx: 'tx.oxygen_mask' });
    expect(p.measures?.length).toBe(1);
    s.current = p.id;
    apply(db, s, { kind: 'toggleTreatment', id: 'tx.oxygen_mask' });
    expect(p.draft.treatments).toContain('tx.oxygen_mask');
  }, 120_000);

  test('инфузия держит: ступени без неё сдвигают давление и пульс, после неё монитор — как при поступлении', () => {
    const { s, p } = severeArrival('measure.fluids');
    const m = db.measures['measure.fluids'];
    const step = stepSeconds(s, p, m);
    const base = bayVitals(db, s, p).values;
    live(s, Math.ceil((2 * step) / MIN) + 1, p.id);
    const worse = bayVitals(db, s, p).values;
    expect(worse[valueKey(db, 'vital.bp_low')]).toBe(base[valueKey(db, 'vital.bp_low')] - 12);
    apply(db, s, { kind: 'measure', id: p.id, tx: m.tx });
    live(s, m.minutes + 1, p.id);
    expect(bayVitals(db, s, p).values[valueKey(db, 'vital.bp_low')]).toBe(base[valueKey(db, 'vital.bp_low')]);
    expect(live(s, 3 * 60, p.id).filter(n => n.kind === 'code' || n.kind === 'died')).toEqual([]);
  }, 120_000);
});

describe('первые меры: кто тяжёлый и правило разумного врача', () => {
  test('по сатурации и давлению — только то, что фельдшер намерил: ошибка листа передачи часов не запускает', () => {
    const { p } = severeArrival('measure.oxygen');
    const m = db.measures['measure.oxygen'];
    const sheet = p.results.find(r => r.exam === 'exam.vitals')!.obs;
    expect(severeFor(db, m, p.patient, sheet)).toBe(true);
    expect(severeFor(db, m, p.patient, sheet.filter(o => o.f !== 'vital.spo2_low'))).toBe(false);
    // гипогликемию ищут глюкометром: она — по правде
    expect(db.measures['measure.glucose'].severe.seen).toBeUndefined();
  }, 120_000);

  test('по известному: сатурация 91 % — кислород; давление ниже 90 — инфузия, но не при боли в груди и не при застое; одышка с Куссмаулем — сразу', () => {
    const o = (f: string, value?: number) => ({ f, shown: true, ...(value !== undefined ? { value } : {}), exam: 'exam.vitals' });
    expect(measuresDue(db, [], [o('vital.spo2_low', 91)])).toEqual(['tx.oxygen_mask']);
    expect(measuresDue(db, [], [o('vital.spo2_low', 92)])).toEqual([]);
    expect(measuresDue(db, ['sym.vomiting'], [o('vital.bp_low', 82)])).toEqual(['tx.iv_fluids']);
    expect(measuresDue(db, ['sym.chest_pain_pressing'], [o('vital.bp_low', 82)])).toEqual([]);
    expect(measuresDue(db, ['sym.dyspnea'], [o('vital.bp_low', 82)])).toEqual([]);
    expect(measuresDue(db, ['sym.dyspnea'], [o('vital.bp_low', 82), { f: 'sign.crackles_bilateral', shown: false, exam: 'exam.physical' }])).toEqual(['tx.iv_fluids']);
    expect(measuresDue(db, ['sym.dyspnea'], [o('vital.bp_low', 82), o('sign.crackles_bilateral')])).toEqual([]);
    expect(measuresDue(db, ['sym.dyspnea'], [o('vital.bp_low', 82), o('sign.kussmaul')])).toEqual(['tx.iv_fluids']);
    expect(measuresDue(db, [], [o('lab.glucose_low', 2.1), o('sign.wound_large')])).toEqual(['tx.dextrose_iv', 'tx.pressure_dressing']);
  });

  test('оценка: дана до первой ступени — вовремя; после — безопасность B, с третьей — C; умер в смотровой — D', () => {
    const plan = { roles: [], effective: true, violations: [], setting: { chosen: 'admit', recommended: 'admit', also: [] }, preHospital: [], preventMissing: [], requireMissing: [],
      requireWhen: {}, beforeTransferMissing: [], beforeTransferWhen: {}, companionsMissing: [], unaskedRisk: [], examHarms: [], firstLineBlocked: false, noFirstLine: false } as never;
    const base = { verdict: 'correct' as const, confidence: 0.9, cost: 0, plan, outcome: { kind: 'recovered', day: 3, cured: true } as never, selfLimiting: false, redFlags: [] };
    const on = scoreBase({ ...base, measures: [{ tx: 'tx.oxygen_mask', steps: 0, given: 4 }] });
    expect(on.safety).toBe('A');
    expect(on.notes).toContainEqual({ code: 'measure.onTime', tx: 'tx.oxygen_mask', minutes: 4 });
    // в разборе — и почему мера была нужна, словами её записи
    expect(noteText({ code: 'measure.onTime', tx: 'tx.oxygen_mask', minutes: 4 })).toContain(db.measures['measure.oxygen'].texts.why.ru);
    expect(scoreBase({ ...base, measures: [{ tx: 'tx.oxygen_mask', steps: 1, given: 31 }] }).safety).toBe('B');
    expect(scoreBase({ ...base, measures: [{ tx: 'tx.oxygen_mask', steps: 3, given: 95 }] }).safety).toBe('C');
    expect(scoreBase({ ...base, measures: [{ tx: 'tx.iv_fluids', steps: 2 }] }).notes).toContainEqual({ code: 'measure.missed', tx: 'tx.iv_fluids', steps: 2 });
    expect(scoreBase({ ...base, measures: [{ tx: 'tx.iv_fluids', steps: 4 }], ed: true }).safety).toBe('D');
  });

  test('больной из сохранения до 0.6.18 — без минуты, как положили в смотровую: часов у него нет', () => {
    const { p } = severeArrival('measure.oxygen');
    const old = { ...p, bayT: undefined };
    expect(needsOf(db, old)).toEqual([]);
  }, 120_000);
});

/** Смену — в сессию, как после «Продолжить»: карьера 1. */
async function load(s: ShiftState) {
  const store = memoryStore();
  setStore(store);
  forgetShift();
  await saveSlot(store, 'campaign-1', s, SHIFT_SCHEMA_VERSION, 'x');
  await loadShift('campaign', 1);
}

/** Часы на карте — минуты, или пока не случится `stop`; автопаузу снимаем, события собираем. */
function clock(minutes: number, stop: (n: Notice) => boolean = () => false): Notice[] {
  const out: Notice[] = [];
  const end = shiftState()!.t + minutes * MIN;
  for (let i = 0; i < 10 * minutes && shiftState()!.t < end && !out.some(stop); i++) {
    setSpeed(1);
    out.push(...tick(1000));
  }
  return out;
}

describe('первые меры на экране', () => {
  test('лист передачи: монитор, кнопки мер, на «Студенте» — что сделать сразу; мера — медсестра, потом «дано в»; в смотровой и в карте отмечена', async () => {
    const { s, p } = severeArrival('measure.oxygen');
    s.meta.difficulty = 'student';
    const spo2 = Math.round(bayVitals(db, s, p).values[valueKey(db, 'vital.spo2_low')]);
    await load(s);
    const t = T.shift.ambulance;
    const row = () => [...shiftView().ambulance, ...shiftView().bays].find(r => r.id === p.id)!;
    const first = row().handover.measures!;
    expect(first.lines[0]).toEqual({ text: t.spo2(spo2) });
    expect(first.buttons.map(b => [b.tx, b.state])).toEqual(Object.values(db.measures).map(m => [m.tx, 'give']));
    expect(first.hints).toContain(t.hint.oxygen(spo2));
    giveMeasure(p.id, 'tx.oxygen_mask');
    expect(row().handover.measures!.buttons[0]).toMatchObject({ state: 'doing', note: t.doing(2) });
    expect(row().handover.measures!.hints ?? []).not.toContain(t.hint.oxygen(spo2));
    clock(3);
    expect(row().handover.measures!.buttons[0].state).toBe('done');
    // отсортировали — «В смотровой», монитор по касанию; сортировать второй раз нечего
    sortAmbulance(p.id, 'red');
    expect(shiftView().ambulance.some(r => r.id === p.id)).toBe(false);
    expect(row()).toMatchObject({ sorted: true });
    expect(row().line.endsWith(t.bayOpen)).toBe(true);
    // в карте — монитор и меры; в листе назначений кислород отмечен, с временем, снять нельзя
    expect(callPatient(p.id)).toBe(true);
    const v = shiftCaseView()!;
    expect(v.measures?.buttons[0].state).toBe('done');
    const oxygen = v.treatments.find(x => x.id === 'tx.oxygen_mask')!;
    expect(oxygen.locked).toBe(true);
    expect(oxygen.warning?.startsWith(t.given('').trimEnd())).toBe(true);
    expect(v.draft.treatments).toContain('tx.oxygen_mask');
    forgetShift();
  }, 120_000);

  test('без меры — «хуже» вслух: тревога монитора, автопауза, лампа в «В смотровой»; итоги дня — первые меры', async () => {
    const { s, p } = severeArrival('measure.oxygen');
    await load(s);
    sortAmbulance(p.id, 'red');
    const step = stepSeconds(s, p, db.measures['measure.oxygen']);
    const notices = clock(Math.ceil(step / MIN) + 1, n => n.kind === 'worse' && n.id === p.id).filter(n => 'id' in n && n.id === p.id);
    expect(notices.some(n => n.kind === 'worse')).toBe(true);
    expect(alarmIn(notices)).toBe(true);
    const view = shiftView();
    expect(view.paused).toBe(true);
    expect(view.pauseReason?.startsWith(T.shift.pause.worse('', '').split('—')[0])).toBe(true);
    const bay = view.bays.find(r => r.id === p.id)!;
    expect(bay.worse).toBe(true);
    expect(bay.handover.measures!.lines.some(l => l.worse)).toBe(true);
    // вечер: мера была нужна одному, вовремя — никому, хуже — ему, умер в смотровой
    clock(4 * 60);
    closeDay();
    const lines = shiftView().summary?.ambulanceLines ?? [];
    expect(lines).toContain(T.shift.summary.ambulance.measures(0, 1));
    expect(lines).toContain(T.shift.summary.ambulance.worse(1));
    expect(lines).toContain(T.shift.summary.ambulance.died(1, false));
    // в приёмах дня — без диагноза: до решения его не поставили
    expect(shiftView().summary?.cases.find(c => c.id === p.id)?.diagnosis).toBe(T.spikes.patient.noDiagnosis);
    forgetShift();
  }, 180_000);
});
