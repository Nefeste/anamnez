// Трудность случая (часть 92, вопрос 56, spec 2026-10-case-difficulty): ряд у двери и хватает ли разумному врачу разбора
// расспроса и осмотра; разбор называет трудность, в профиле — доля верных среди трудных, «Случай дня» — трудный по мере.
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { fnv1a } from '../../src/engine/core/hash';
import { Rng } from '../../src/engine/core/rng';
import { doorRow, EASY_ROW, HARD_ROW, hardnessOf, levelOf, ROW_P, SURE, TALK } from '../../src/engine/med/difficulty';
import { complaintObservations } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { contextOf, posterior } from '../../src/engine/med/infer';
import type { DoctorResult } from '../../src/engine/med/policy';
import { startRational } from '../../src/engine/med/policy';
import { reviewBeliefs } from '../../src/engine/med/review';
import { apply, candidatesOf, newShift, reviewOf } from '../../src/engine/shift/engine';
import type { ShiftPatient } from '../../src/engine/shift/types';
import { candidates, DEPARTMENT, hardnessText } from '../../src/state/caseView';
import {
  DAILY_PICK, DAILY_TRIES, dailyCaseSeed, dailyPicked, dailyPlay, dailySeed, dailyView, dailyVisit, forgetDaily, loadDaily, openDaily, pickDaily, prepareDaily,
  sanitizeDaily, seasonOfDay, setDailyStore,
} from '../../src/state/daily';
import { forgetProfile, loadProfile, profile, recordCases, sanitizeProfile, setProfileStore } from '../../src/state/profile';
import { practiceView } from '../../src/state/profileView';
import { memoryStore, saveSlot } from '../../src/state/saves';

const exams = Object.keys(db.exams).sort();
const therapy = candidatesOf(db, 'dept.therapy');

/** Мера по разумному врачу разбора — как у разбора: тем же зерном. */
function measure(seed: number, season: 'winter' | 'summer' = 'winter') {
  const patient = generatePatient(db, seed, { department: 'dept.therapy', season, walkIn: true });
  const door = reviewBeliefs(db, patient, therapy, complaintObservations(patient));
  const r = startRational(db, patient, Rng.seeded(seed).fork('review'), { candidates: [...therapy], exams: [...exams] }).result();
  return { patient, door, r, h: hardnessOf(db, patient, therapy, door, r) };
}

describe('трудность: мера', () => {
  test('уровень: лёгкий — ряд до трёх и хватает расспроса и осмотра; трудный — пять и больше, и мало; средний — остальное', () => {
    expect([EASY_ROW, HARD_ROW, ROW_P, SURE]).toEqual([3, 5, 0.05, 0.9]);
    expect([levelOf(1, true), levelOf(3, true), levelOf(4, true), levelOf(3, false), levelOf(5, true), levelOf(5, false), levelOf(8, false)])
      .toEqual(['easy', 'easy', 'medium', 'medium', 'medium', 'hard', 'hard']);
    expect([...TALK].sort()).toEqual(['ask', 'bedside', 'physical']);
    expect(doorRow([{ id: 'a', p: 0.6 }, { id: 'b', p: 0.05 }, { id: 'c', p: 0.049 }])).toBe(2);
  });

  test('ряд у двери — «Похоже на» по одним жалобам; расспроса и осмотра хватает — по пути разумного врача до первого анализа', () => {
    let talked = 0;
    let more = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const { patient, door, r, h } = measure(seed);
      expect(h.row).toBe(door.filter(b => b.p >= ROW_P).length);
      expect(h.solved).toBe(r.correct && r.confidence >= SURE);
      const k = r.exams.findIndex(id => !TALK.has(db.exams[id].kind));
      const before = new Set(k < 0 ? r.exams : r.exams.slice(0, k));
      const obs = r.observations.filter(o => o.exam === 'complaint' || before.has(o.exam));
      const truth = patient.truth.conditions[0].id;
      const sure = (posterior(db, therapy, obs, contextOf(db, patient, obs)).find(b => b.id === truth)?.p ?? 0) >= SURE;
      // весь путь — расспрос и осмотр: тогда — его решение
      expect(h.talk).toBe(k < 0 ? h.solved : sure);
      expect(h.level).toBe(levelOf(h.row, h.talk));
      if (h.talk) talked++;
      else more++;
    }
    expect(talked).toBeGreaterThan(5);
    expect(more).toBeGreaterThan(5);
  }, 60_000);

  test('расспроса и осмотра мало, если правду он узнал только анализом — и хватает, если до анализа уже уверен', () => {
    const { patient, door } = measure(3);
    const truth = patient.truth.conditions[0].id;
    const obs = complaintObservations(patient);
    const fake = (ex: string[], extra: DoctorResult['observations'], correct: boolean): DoctorResult => ({
      diagnosis: truth, correct, correctGroup: correct, confidence: 0.95, exams: ex, money: 0, minutes: 0, plan: { treatments: [], setting: 'home' }, observations: [...obs, ...extra],
    });
    // только жалобы до анализа — уверенности нет; анализ — и решил
    const lab = fake(['exam.cbc'], [], true);
    expect(hardnessOf(db, patient, therapy, door, lab).talk).toBe((posterior(db, therapy, obs, contextOf(db, patient, obs)).find(b => b.id === truth)?.p ?? 0) >= SURE);
    // только расспрос, решение верное и уверенное — хватает; неверное — нет
    expect(hardnessOf(db, patient, therapy, door, fake(['exam.ask_complaints'], [], true)).talk).toBe(true);
    expect(hardnessOf(db, patient, therapy, door, fake(['exam.ask_complaints'], [], false)).talk).toBe(false);
  });
});

/** Смена до первого в очереди и его приём: расспросить, поставить первую гипотезу, закрыть. */
function closeFirst(seed: number) {
  const s = newShift(db, { seed, season: 'winter' });
  for (let i = 0; i < 600 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
  const id = s.queue[0];
  apply(db, s, { kind: 'call', id });
  apply(db, s, { kind: 'exam', exam: 'exam.ask_complaints' });
  apply(db, s, { kind: 'diagnose', id: 'cond.arvi' });
  apply(db, s, { kind: 'finish' });
  if (s.current) {
    apply(db, s, { kind: 'setting', setting: 'home' });
    apply(db, s, { kind: 'finish' });
  }
  return { s, p: s.patients[id] };
}

describe('трудность: разбор и профиль', () => {
  test('у закрытого вашего приёма — трудность; разбор называет ту же', () => {
    const { s, p } = closeFirst(52);
    const h = p.closed!.hardness!;
    expect(h).toBeDefined();
    expect(reviewOf(db, s, p, p.closed!.diagnosis).hardness).toEqual(h);
    const line = hardnessText(h);
    expect(line.startsWith(`Случай ${({ easy: 'лёгкий', medium: 'средний', hard: 'трудный' })[h.level]}: по жалобам похоже на ${h.row} `)).toBe(true);
    expect(line).toContain(h.talk ? 'хватает расспроса и осмотра' : 'расспроса и осмотра мало');
  }, 30_000);

  test('строка разбора: лёгкий, трудный с обследованиями, трудный без уверенности', () => {
    expect(hardnessText({ level: 'easy', row: 2, talk: true, solved: true })).toBe('Случай лёгкий: по жалобам похоже на 2 болезни; разумному врачу хватает расспроса и осмотра.');
    expect(hardnessText({ level: 'hard', row: 6, talk: false, solved: true }))
      .toBe('Случай трудный: по жалобам похоже на 6 болезней; расспроса и осмотра мало — разумный врач решает его с обследованиями.');
    expect(hardnessText({ level: 'hard', row: 5, talk: false, solved: false }))
      .toBe('Случай трудный: по жалобам похоже на 5 болезней; расспроса и осмотра мало, и с обследованиями разумный врач до уверенности в верном диагнозе не дошёл.');
  });

  test('профиль: трудные — сколько встретилось и сколько верных; старый профиль — без них', async () => {
    const store = memoryStore();
    setProfileStore(store);
    forgetProfile();
    await loadProfile();
    const closed = (n: number, level: 'easy' | 'medium' | 'hard', verdict: 'correct' | 'wrong'): ShiftPatient => {
      const { p } = closeFirst(60 + n);
      return { ...p, id: `x-${n}`, closed: { ...p.closed!, verdict, hardness: { level, row: level === 'hard' ? 6 : 2, talk: level !== 'hard', solved: true } } };
    };
    recordCases([
      { seed: 1, department: 'dept.therapy', day: 1, patient: closed(1, 'hard', 'correct') },
      { seed: 1, department: 'dept.therapy', day: 1, patient: closed(2, 'hard', 'wrong') },
      { seed: 1, department: 'dept.therapy', day: 1, patient: closed(3, 'easy', 'correct') },
    ]);
    expect(profile().stats.hard).toEqual({ met: 2, correct: 1 });
    expect(practiceView(profile())!.hard).toEqual({ ok: 1, of: 2 });
    const old = sanitizeProfile({ stats: { cases: 3, correct: 2 } });
    expect(old.stats.hard).toEqual({ met: 0, correct: 0 });
    expect(practiceView(old)!.hard).toBeUndefined();
  }, 60_000);
});

describe('трудность: случай дня', () => {
  beforeEach(() => {
    const store = memoryStore();
    setProfileStore(store);
    setDailyStore(store);
    forgetProfile();
    forgetDaily();
  });

  test('случай дня — загадка: много болезней в ряду, правда — не первая в «Похоже на», решаемая, и разбор называет её трудной', async () => {
    await loadProfile();
    for (const day of ['2026-10-24', '2026-07-03', '2026-01-15']) {
      const seed = dailyCaseSeed(day);
      expect(dailyCaseSeed(day)).toBe(seed);
      openDaily(day);
      const v = dailyView();
      const patient = generatePatient(db, seed, { department: DEPARTMENT, season: seasonOfDay(day) });
      const truth = patient.truth.conditions[0].id;
      expect(v.hints.length).toBeGreaterThanOrEqual(HARD_ROW);
      expect(v.hints[0].id).not.toBe(truth);
      // решаемая: разумный врач разбора со всеми обследованиями ставит верный диагноз
      expect(startRational(db, patient, Rng.seeded(seed).fork('visit').fork('review'), { candidates: [...candidates()], exams: [...exams] }).result().correct).toBe(true);
      dailyVisit.act('exam.ask_complaints');
      dailyVisit.chooseDiagnosis(v.hints[0].id);
      dailyVisit.finish();
      expect(dailyView().decision!.hardness.startsWith('Случай трудный: по жалобам похоже на ')).toBe(true);
    }
  }, 120_000);

  test('подбор: у кого расспроса и осмотра хватило, врач дальше первого анализа не идёт — зерно то же, что по всему пути', () => {
    const cands = candidates();
    // по всему пути врача у каждой загадки: трудный и решаемый — верный диагноз в конце
    const fullPick = (day: string) => {
      for (let k = 0; k < DAILY_TRIES; k++) {
        const seed = k === 0 ? dailySeed(day) : fnv1a(`${dailySeed(day)}:${k}`);
        const patient = generatePatient(db, seed, { department: DEPARTMENT, season: seasonOfDay(day) });
        const door = reviewBeliefs(db, patient, cands, complaintObservations(patient));
        if (doorRow(door) < HARD_ROW || door[0].id === patient.truth.conditions[0].id) continue;
        const r = startRational(db, patient, Rng.seeded(seed).fork('visit').fork('review'), { candidates: [...cands], exams: [...exams] }).result();
        if (hardnessOf(db, patient, cands, door, r).level === 'hard' && r.correct) return seed;
      }
      return dailySeed(day);
    };
    for (const day of ['2026-11-02', '2026-12-30', '2026-05-17', '2026-08-08']) expect(dailyCaseSeed(day)).toBe(fullPick(day));
  }, 120_000);

  test('заранее — дни по порядку: прошлый день — после сегодняшнего', () => {
    const days = ['2026-04-04', '2026-04-03'];
    for (let i = 0; i < 100_000 && !dailyPicked(days[1]); i++) {
      prepareDaily(days, 0);
      if (!dailyPicked(days[0])) expect(dailyPicked(days[1])).toBe(false);
    }
    expect(days.map(d => dailyPicked(d))).toEqual([true, true]);
  }, 60_000);

  test('касание неподобранного дня не ждёт: подбор по частям каждый кадр, затем — открыть; ушли — подбор встал', async () => {
    const day = '2026-06-21';
    expect(dailyPicked(day)).toBe(false);
    let opened = 0;
    pickDaily(day, () => opened++)();
    await new Promise(res => setTimeout(res, 60));
    expect([dailyPicked(day), opened]).toEqual([false, 0]);
    await new Promise<void>(res => pickDaily(day, res));
    expect(dailyPicked(day)).toBe(true);
    expect(dailyCaseSeed(day)).toBe(dailyCaseSeed(day));
  }, 60_000);

  test('подбор по частям — тот же, что сразу; разные дни — разные случаи', () => {
    const day = '2026-03-09';
    for (let i = 0; i < 10_000; i++) prepareDaily(day, 0);
    const parts = dailyCaseSeed(day);
    expect(parts).toBe(dailyCaseSeed(day));
    expect(dailyCaseSeed('2026-03-10')).not.toBe(parts);
  }, 60_000);

  test('начатый приём, подобранный иначе (до 0.6.16), — заново; своего подбора — с того же места', async () => {
    await loadProfile();
    const day = '2026-10-20';
    const store = memoryStore();
    setDailyStore(store);
    forgetDaily();
    await saveSlot(store, 'daily', { [day]: { base: db.contentVersion, steps: [{ act: 'exam.ask_complaints' }] } }, 1, 'e2e');
    await loadDaily(new Date(2026, 9, 24));
    openDaily(day);
    expect(dailyView().done ?? []).not.toContain('exam.ask_complaints');
    dailyPlay.act('exam.ask_complaints');
    openDaily(day);
    expect(dailyView().done).toContain('exam.ask_complaints');
    expect(sanitizeDaily({ [day]: { base: 81, pick: DAILY_PICK, steps: [] } })[day].pick).toBe(DAILY_PICK);
  }, 60_000);
});

