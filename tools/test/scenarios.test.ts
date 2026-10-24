// Сценарии «Быстрой игры» (часть 91, spec 2026-10-scenarios, вопрос 55): неделя — пять смен в одной больнице с особым
// условием и целью. «Зимний грипп» — ОРВИ, гриппа и пневмонии вдвое больше; «Закрыли соседнюю больницу» — пришедших и
// скорой в полтора раза больше; «Рентген сломался» — неделя без рентгена.
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { contextOf, posterior } from '../../src/engine/med/infer';
import { complaintObservations } from '../../src/engine/med/exams';
import { apply, candidatesOf, hospitalCtx, newScenario, newSingle, observationsOf } from '../../src/engine/shift/engine';
import {
  FLU_IDS, FLU_X, NEIGHBOR_FLOW, type Scenario, SCENARIO_DAYS, scenarioAmbulance, scenarioFits, scenarioFlow, scenarioPrior, xrayBroken,
} from '../../src/engine/shift/scenarios';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';
import { T } from '../../src/i18n';
import { forgetProfile, loadProfile, profile, recordDay, recordSingle, setProfileStore } from '../../src/state/profile';
import { memoryStore } from '../../src/state/saves';
import { needlessAntibiotic, PNEUMONIA_CAUGHT, scenarioResult, WEEK_SEEN } from '../../src/state/scenario';
import {
  bestKey, callPatient, chooseDiagnosis, closeDay, compatible, finishCase, forgetShift, nextDay, savedGames, scenarioBest, scenarioVenues, setStore,
  shiftCaseView, shiftState, shiftView, skipIdle, startScenario,
} from '../../src/state/session';
import { singleResult } from '../../src/state/single';

const primary = (p: ShiftPatient) => p.patient.truth.conditions[0].id;
const self = (s: ShiftState) => Object.values(s.patients).filter(p => p.kind === 'appointment' || p.kind === 'walkIn');

/** Неделя простого врача: каждого позвать, расспросить о жалобах, поставить `dx` (и дать `tx`), закрыть день — пять смен. */
function playWeek(s: ShiftState, dx: (p: ShiftPatient) => string, tx?: string) {
  for (let d = 1; d <= SCENARIO_DAYS; d++) {
    if (d > 1) apply(db, s, { kind: 'nextDay' });
    for (let i = 0; i < 3000 && s.dayOpen; i++) {
      const waiting = Object.values(s.patients).some(p => p.status === 'coming' || p.status === 'intake' || p.status === 'away');
      if (s.queue.length === 0 && !s.current && !waiting && s.t % 86_400 >= 15 * 3600) break;
      const id = s.queue.find(x => s.patients[x].kind !== 'ambulance' || s.patients[x].sorted);
      const amb = s.queue.find(x => s.patients[x].kind === 'ambulance' && !s.patients[x].sorted);
      if (amb) apply(db, s, { kind: 'sort', id: amb, triage: s.patients[amb].scale?.triage ?? 'yellow' });
      else if (id && !s.current) {
        apply(db, s, { kind: 'call', id });
        const p = s.patients[id];
        apply(db, s, { kind: 'exam', exam: 'exam.ask_complaints' });
        apply(db, s, { kind: 'diagnose', id: dx(p) });
        if (tx) apply(db, s, { kind: 'toggleTreatment', id: tx });
        apply(db, s, { kind: 'finish' });
        if (s.current) {
          apply(db, s, { kind: 'setting', setting: 'ambulance' });
          apply(db, s, { kind: 'finish' });
        }
      } else apply(db, s, { kind: 'advance', seconds: 120 });
    }
    apply(db, s, { kind: 'closeDay' });
  }
}

describe('сценарии: неделя в движке', () => {
  test('«Зимний грипп»: на каждого пришедшего сам с ОРВИ, гриппом или пневмонией — ещё один; остальные — те же; всегда зима', () => {
    for (const seed of [11, 12, 13]) {
      const plain = newSingle(db, { seed, season: 'winter', venue: 'preset.clinic' });
      const flu = newScenario(db, { seed, season: 'summer', venue: 'preset.clinic', scenario: 'flu' });
      expect(flu.meta.season).toBe('winter');
      expect([flu.meta.mode, flu.meta.scenario]).toEqual(['scenario', 'flu']);
      const sick = (s: ShiftState) => self(s).filter(p => FLU_IDS.includes(primary(p)));
      const other = (s: ShiftState) => self(s).filter(p => !FLU_IDS.includes(primary(p))).map(p => `${p.arriveT}:${primary(p)}:${p.patient.age}`).sort();
      expect(sick(flu).length).toBe(2 * sick(plain).length);
      expect(other(flu)).toEqual(other(plain));
      // лишние — без записи
      expect(self(flu).filter(p => p.kind === 'walkIn').length).toBe(self(plain).filter(p => p.kind === 'walkIn').length + sick(plain).length);
      // номера — по времени прихода, как всегда
      const ids = Object.keys(flu.patients).sort();
      expect(ids.map(id => flu.patients[id].arriveT)).toEqual([...ids.map(id => flu.patients[id].arriveT)].sort((a, b) => a - b));
    }
  });

  test('«Закрыли соседнюю больницу»: пришедших сами и машин скорой — в полтора раза больше', () => {
    expect(scenarioFlow('neighbor')).toBe(NEIGHBOR_FLOW);
    expect(scenarioFlow(undefined)).toBe(100);
    expect(scenarioFlow('flu')).toBe(100);
    expect(scenarioAmbulance('neighbor', [2, 4])).toEqual([3, 6]);
    expect(scenarioAmbulance('xray', [2, 4])).toEqual([2, 4]);
    let plain = 0;
    let busy = 0;
    for (const seed of [21, 22, 23, 24]) {
      plain += Object.keys(newSingle(db, { seed, season: 'winter', venue: 'preset.district' }).patients).length;
      busy += Object.keys(newScenario(db, { seed, season: 'winter', venue: 'preset.district', scenario: 'neighbor' }).patients).length;
    }
    expect(busy / plain).toBeGreaterThan(1.3);
    expect(busy / plain).toBeLessThan(1.9);
  });

  test('«Рентген сломался»: с первого утра до конца недели рентгена нет — назначить снимок нельзя', () => {
    const s = newScenario(db, { seed: 5, season: 'winter', venue: 'preset.clinic', scenario: 'xray' });
    const keys = xrayBroken(db, 'xray', hospitalCtx(db, s).plan.rooms);
    expect(keys.length).toBeGreaterThan(0);
    expect(xrayBroken(db, 'flu', hospitalCtx(db, s).plan.rooms)).toEqual([]);
    for (let d = 1; d <= SCENARIO_DAYS; d++) {
      if (d > 1) apply(db, s, { kind: 'nextDay' });
      expect(keys.every(k => s.broken?.includes(k))).toBe(true);
      for (let i = 0; i < 600 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
      const id = s.queue[0];
      apply(db, s, { kind: 'call', id });
      apply(db, s, { kind: 'exam', exam: 'exam.xray_chest' });
      expect(s.patients[id].done).not.toContain('exam.xray_chest');
      apply(db, s, { kind: 'closeDay' });
    }
  }, 30_000);

  test('«Зимний грипп»: уверенность разбора при закрытии — с эпидемией, как «Похоже на» и разумный врач', () => {
    const s = newScenario(db, { seed: 47, season: 'winter', venue: 'preset.clinic', scenario: 'flu' });
    for (let i = 0; i < 600 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
    const id = s.queue[0];
    apply(db, s, { kind: 'call', id });
    apply(db, s, { kind: 'exam', exam: 'exam.ask_complaints' });
    apply(db, s, { kind: 'diagnose', id: 'cond.influenza' });
    apply(db, s, { kind: 'finish' });
    if (s.current) {
      apply(db, s, { kind: 'setting', setting: 'ambulance' });
      apply(db, s, { kind: 'finish' });
    }
    const p = s.patients[id];
    const obs = observationsOf(p);
    const cands = candidatesOf(db, p.departments ?? s.meta.department);
    const flu = (prior?: ReturnType<typeof scenarioPrior>) => posterior(db, cands, obs, contextOf(db, p.patient, obs, prior)).find(b => b.id === 'cond.influenza')?.p ?? 0;
    expect(p.closed!.confidence).toBeCloseTo(flu(scenarioPrior('flu')), 9);
    expect(flu(scenarioPrior('flu'))).toBeGreaterThan(flu());
  }, 30_000);

  test('неделя — пять смен: после пятой следующей нет', () => {
    const s = newScenario(db, { seed: 7, season: 'winter', venue: 'preset.clinic', scenario: 'xray' });
    for (let d = 1; d <= SCENARIO_DAYS + 2; d++) {
      apply(db, s, { kind: 'closeDay' });
      apply(db, s, { kind: 'nextDay' });
    }
    expect([s.day, s.dayOpen, s.history.length]).toEqual([SCENARIO_DAYS, false, SCENARIO_DAYS]);
  });

  test('где играть: скорая — где есть смотровая приёмного, без рентгена — где он есть; грипп — где угодно', () => {
    const rooms = (venue: string) => new Set(hospitalCtx(db, newSingle(db, { seed: 1, season: 'winter', venue })).plan.rooms.map(r => r.type));
    expect(scenarioFits('neighbor', rooms('preset.clinic'))).toBe(false);
    expect(scenarioFits('neighbor', rooms('preset.district'))).toBe(true);
    expect(scenarioFits('xray', rooms('preset.clinic'))).toBe(true);
    expect(scenarioFits('xray', rooms('preset.village'))).toBe(false);
    expect(scenarioFits('flu', rooms('preset.village'))).toBe(true);
  });

  test('«Зимний грипп»: врач знает об эпидемии — ОРВИ, грипп и пневмония вдвое вероятнее, и только они', () => {
    expect(scenarioPrior('flu')).toEqual({ ids: FLU_IDS, x: FLU_X });
    expect(scenarioPrior('neighbor')).toBeUndefined();
    const s = newScenario(db, { seed: 9, season: 'winter', venue: 'preset.clinic', scenario: 'flu' });
    const p = self(s).find(x => x.patient.complaints.length > 0)!.patient;
    const obs = complaintObservations(p);
    const cands = Object.keys(db.conditions).filter(id => db.conditions[id].department === 'dept.therapy');
    const share = (ctx: ReturnType<typeof contextOf>) => posterior(db, cands, obs, ctx).filter(b => FLU_IDS.includes(b.id)).reduce((a, b) => a + b.p, 0);
    const plain = share(contextOf(db, p, obs));
    const epidemic = share(contextOf(db, p, obs, scenarioPrior('flu')));
    expect(epidemic).toBeGreaterThan(plain);
    // по шансам — ровно вдвое: остальные болезни между собой как были
    if (plain > 0 && plain < 1) expect(epidemic / (1 - epidemic)).toBeCloseTo((FLU_X * plain) / (1 - plain), 6);
  });
});

describe('сценарии: цели недели', () => {
  test('«Зимний грипп»: всем «пневмония» и амоксициллин — пневмонию не пропустили, антибиотик без нужды — у многих', () => {
    const s = newScenario(db, { seed: 31, season: 'winter', venue: 'preset.clinic', scenario: 'flu' });
    playWeek(s, () => 'cond.pneumonia_cap', 'tx.amoxicillin');
    const r = scenarioResult(db, s)!;
    const goal = (k: string) => r.goals.find(g => g.key === k)!;
    const mine = Object.values(s.patients).filter(p => p.closed && !p.closed.by);
    expect(goal('seen').value).toBe(mine.length);
    expect(goal('pneumonia').of).toBe(mine.filter(p => p.patient.truth.conditions.some(c => c.id === 'cond.pneumonia_cap')).length);
    if ((goal('pneumonia').of ?? 0) > 0) expect([goal('pneumonia').value, goal('pneumonia').ok]).toEqual([100, true]);
    const needless = mine.filter(p => needlessAntibiotic(db, p)).length;
    expect(goal('antibiotic').value).toBe(needless);
    expect(needless).toBeGreaterThan(mine.length / 2);
    expect(goal('antibiotic').ok).toBe(false);
    expect(r.passed).toBe(false);
    expect(r.days).toBe(SCENARIO_DAYS);
  }, 60_000);

  test('«Зимний грипп»: всем ОРВИ без антибиотика — без нужды не дали, а пневмонию пропустили', () => {
    const s = newScenario(db, { seed: 32, season: 'winter', venue: 'preset.clinic', scenario: 'flu' });
    playWeek(s, () => 'cond.arvi');
    const r = scenarioResult(db, s)!;
    const goal = (k: string) => r.goals.find(g => g.key === k)!;
    expect([goal('antibiotic').value, goal('antibiotic').ok]).toEqual([0, true]);
    expect(goal('pneumonia').of).toBeGreaterThan(0);
    expect(goal('pneumonia').value).toBeLessThan(PNEUMONIA_CAUGHT);
    expect(goal('pneumonia').ok).toBe(false);
  }, 60_000);

  test('«Закрыли соседнюю больницу» и «Рентген сломался»: очередь — по итогам дней, итог недели — по «Смене» за пять смен', () => {
    const n = newScenario(db, { seed: 33, season: 'winter', venue: 'preset.district', scenario: 'neighbor' });
    playWeek(n, p => primary(p));
    const rn = scenarioResult(db, n)!;
    const arrived = n.history.reduce((a, h) => a + h.arrived, 0);
    const lost = n.history.reduce((a, h) => a + h.left + h.unseen, 0);
    expect(rn.goals.map(g => g.key)).toEqual(['seen', 'queue', 'deaths']);
    expect(rn.goals[1]).toMatchObject({ value: Math.round((100 * lost) / arrived), of: arrived });
    const x = newScenario(db, { seed: 34, season: 'winter', venue: 'preset.clinic', scenario: 'xray' });
    playWeek(x, p => primary(p));
    const rx = scenarioResult(db, x)!;
    expect(rx.goals.map(g => g.key)).toEqual(['seen', 'overall']);
    expect(rx.goals[1].value).toBe(singleResult(x)!.overall);
    // правильные диагнозы всем — итог не ниже «B»; пройдено, если своих пациентов хватило
    expect(rx.passed).toBe(rx.goals.every(g => g.ok));
    expect(singleResult(x)!.arrived).toBe(x.history.reduce((a, h) => a + h.arrived, 0));
  }, 60_000);

  test('пока неделя не кончилась — не пройдено', () => {
    const s = newScenario(db, { seed: 35, season: 'winter', venue: 'preset.clinic', scenario: 'xray' });
    apply(db, s, { kind: 'closeDay' });
    const r = scenarioResult(db, s)!;
    expect([r.days, r.passed]).toEqual([1, false]);
    expect(scenarioResult(db, newSingle(db, { seed: 1, season: 'winter', venue: 'preset.clinic' }))).toBeUndefined();
  });
});

let store = memoryStore();
beforeEach(() => {
  store = memoryStore();
  setStore(store);
  setProfileStore(store);
  forgetShift();
  forgetProfile();
});

describe('сценарии в игре', () => {
  test('пройденный сценарий — достижение; лучший итог недели — свой у сценария в каждой больнице', async () => {
    await loadProfile();
    const fresh = recordDay({ key: 'scenario:1:5', seen: 9, noLeft: false, rooms: [], chapters: [], scenario: 'flu' });
    expect(fresh.filter(id => id.startsWith('ach.scenario_'))).toEqual(['ach.scenario_flu']);
    const meta = (scenario?: Scenario) => ({ meta: { venue: 'preset.clinic', ...(scenario ? { scenario } : {}) } }) as ShiftState;
    expect(bestKey(meta('xray'))).toBe('preset.clinic:sc=xray');
    expect(scenarioBest('xray')).toBeUndefined();
    recordSingle('preset.clinic:sc=xray', { points: 2, overall: 'B', seen: 40, arrived: 50, seed: 1 });
    recordSingle('preset.district:sc=xray', { points: 2.7, overall: 'A', seen: 60, arrived: 80, seed: 2 });
    expect(scenarioBest('xray')).toEqual({ best: profile().best['preset.district:sc=xray'], venue: db.presets['preset.district'].name.ru });
    expect(scenarioBest('flu')).toBeUndefined();
  });

  test('где можно: больница, где сценарию не быть, — с причиной', async () => {
    await loadProfile();
    const clinic = (await scenarioVenues('neighbor')).find(v => v.venue === 'preset.clinic')!;
    expect([clinic.ok, clinic.hint]).toEqual([false, T.scenarios.unfit.neighbor]);
    expect((await scenarioVenues('flu')).find(v => v.venue === 'preset.clinic')?.ok).toBe(true);
    expect(await startScenario({ scenario: 'neighbor', venue: 'preset.clinic', difficulty: 'student' })).toBe(false);
  });

  test('неделя «Зимнего гриппа»: свой слот, «Продолжить» с днём, итог дня — день недели и цели, после пятой смены — итог недели', async () => {
    await loadProfile();
    expect(await startScenario({ scenario: 'flu', venue: 'preset.clinic', difficulty: 'student', seed: 41, season: 'summer' })).toBe(true);
    const s = shiftState()!;
    expect([s.meta.mode, s.meta.scenario, s.meta.season]).toEqual(['scenario', 'flu', 'winter']);
    expect(compatible(s)).toBe(true);
    expect(compatible({ ...s, meta: { ...s.meta, scenario: 'storm' as Scenario } })).toBe(false);
    expect(shiftView().scenario).toEqual({ name: 'Зимний грипп', day: T.scenarios.day(1, SCENARIO_DAYS) });
    for (let d = 1; d <= SCENARIO_DAYS; d++) {
      skipIdle();
      callPatient(shiftView().queue[0].id);
      chooseDiagnosis(shiftCaseView()!.hints[0]?.id ?? 'cond.arvi');
      finishCase();
      closeDay();
      const sc = shiftView().summary!.scenario!;
      expect(sc.day).toBe(T.scenarios.day(d, SCENARIO_DAYS));
      expect(sc.goals[0].text).toBe(T.scenarios.goal.seen(d, WEEK_SEEN));
      expect(sc.final).toBe(d === SCENARIO_DAYS);
      // итог «Смены» — за сыгранные смены недели, после пятой — итог недели
      const venue = shiftView().summary!.single!.venue;
      expect(shiftView().summary!.single!.title).toBe(`${d < SCENARIO_DAYS ? T.scenarios.soFar : T.scenarios.weekTitle} · ${venue}`);
      if (d < SCENARIO_DAYS) {
        expect(sc.verdict).toBeUndefined();
        nextDay();
      }
    }
    const sc = shiftView().summary!.scenario!;
    expect([sc.verdict, sc.passed]).toEqual([T.scenarios.failed, false]);
    nextDay();
    expect([shiftView().day, shiftView().dayOpen]).toEqual([SCENARIO_DAYS, false]);
    const games = await savedGames();
    const g = games.find(x => x.mode === 'scenario')!;
    expect(g.venue).toContain('сценарий «Зимний грипп»');
    expect(g.day).toBe(SCENARIO_DAYS);
    // лучший итог недели — в профиле, у сценария
    expect(profile().best['preset.clinic:sc=flu']).toBeDefined();
  }, 60_000);
});
