// Испытания «Смены» (часть 91, spec 2026-10-challenges, вопрос 50): «Нелюдимый врач» — без расспроса, «Земский врач» —
// без анализов и снимков, «Скупой главврач» — обследования пациента до 1 500 ₽; у ваших пациентов, весь день.
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { caseFacts } from '../../src/engine/career/achievements';
import { BUDGET, CARD_EXAMS, type Challenge, challengeBlock, reviewExams } from '../../src/engine/shift/challenges';
import { apply, newSingle } from '../../src/engine/shift/engine';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';
import { T } from '../../src/i18n';
import { forgetProfile, loadProfile, profile, recordDay, recordSingle, setProfileStore } from '../../src/state/profile';
import { memoryStore } from '../../src/state/saves';
import {
  bestKey, callPatient, challengeBest, chooseDiagnosis, closeDay, examine, examineAll, finishCase, forgetShift, setStore, shiftCaseView, shiftState,
  shiftView, skipIdle, startSingle,
} from '../../src/state/session';
import { challengePassed, PASS_SEEN, type SingleResult } from '../../src/state/single';

const clinic = (challenges?: Challenge[], seed = 21) =>
  newSingle(db, { seed, season: 'winter', venue: 'preset.clinic', ...(challenges ? { challenges } : {}) });

/** Позвать первого в очереди. */
function callFirst(s: ShiftState): ShiftPatient {
  for (let i = 0; i < 600 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
  const id = s.queue[0];
  apply(db, s, { kind: 'call', id });
  return s.patients[id];
}

describe('испытания: что нельзя у ваших пациентов', () => {
  test('«Нелюдимый врач»: расспроса нет; аллергии, хронические болезни и лекарства — из карты, не расспросом', () => {
    const s = clinic(['mute']);
    expect(s.meta.challenges).toEqual(['mute']);
    const p = callFirst(s);
    expect(p.results.filter(r => r.card).map(r => r.exam).sort()).toEqual([...CARD_EXAMS].sort());
    expect(CARD_EXAMS.some(id => p.done.includes(id))).toBe(false);
    apply(db, s, { kind: 'exam', exam: 'exam.ask_complaints' });
    expect(p.done).not.toContain('exam.ask_complaints');
    apply(db, s, { kind: 'exam', exam: 'exam.lung_auscultation' });
    expect(p.done).toContain('exam.lung_auscultation');
    // «Сначала спросить» за ответы из карты не засчитывается: врач не спрашивал
    apply(db, s, { kind: 'diagnose', id: 'cond.arvi' });
    apply(db, s, { kind: 'finish' });
    expect(caseFacts(db, p).allergy).toBe(false);
    // без испытания — из карты ничего, расспрос — как всегда
    const plain = clinic();
    const q = callFirst(plain);
    expect(q.results.some(r => r.card)).toBe(false);
    apply(db, plain, { kind: 'exam', exam: 'exam.ask_complaints' });
    expect(q.done).toContain('exam.ask_complaints');
  });

  test('«Земский врач»: без анализов, экспресс-тестов, снимков и ЭКГ в кабинете; расспрос, осмотр и у постели — можно', () => {
    const s = clinic(['rural']);
    const p = callFirst(s);
    for (const id of ['exam.cbc', 'exam.flu_rapid', 'exam.xray_chest', 'exam.ecg']) {
      apply(db, s, { kind: 'exam', exam: id });
      expect({ id, done: p.done.includes(id) }).toEqual({ id, done: false });
    }
    for (const id of ['exam.ask_complaints', 'exam.lung_auscultation', 'exam.glucometer']) {
      apply(db, s, { kind: 'exam', exam: id });
      expect({ id, done: p.done.includes(id) }).toEqual({ id, done: true });
    }
    // ЭКГ у постели — лежащему в смотровой приёмного с монитором — можно
    expect(challengeBlock(db, ['rural'], 0, 'exam.ecg', true)).toBeUndefined();
    expect(challengeBlock(db, ['rural'], 0, 'exam.ecg')).toEqual({ challenge: 'rural' });
  });

  test('«Скупой главврач»: на пациента 1 500 ₽ — дороже оставшегося нельзя, дешевле — можно', () => {
    const s = clinic(['thrifty']);
    const p = callFirst(s);
    // 400 + 350 = 750; тропонин за 1 200 — уже нельзя; глюкоза за 150 — можно (900); снимок за 900 — нельзя
    for (const [id, ok] of [['exam.crp', true], ['exam.cbc', true], ['exam.troponin_hs', false], ['exam.glucose_lab', true], ['exam.xray_chest', false]] as const) {
      apply(db, s, { kind: 'exam', exam: id });
      expect({ id, done: p.done.includes(id) }).toEqual({ id, done: ok });
    }
    expect(p.spent.money).toBe(900);
    expect(challengeBlock(db, ['thrifty'], 900, 'exam.xray_chest')).toEqual({ challenge: 'thrifty', left: BUDGET - 900 });
    expect(challengeBlock(db, ['thrifty'], 900, 'exam.ask_complaints')).toBeUndefined();
  });

  test('нанятые врачи городской больницы работают как обычно — расспрашивают и при «Нелюдимом враче»', () => {
    const s = newSingle(db, { seed: 23, season: 'winter', venue: 'preset.city', challenges: ['mute'] });
    for (let i = 0; i < 240 && !Object.values(s.patients).some(p => p.by && p.done.some(id => db.exams[id].kind === 'ask')); i++) {
      apply(db, s, { kind: 'advance', seconds: 60 });
    }
    const theirs = Object.values(s.patients).filter(p => p.by);
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.some(p => p.done.some(id => db.exams[id].kind === 'ask'))).toBe(true);
    // из карты — только у ваших: позвали вы
    expect(theirs.some(p => p.results.some(r => r.card))).toBe(false);
  });

  test('испытаний нет — ничего не запрещено; разумный врач разбора — с теми же запретами', () => {
    expect(challengeBlock(db, undefined, 10_000, 'exam.cbc')).toBeUndefined();
    const all = Object.keys(db.exams).sort();
    expect(reviewExams(db, undefined, all)).toEqual(all);
    const mute = reviewExams(db, ['mute'], all);
    expect(mute.filter(id => db.exams[id].kind === 'ask').sort()).toEqual([...CARD_EXAMS].sort());
    expect(mute).toContain('exam.cbc');
    const rural = reviewExams(db, ['rural'], all);
    expect(new Set(rural.map(id => db.exams[id].kind))).toEqual(new Set(['ask', 'physical', 'bedside']));
    // деньги разумному врачу не ограничены
    expect(reviewExams(db, ['thrifty'], all)).toEqual(all);
  });

  test('«Земский врач»: разумный врач разбора анализов и снимков не назначает — его путь почти бесплатный', () => {
    const s = clinic(['rural']);
    for (let k = 0; k < 3; k++) {
      callFirst(s);
      apply(db, s, { kind: 'exam', exam: 'exam.ask_complaints' });
      apply(db, s, { kind: 'diagnose', id: 'cond.arvi' });
      apply(db, s, { kind: 'finish' });
    }
    apply(db, s, { kind: 'closeDay' });
    const closed = Object.values(s.patients).filter(p => p.closed && !p.closed.by);
    expect(closed.length).toBe(3);
    // у постели — только глюкометр стоит денег
    for (const p of closed) expect(p.closed!.rationalMoney ?? 0).toBeLessThanOrEqual(db.exams['exam.glucometer'].cost);
  });
});

describe('испытания: пройдено, достижения, лучший результат', () => {
  const result = (overall: SingleResult['overall'], seen: number): SingleResult => ({
    seen, arrived: seen, minutes: 20, correct: 90, grades: { accuracy: 'A', defensibility: 'A', thrift: 'A', safety: 'A', speed: 'A' }, overall, points: 2.5,
  });

  test('пройдено — итог не ниже «B» и не меньше 8 своих пациентов', () => {
    expect(PASS_SEEN).toBe(8);
    expect(challengePassed(result('B', 8))).toBe(true);
    expect(challengePassed(result('A', 12))).toBe(true);
    expect(challengePassed(result('B', 7))).toBe(false);
    expect(challengePassed(result('C', 15))).toBe(false);
    expect(challengePassed(undefined)).toBe(false);
  });

  test('лучший результат — свой у набора испытаний; у каждого испытания — лучший с ним в любой больнице', async () => {
    await loadProfile();
    const meta = (challenges?: Challenge[], solo?: true) => ({ meta: { venue: 'preset.clinic', ...(solo ? { solo } : {}), ...(challenges ? { challenges } : {}) } }) as ShiftState;
    expect(bestKey(meta())).toBe('preset.clinic');
    expect(bestKey(meta(['mute', 'thrifty']))).toBe('preset.clinic:ch=mute+thrifty');
    expect(bestKey(meta(['rural'], true))).toBe('preset.clinic:solo:ch=rural');
    expect(challengeBest('mute')).toBeUndefined();
    const r = { points: 2, overall: 'B' as const, seen: 10, arrived: 12, seed: 1 };
    recordSingle('preset.clinic:ch=mute', r);
    recordSingle('preset.village:ch=mute+thrifty', { ...r, seed: 2, overall: 'A', points: 2.6 });
    recordSingle('preset.clinic', { ...r, seed: 3, overall: 'A', points: 3 });
    expect(challengeBest('mute')).toEqual({ best: profile().best['preset.village:ch=mute+thrifty'], venue: db.presets['preset.village'].name.ru });
    expect(challengeBest('thrifty')?.best.seed).toBe(2);
    expect(challengeBest('rural')).toBeUndefined();
  });

  test('закрытый день с пройденными испытаниями — достижение за каждое', async () => {
    await loadProfile();
    const fresh = recordDay({ key: 'single:1:1', seen: 9, noLeft: false, rooms: [], chapters: [], challenges: ['mute', 'thrifty'] });
    expect(fresh.filter(id => id.startsWith('ach.challenge_')).sort()).toEqual(['ach.challenge_mute', 'ach.challenge_thrifty']);
    expect(recordDay({ key: 'single:2:1', seen: 9, noLeft: false, rooms: [], chapters: [] }).filter(id => id.startsWith('ach.challenge_'))).toEqual([]);
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

describe('испытания в игре', () => {
  test('смена с испытаниями: имя, запреты в карте пациента с причиной, деньги, итог дня со строкой испытания', async () => {
    await loadProfile();
    expect(await startSingle({ venue: 'preset.clinic', difficulty: 'student', seed: 31, season: 'winter', challenges: ['thrifty', 'mute'] })).toBe(true);
    const s = shiftState()!;
    expect(s.meta.challenges).toEqual(['mute', 'thrifty']);
    skipIdle();
    callPatient(shiftView().queue[0].id);
    let v = shiftCaseView()!;
    expect(v.challenges).toEqual(['mute', 'thrifty']);
    expect(v.unavailable['exam.ask_complaints']).toBe(T.challenges.blocked.mute);
    expect(v.budget).toEqual({ left: BUDGET, of: BUDGET });
    expect(v.groups.filter(g => g.card).map(g => g.name).sort()).toEqual(CARD_EXAMS.map(id => T.challenges.fromCard(db.exams[id].name.ru)).sort());
    // бланком: анализы по порядку, сверх лимита — не назначены; что осталось — в причине
    examineAll(['exam.crp', 'exam.cbc', 'exam.d_dimer']);
    v = shiftCaseView()!;
    expect(v.done.filter(id => ['exam.crp', 'exam.cbc', 'exam.d_dimer'].includes(id)).sort()).toEqual(['exam.cbc', 'exam.crp']);
    expect(v.budget!.left).toBe(BUDGET - 750);
    expect(v.unavailable['exam.d_dimer']).toBe(T.challenges.budgetLeft(T.common.rub(BUDGET - 750)));
    examine('exam.lung_auscultation');
    chooseDiagnosis(shiftCaseView()!.hints[0].id);
    finishCase();
    closeDay();
    const single = shiftView().summary!.single!;
    expect(single.lines[single.lines.length - 1]).toBe(T.challenges.failed);
    expect(single.venue).toContain('Нелюдимый врач, Скупой главврач');
  });
});
