// Правила и задания (spec 2026-10-rules, часть 72; ответы владельца 15.10.2026): неверный диагноз — итог приёма не выше
// C на всех уровнях, кроме «Практиканта»; песочница — после главы 2 кампании, начатая не закрывается; тяжёлые для
// задания о смертности — «красные» скорой по шкале и положенные в ПИТ (ПИТ — в icu.test.ts), выписанный раньше срока
// тяжёлый — потеря, как умерший.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { PlanEval } from '../../src/engine/med/plan';
import { scoreCase } from '../../src/engine/med/score';
import { apply, newCampaign } from '../../src/engine/shift/engine';
import type { ShiftPatient } from '../../src/engine/shift/types';
import { type GameSummary, SANDBOX_AFTER, sandboxLock } from '../../src/state/session';

describe('итог приёма при неверном диагнозе (вопрос 13)', () => {
  const plan = {
    roles: [{ tx: 'tx.amoxicillin', role: 'firstLine' }], effective: true, violations: [], unaskedRisk: [], examHarms: [], preventMissing: [],
    requireMissing: [], requireWhen: {}, beforeTransferMissing: [], beforeTransferWhen: {}, companionsMissing: [], preHospital: [],
    setting: { chosen: 'home', recommended: 'home', also: [] },
  } as unknown as PlanEval;
  // лечение не навредило, место верное, рассуждение и траты — как у разумного врача; по среднему вышло бы «B»
  const base = { confidence: 0.9, cost: 100, rationalCost: 100, plan, outcome: { kind: 'recovered' } as never, selfLimiting: false, redFlags: [] };

  test('неверный — не выше C, как опасное решение; верный и частично верный — по среднему', () => {
    expect(scoreCase({ ...base, verdict: 'wrong' })).toMatchObject({ accuracy: 'D', treatment: 'A', safety: 'A', overall: 'C' });
    expect(scoreCase({ ...base, verdict: 'partly' }).overall).toBe('A');
    expect(scoreCase({ ...base, verdict: 'correct' }).overall).toBe('A');
  });

  test('у «Практиканта» итог — среднее: неверный при хорошем лечении — «B»', () => {
    expect(scoreCase({ ...base, verdict: 'wrong', lenient: true })).toMatchObject({ accuracy: 'D', overall: 'B' });
  });
});

describe('песочница — после главы 2 (вопрос 12)', () => {
  const game = (g: Partial<GameSummary>): GameSummary => ({ mode: 'shift', savedAt: '2026-10-15T10:00:00Z', day: 1, clock: '08:00', difficulty: 'doctor', ...g });

  test('глава 2 не выполнена — закрыта, и сказано, какая глава её откроет', () => {
    expect(SANDBOX_AFTER).toBe('chapter.hospital');
    expect(sandboxLock([], {})).toEqual({ order: 2, name: 'Приёмное' });
    // карьера во второй главе — ещё закрыта
    expect(sandboxLock([game({ mode: 'campaign', career: 1, chapter: 'chapter.hospital' })], {})).toEqual({ order: 2, name: 'Приёмное' });
  });

  test('открыта: достижение главы 2 в профиле, карьера дальше неё или уже начатая песочница', () => {
    expect(sandboxLock([], { 'ach.hospital': { at: '2026-10-15T10:00:00Z', by: 'day' } })).toBeUndefined();
    expect(sandboxLock([game({ mode: 'campaign', career: 2, chapter: 'chapter.vascular' })], {})).toBeUndefined();
    expect(sandboxLock([game({ mode: 'sandbox', cash: 1000 })], {})).toBeUndefined();
    // чужое достижение не в счёт
    expect(sandboxLock([], { 'ach.district': { at: '2026-10-15T10:00:00Z', by: 'day' } })).toEqual({ order: 2, name: 'Приёмное' });
  });
});

describe('тяжёлые и их потери для задания о смертности (вопрос 36)', () => {
  /** День районной больницы главы 2: каждого привезённого скорой — в палату; сортировка — наоборот шкале. */
  function day(seed: number) {
    const s = newCampaign(db, { seed, season: 'winter', career: 1, chapter: 'chapter.hospital' });
    apply(db, s, { kind: 'nextDay' });
    const admitted: ShiftPatient[] = [];
    for (let i = 0; i < 12 * 12; i++) {
      apply(db, s, { kind: 'advance', seconds: 5 * 60 });
      const p = Object.values(s.patients).find(x => x.kind === 'ambulance' && x.status === 'waiting' && !x.sorted);
      if (!p || s.current) continue;
      apply(db, s, { kind: 'sort', id: p.id, triage: p.scale!.triage === 'red' ? 'green' : 'red' });
      apply(db, s, { kind: 'call', id: p.id });
      apply(db, s, { kind: 'diagnose', id: p.patient.truth.conditions[0].id });
      apply(db, s, { kind: 'setting', setting: 'admit' });
      apply(db, s, { kind: 'finish' });
      if (p.status === 'admitted') admitted.push(p);
    }
    return { s, admitted, red: admitted.filter(p => p.scale!.triage === 'red') };
  }

  test('привезённый скорой «красным» по шкале — тяжёлый, хоть врач и отсортировал его иначе; «жёлтый» и «зелёный» — нет; раньше срока — в счёт', () => {
    // «красные» по шкале редки: первый день, когда такой был
    let d = day(51);
    for (let seed = 52; seed < 80 && d.red.length === 0; seed++) d = day(seed);
    const { s, admitted, red } = d;
    expect(red.length).toBeGreaterThan(0);
    expect(red.length).toBeLessThan(admitted.length);
    for (const p of admitted) expect(p.stay!.heavy === true).toBe(p.scale!.triage === 'red');
    expect(s.summary.ward).toMatchObject({ admitted: admitted.length, heavy: red.length });
    // выписали в первые сутки, пока болезнь не прошла, — раньше срока; у тяжёлого это потеря для задания, как смерть
    const light = admitted.find(p => p.scale!.triage !== 'red')!;
    for (const p of [red[0], light]) apply(db, s, { kind: 'discharge', id: p.id });
    expect([red[0].closed!.stay!.end, light.closed!.stay!.end]).toEqual(['early', 'early']);
    expect(s.summary.ward).toMatchObject({ early: 2, heavyEarly: 1 });
    apply(db, s, { kind: 'closeDay' });
    expect(s.history[s.history.length - 1].ward!.heavyLying ?? 0).toBe(red.filter(p => p.status === 'admitted').length);
  });
});
