// «Смена» (spec 2026-09-campaign, часть 14): один день в выбранной больнице — амбулатории
// практики, больнице главы, копии своей из песочницы; итог по категориям и лучший результат по
// больницам; где смену не открыть — с причиной.
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { apply, newShift, newSingle, SANDBOX_VENUE } from '../../src/engine/shift/engine';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';
import { forgetProfile, loadProfile, profile, profileSaved, recordSingle, setProfileStore } from '../../src/state/profile';
import { memoryStore } from '../../src/state/saves';
import {
  callPatient, chooseDiagnosis, closeDay, examine, finishCase, forgetShift, loadShift, saved, savedGames, setStore, shiftCaseView, shiftState,
  shiftView, singleVenues, skipIdle, startCampaign, startSandbox, startSingle,
} from '../../src/state/session';
import { SPEED_MINUTES, singleResult } from '../../src/state/single';

/** Закрыть в смене движка `n` приёмов подряд: опрос, ОРВИ, домой. */
function closeCases(s: ShiftState, n: number): ShiftPatient[] {
  const out: ShiftPatient[] = [];
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < 600 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
    const id = s.queue[0];
    apply(db, s, { kind: 'call', id });
    apply(db, s, { kind: 'exam', exam: 'exam.ask_complaints' });
    apply(db, s, { kind: 'diagnose', id: 'cond.arvi' });
    apply(db, s, { kind: 'finish' });
    out.push(s.patients[id]);
  }
  return out;
}

describe('«Смена»: больница и итог', () => {
  test('в амбулатории практики — те же пациенты, что в практике с тем же зерном; своя больница — копия', () => {
    const a = newSingle(db, { seed: 5, season: 'winter', venue: 'preset.clinic' });
    const b = newShift(db, { seed: 5, season: 'winter' });
    expect([a.meta.mode, a.meta.venue, a.day, a.dayOpen, a.hospital, a.economy]).toEqual(['single', 'preset.clinic', 1, true, undefined, undefined]);
    expect(Object.values(a.patients).map(p => p.patient)).toEqual(Object.values(b.patients).map(p => p.patient));
    const village = newSingle(db, { seed: 5, season: 'winter', venue: 'preset.village' });
    expect(village.hospital!.rooms.some(r => r.type === 'room.lab')).toBe(false);
    expect(village.staff!.length).toBeGreaterThan(0);
    const sb = { hospital: village.hospital!, staff: village.staff! };
    const own = newSingle(db, { seed: 5, season: 'winter', venue: SANDBOX_VENUE, ...sb });
    own.hospital!.rooms.pop();
    expect(sb.hospital.rooms.length).toBe(own.hospital!.rooms.length + 1);
  });

  test('итог — по категориям, общий балл и скорость в минутах; никого не приняли — итога нет', () => {
    const s = newSingle(db, { seed: 7, season: 'winter', venue: 'preset.clinic' });
    expect(singleResult(s)).toBeUndefined();
    const ps = closeCases(s, 3);
    apply(db, s, { kind: 'closeDay' });
    const r = singleResult(s)!;
    expect(Object.keys(r.grades)).toEqual(['accuracy', 'defensibility', 'thrift', 'safety', 'speed']);
    expect(r.seen).toBe(3);
    expect(r.arrived).toBe(s.history[0].arrived);
    expect(r.minutes).toBe(Math.round(ps.reduce((a, p) => a + p.spent.seconds, 0) / 3 / 60));
    expect(r.grades.speed).toBe(r.minutes <= SPEED_MINUTES[0] ? 'A' : r.minutes <= SPEED_MINUTES[1] ? 'B' : r.minutes <= SPEED_MINUTES[2] ? 'C' : 'D');
    expect(r.points).toBeGreaterThanOrEqual(0);
    expect(r.points).toBeLessThanOrEqual(3);
  });
});

describe('«Смена»: общая оценка', () => {
  test('не выше точности и не больше чем на ступень выше худшей категории', () => {
    const s = newSingle(db, { seed: 7, season: 'winter', venue: 'preset.clinic' });
    closeCases(s, 4);
    apply(db, s, { kind: 'closeDay' });
    const cases = Object.values(s.patients).filter(p => p.closed);
    for (const p of cases) Object.assign(p.closed!, { verdict: 'wrong' });
    expect([singleResult(s)!.correct, singleResult(s)!.grades.accuracy, singleResult(s)!.overall]).toEqual([0, 'D', 'D']);
    for (const p of cases) {
      Object.assign(p.closed!, { verdict: 'correct' });
      Object.assign(p.closed!.grades, { defensibility: 'A', thrift: 'A', safety: 'A' });
      p.spent.seconds = 90 * 60;
    }
    const slow = singleResult(s)!;
    expect([slow.correct, slow.grades.accuracy, slow.grades.speed, slow.overall]).toEqual([100, 'A', 'D', 'C']);
    for (const p of cases) p.spent.seconds = 20 * 60;
    expect(singleResult(s)!.overall).toBe('A');
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

describe('«Смена»: лучший результат', () => {
  test('лучший — по баллу, при равном — кто принял больше; повтор той же смены — не новый', async () => {
    await loadProfile();
    const r = { points: 2, overall: 'B' as const, seen: 10, arrived: 12, seed: 1 };
    expect(recordSingle('preset.clinic', r)).toEqual({ best: true });
    expect(recordSingle('preset.clinic', r)).toEqual({ best: true });
    const first = profile().best['preset.clinic'];
    expect(recordSingle('preset.clinic', { ...r, seed: 2, points: 1.5 }).best).toBe(false);
    expect(recordSingle('preset.clinic', { ...r, seed: 3, seen: 11 }).best).toBe(true);
    expect(profile().best['preset.clinic'].seed).toBe(3);
    expect(recordSingle('preset.village', { ...r, seed: 4 }).best).toBe(true);
    await profileSaved();
    forgetProfile();
    await loadProfile();
    expect(profile().best['preset.clinic'].seed).toBe(3);
    expect(first.seed).toBe(1);
  });
});

describe('«Смена» в игре', () => {
  test('больницы: практика — всегда; больница главы — когда глава открыта; своя — если смену в ней открыть можно', async () => {
    await loadProfile();
    const byVenue = async () => Object.fromEntries((await singleVenues()).map(v => [v.venue, v]));
    let v = await byVenue();
    expect([v['preset.clinic'].ok, v['preset.village'].ok, v[SANDBOX_VENUE].ok]).toEqual([true, false, false]);
    expect(v['preset.clinic'].hint).toBe('как в практике: лаборатория, рентген и ЭКГ');
    expect(v['preset.village'].hint).toBe('откроется с главой 1 «Участок» в кампании');
    expect(v[SANDBOX_VENUE].hint).toBe('песочницы пока нет');
    startCampaign({ career: 1, difficulty: 'student', seed: 3, season: 'winter' });
    startSandbox({ start: 'empty', budget: 'normal', difficulty: 'student', seed: 3, season: 'winter' });
    await saved();
    v = await byVenue();
    expect(v['preset.village'].ok).toBe(true);
    expect([v[SANDBOX_VENUE].ok, v[SANDBOX_VENUE].hint.startsWith('Чтобы открыть смену, нужно:')]).toEqual([false, true]);
    expect(await startSingle({ venue: SANDBOX_VENUE, difficulty: 'student' })).toBe(false);
    startSandbox({ start: 'clinic', budget: 'normal', difficulty: 'student', seed: 4, season: 'winter' });
    await saved();
    expect((await byVenue())[SANDBOX_VENUE].ok).toBe(true);
  });

  test('смена в больнице главы: один день, итог по категориям, лучший результат; сохранение и «Продолжить»', async () => {
    await loadProfile();
    expect(await startSingle({ venue: 'preset.village', difficulty: 'student', seed: 11, season: 'winter' })).toBe(true);
    const s = shiftState()!;
    expect([s.meta.mode, s.meta.venue, s.hospital!.rooms.some(r => r.type === 'room.lab')]).toEqual(['single', 'preset.village', false]);
    skipIdle();
    callPatient(shiftView().queue[0].id);
    examine('exam.ask_complaints');
    chooseDiagnosis(shiftCaseView()!.hints[0].id);
    finishCase();
    closeDay();
    const r = shiftView().summary!.single!;
    expect(r.venue).toBe('Амбулатория в посёлке');
    expect(r.grades.map(g => g.key)).toEqual(['accuracy', 'defensibility', 'thrift', 'safety', 'speed']);
    expect(r.lines[0]).toMatch(/^Принято: 1 из \d+$/);
    expect(r.best).toBe('Лучший результат в этой больнице.');
    expect(profile().best['preset.village'].seed).toBe(11);
    await saved();
    const games = await savedGames();
    expect(games.find(g => g.mode === 'single')?.venue).toBe('Амбулатория в посёлке');
    forgetShift();
    await loadShift('single');
    expect(shiftState()?.meta.venue).toBe('preset.village');
  });

  test('своя больница — копия: смена её не меняет', async () => {
    await loadProfile();
    startSandbox({ start: 'clinic', budget: 'normal', difficulty: 'student', seed: 4, season: 'winter' });
    const rooms = shiftState()!.hospital!.rooms.length;
    await saved();
    expect(await startSingle({ venue: SANDBOX_VENUE, difficulty: 'doctor', seed: 12 })).toBe(true);
    shiftState()!.hospital!.rooms.pop();
    await saved();
    forgetShift();
    await loadShift('sandbox');
    expect(shiftState()!.hospital!.rooms.length).toBe(rooms);
  });
});
