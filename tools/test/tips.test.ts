// Первая смена главы 1 с наставником (spec 2026-09-campaign, часть 12): первые трое пришедших
// — ОРВИ, ангина, цистит, остальные — как обычно; подсказки — по одной, к месту, каждая один
// раз за карьеру; «Без подсказок»; вне первой смены главы и вне кампании их нет.
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { generatePatient } from '../../src/engine/med/generate';
import { apply, newCampaign } from '../../src/engine/shift/engine';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';
import { memoryStore } from '../../src/state/saves';
import {
  callPatient, chooseDiagnosis, closeDay, examine, finishCase, forgetShift, loadShift, nextDay, saved, seenTip, setStore, shiftState, skipIdle,
  startCampaign, startSandbox, tipsOff, tipView,
} from '../../src/state/session';
import { momentKey, type TipMoment, tipFor } from '../../src/state/tips';

const ch = db.chapters['chapter.district'];
const firstDay = (seed: number) => {
  const s = newCampaign(db, { seed, season: 'winter', career: 1 });
  apply(db, s, { kind: 'nextDay' });
  return s;
};
const byArrival = (s: ShiftState) => Object.values(s.patients).sort((a, b) => a.arriveT - b.arriveT || (a.id < b.id ? -1 : 1));
const primary = (p: ShiftPatient) => p.patient.truth.conditions[0].id;

describe('первые пациенты главы 1', () => {
  test('первые трое пришедших — ОРВИ, ангина, цистит; цистит — у женщины', () => {
    expect(ch.tutorial).toEqual(['cond.arvi', 'cond.strep_pharyngitis', 'cond.cystitis']);
    for (const seed of [1, 2, 3, 42, 777, 2026]) {
      const ps = byArrival(firstDay(seed));
      expect(ps.slice(0, 3).map(primary)).toEqual(ch.tutorial);
      expect(ps[2].patient.sex).toBe('f');
    }
  });

  test('остальные пациенты дня и все следующих дней — как обычно, из своих зёрен', () => {
    const s = firstDay(8);
    const gen = { department: s.meta.department, season: s.meta.season };
    const free = (p: ShiftPatient) => expect(p.patient).toEqual(generatePatient(db, p.patient.seed, gen));
    const [a, b, c, ...rest] = byArrival(s);
    for (const [p, cond] of [[a, ch.tutorial[0]], [b, ch.tutorial[1]], [c, ch.tutorial[2]]] as const) {
      expect(p.patient).toEqual(generatePatient(db, p.patient.seed, { ...gen, primary: cond }));
    }
    rest.forEach(free);
    apply(db, s, { kind: 'closeDay' });
    apply(db, s, { kind: 'nextDay' });
    const second = Object.values(s.patients).filter(p => p.id.startsWith('2-') && !p.returnOf);
    expect(second.length).toBeGreaterThan(3);
    second.forEach(free);
  });

  test('те же зерно и команды — те же заданные пациенты', () => {
    const one = byArrival(firstDay(9)).slice(0, 3).map(p => p.patient);
    expect(byArrival(firstDay(9)).slice(0, 3).map(p => p.patient)).toEqual(one);
  });
});

const at = (x: Partial<TipMoment>): TipMoment => ({ screen: 'card', patient: '1-01', condition: 'cond.arvi', asked: 0, examined: 0, decided: false, ...x });
const tip = (shown: string[], m: TipMoment, hold?: string) => tipFor(db, { shown }, m, hold)?.id;

describe('подсказки: какая и когда', () => {
  test('карта открылась, два вопроса без осмотра, «Решение», разбор', () => {
    expect(tip([], at({}))).toBe('tip.start');
    expect(tip(['tip.start'], at({}))).toBeUndefined();
    expect(tip(['tip.start'], at({ asked: 1 }))).toBeUndefined();
    expect(tip(['tip.start'], at({ asked: 2 }))).toBe('tip.examine');
    // уже осмотрел — «осмотрите» ни к чему
    expect(tip(['tip.start'], at({ asked: 2, examined: 1 }))).toBeUndefined();
    expect(tip(['tip.start'], at({ screen: 'decision' }))).toBe('tip.decision');
    expect(tip(['tip.start'], at({ screen: 'review', decided: true }))).toBe('tip.review');
    expect(tip(['tip.start'], at({ screen: 'review' }))).toBeUndefined();
  });

  test('у пациента с ангиной и с циститом — после первого вопроса или осмотра, до решения', () => {
    const strep = { condition: 'cond.strep_pharyngitis' };
    expect(tip([], at(strep))).toBe('tip.start');
    expect(tip(['tip.start'], at(strep))).toBeUndefined();
    expect(tip(['tip.start'], at({ ...strep, examined: 1 }))).toBe('tip.strep');
    expect(tip(['tip.start'], at({ condition: 'cond.cystitis', asked: 1 }))).toBe('tip.urine');
    expect(tip(['tip.start'], at({ condition: 'cond.cystitis', asked: 1, decided: true }))).toBeUndefined();
  });

  test('по одной: подходят две — первая по порядку, вторая ждёт следующего действия', () => {
    const both = at({ condition: 'cond.strep_pharyngitis', asked: 2 });
    expect(tip(['tip.start'], both)).toBe('tip.examine');
    expect(tip(['tip.start', 'tip.examine'], both, momentKey(both))).toBeUndefined();
    expect(tip(['tip.start', 'tip.examine'], { ...both, asked: 3 }, momentKey(both))).toBe('tip.strep');
  });

  test('каждая — один раз; «Без подсказок» — ни одной', () => {
    const all = Object.keys(db.tips);
    for (const m of [at({}), at({ asked: 2 }), at({ condition: 'cond.cystitis', asked: 1 }), at({ screen: 'decision' }), at({ screen: 'review', decided: true })]) {
      expect(tip(all, m)).toBeUndefined();
      expect(tipFor(db, { shown: [], off: true }, m)).toBeUndefined();
    }
  });
});

describe('подсказки в карьере', () => {
  beforeEach(() => {
    setStore(memoryStore());
    forgetShift();
  });

  test('первая смена: по одной на приёме; показанное помнит сохранение карьеры; во второй день — нет', async () => {
    startCampaign({ career: 1, difficulty: 'student', seed: 1, season: 'winter' });
    expect(tipView('card')).toBeUndefined();
    nextDay();
    skipIdle();
    const s = shiftState()!;
    const id = s.queue[0];
    expect(primary(s.patients[id])).toBe('cond.arvi');
    callPatient(id);
    const first = tipView('card')!;
    expect([first.id, first.first, first.from]).toEqual(['tip.start', true, db.characters['char.mentor'].short.ru]);
    seenTip(first.id, 'card');
    expect(tipView('card')).toBeUndefined();
    examine('exam.ask_onset');
    expect(tipView('card')).toBeUndefined();
    examine('exam.ask_nose');
    expect([tipView('card')?.id, tipView('card')?.first]).toEqual(['tip.examine', false]);
    seenTip('tip.examine', 'card');
    examine('exam.throat');
    expect(tipView('card')).toBeUndefined();
    expect(tipView('decision')?.id).toBe('tip.decision');
    seenTip('tip.decision', 'decision');
    chooseDiagnosis('cond.arvi');
    finishCase();
    expect(tipView('review')?.id).toBe('tip.review');
    seenTip('tip.review', 'review');
    await saved();
    forgetShift();
    await loadShift('campaign', 1);
    expect(shiftState()!.campaign!.tips!.shown).toEqual(['tip.start', 'tip.examine', 'tip.decision', 'tip.review']);
    closeDay();
    nextDay();
    skipIdle();
    callPatient(shiftState()!.queue[0]);
    expect(tipView('card')).toBeUndefined();
  });

  test('«Без подсказок» в первом листе — в этой карьере их больше нет; в песочнице их нет', () => {
    startCampaign({ career: 2, difficulty: 'doctor', seed: 1, season: 'winter' });
    nextDay();
    skipIdle();
    callPatient(shiftState()!.queue[0]);
    expect(tipView('card')?.first).toBe(true);
    tipsOff();
    expect(tipView('card')).toBeUndefined();
    examine('exam.ask_onset');
    examine('exam.ask_nose');
    expect(tipView('card')).toBeUndefined();
    expect(tipView('decision')).toBeUndefined();
    forgetShift();
    startSandbox({ start: 'clinic', budget: 'normal', difficulty: 'student', seed: 1, season: 'winter' });
    nextDay();
    skipIdle();
    callPatient(shiftState()!.queue[0]);
    expect(tipView('card')).toBeUndefined();
  });
});
