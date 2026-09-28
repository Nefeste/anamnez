// Профиль врача (src/state/profile.ts): имя и пол, статистика, архив последних 50 с разбором,
// «встречалось в практике». Приём попадает в профиль один раз; разбор из архива — тот же, что
// в смене; профиль, ещё не прочитанный с диска, не затирается.
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { apply, newShift } from '../../src/engine/shift/engine';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';
import { lookOf } from '../../src/render/look';
import {
  ARCHIVE_SIZE, caseKey, forgetProfile, loadProfile, PORTRAITS, PROFILE_SLOT, profile, profileSaved, recordCases, sanitizeProfile, setDoctor, setProfileStore,
} from '../../src/state/profile';
import { DOCTOR_AGE, DOCTOR_PORTRAITS, practiceLines, portraitSeed, rankLadder, rankName, rankOf } from '../../src/state/profileView';
import { loadSlot, memoryStore, saveSlot } from '../../src/state/saves';
import {
  archiveCaseView, callPatient, chooseDiagnosis, chooseSetting, examine, finishCase, forgetShift, loadShift, saved, setStore, shiftCaseView, shiftState,
  shiftView, startShift, tick, toggleTreatment,
} from '../../src/state/session';

let store = memoryStore();

beforeEach(async () => {
  store = memoryStore();
  setStore(store);
  setProfileStore(store);
  forgetShift();
  forgetProfile();
});

/** Закрыть в смене движка `n` приёмов подряд: первый в очереди, опрос, диагноз, домой. */
function closeCases(s: ShiftState, n: number): ShiftPatient[] {
  const out: ShiftPatient[] = [];
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < 600 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
    const id = s.queue[0];
    apply(db, s, { kind: 'call', id });
    apply(db, s, { kind: 'exam', exam: 'exam.ask_complaints' });
    apply(db, s, { kind: 'diagnose', id: 'cond.arvi' });
    apply(db, s, { kind: 'toggleTreatment', id: 'tx.rest_fluids' });
    apply(db, s, { kind: 'finish' });
    out.push(s.patients[id]);
  }
  return out;
}

const asRecords = (s: ShiftState, ps: ShiftPatient[]) => ps.map(p => ({ seed: s.meta.seed, department: s.meta.department, day: 1, patient: p }));

describe('профиль: хранение', () => {
  test('пустой; имя и пол врача пишутся и читаются после перезапуска', async () => {
    await loadProfile();
    expect(profile().doctor).toBeUndefined();
    expect(profile().stats.cases).toBe(0);
    await setDoctor({ first: ' Анна ', last: 'Петрова', sex: 'f' });
    await profileSaved();
    forgetProfile();
    await loadProfile();
    expect(profile().doctor).toEqual({ first: 'Анна', last: 'Петрова', sex: 'f' });
  });

  test('испорченные поля — пустыми, остальное цело; запись архива без итога отброшена', () => {
    const p = sanitizeProfile({
      doctor: { first: 'Анна', last: 'Петрова', sex: 'x' },
      stats: { cases: 3, correct: 'два', grades: { A: 1, B: -4 } },
      seen: { 'cond.arvi': 2, 'cond.flu': 'ой' },
      archive: [{ key: 'k', seed: 1, department: 'dept.therapy', day: 1, patient: { id: 'p1' } }],
    });
    expect(p.doctor).toBeUndefined();
    expect(p.stats).toMatchObject({ cases: 3, correct: 0, grades: { A: 1, B: 0, C: 0, D: 0 } });
    expect(p.seen).toEqual({ 'cond.arvi': 2 });
    expect(p.archive).toEqual([]);
    expect(sanitizeProfile('мусор').stats.cases).toBe(0);
  });
});

describe('профиль: приёмы', () => {
  test('приём — в профиль один раз: статистика, «встречалось», архив новыми первыми', async () => {
    await loadProfile();
    const s = newShift(db, { seed: 5, season: 'winter' });
    const ps = closeCases(s, 3);
    expect(recordCases(asRecords(s, ps))).toBe(3);
    expect(recordCases(asRecords(s, ps))).toBe(0);
    const pr = profile();
    expect(pr.stats.cases).toBe(3);
    expect(pr.stats.correct + pr.stats.partly + pr.stats.wrong).toBe(3);
    expect(Object.values(pr.stats.grades).reduce((a, b) => a + b, 0)).toBe(3);
    expect(pr.stats.money).toBe(ps.reduce((m, p) => m + p.spent.money, 0));
    for (const p of ps) for (const c of p.patient.truth.conditions) expect(pr.seen[c.id]).toBeGreaterThan(0);
    expect(pr.archive.map(r => r.key)).toEqual([...ps].reverse().map(p => caseKey(5, p.id)));
  });

  test('архив — последние 50', async () => {
    await loadProfile();
    const s = newShift(db, { seed: 7, season: 'winter' });
    const [p] = closeCases(s, 1);
    // 55 разных приёмов из одного: ключ — зерно и номер
    recordCases(Array.from({ length: 55 }, (_, i) => ({ seed: 1000 + i, department: s.meta.department, day: 1, patient: p })));
    expect(profile().archive.length).toBe(ARCHIVE_SIZE);
    expect(profile().archive[0].seed).toBe(1054);
    expect(profile().stats.cases).toBe(55);
  });

  test('профиль ещё не прочитан — приёмы ждут, файл не затирается', async () => {
    await saveSlot(store, PROFILE_SLOT, { doctor: { first: 'Анна', last: 'Петрова', sex: 'f' }, stats: { cases: 7 }, seen: {}, archive: [] }, 1, 'x');
    const s = newShift(db, { seed: 9, season: 'winter' });
    const ps = closeCases(s, 2);
    expect(recordCases(asRecords(s, ps))).toBe(0);
    await loadProfile();
    await profileSaved();
    expect(profile().doctor?.first).toBe('Анна');
    expect(profile().stats.cases).toBe(9);
    const onDisk = await loadSlot<{ stats: { cases: number } }>(store, PROFILE_SLOT);
    expect(onDisk!.envelope.data.stats.cases).toBe(9);
  });
});

describe('профиль и смена', () => {
  /** Часы до первого в очереди. */
  function untilQueue() {
    for (let i = 0; i < 180 && shiftView().queue.length === 0; i++) tick(1000);
  }

  test('смена пишет приём в профиль; разбор из архива — тот же, что в смене; перечитанная смена не удваивает', async () => {
    await loadProfile();
    startShift(6, 'winter', 'student');
    untilQueue();
    const id = shiftView().queue[0].id;
    callPatient(id);
    examine('exam.ask_complaints');
    chooseDiagnosis(shiftCaseView()!.hints[0].id);
    toggleTreatment('tx.rest_fluids');
    chooseSetting('ward');
    finishCase();
    const key = caseKey(shiftState()!.meta.seed, id);
    expect(profile().archive[0].key).toBe(key);
    expect(profile().stats.cases).toBe(1);
    const inShift = shiftCaseView()!.decision!;
    const fromArchive = archiveCaseView(key)!.decision!;
    expect(fromArchive).toEqual(inShift);

    await saved();
    forgetShift();
    await loadShift();
    expect(profile().stats.cases).toBe(1);
  });
});

describe('профиль: портрет, звание, статистика (spec 2026-09-profile, часть 16)', () => {
  test('портрет пишется и читается; неверный — без портрета; звание — по числу приёмов, лестница без «осталось»', async () => {
    await loadProfile();
    await setDoctor({ first: 'Анна', last: 'Петрова', sex: 'f', portrait: 4 });
    await profileSaved();
    forgetProfile();
    await loadProfile();
    expect(profile().doctor).toEqual({ first: 'Анна', last: 'Петрова', sex: 'f', portrait: 4 });
    expect(sanitizeProfile({ doctor: { first: 'А', last: 'Б', sex: 'm', portrait: 99 } }).doctor).toEqual({ first: 'А', last: 'Б', sex: 'm' });
    expect([0, 24, 25, 99, 100, 299, 300, 5000].map(rankOf)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect([rankName(0), rankName(25), rankName(100), rankName(300)]).toEqual(['Интерн', 'Ординатор', 'Врач', 'Врач высшей категории']);
    expect(rankLadder()).toBe('Звание растёт с принятыми пациентами: интерн → ординатор (25) → врач (100) → врач высшей категории (300).');
  });

  test('портреты врача-женщины — все с длинными волосами разного цвета (0.0.31); у каждого пола — шесть', () => {
    const women = DOCTOR_PORTRAITS.f.map(seed => lookOf(seed, 'f', DOCTOR_AGE));
    expect(women.every(l => l.long)).toBe(true);
    expect(new Set(women.map(l => l.hair)).size).toBe(PORTRAITS);
    expect([DOCTOR_PORTRAITS.f.length, DOCTOR_PORTRAITS.m.length]).toEqual([PORTRAITS, PORTRAITS]);
    // номер портрета — в наборе своего пола; без номера — первый
    expect(portraitSeed({ first: 'А', last: 'Б', sex: 'f', portrait: 2 })).toBe(DOCTOR_PORTRAITS.f[2]);
    expect(portraitSeed({ first: 'А', last: 'Б', sex: 'm' })).toBe(DOCTOR_PORTRAITS.m[0]);
  });

  test('минуты, антибиотик по показаниям и опасное — из закрытых приёмов; прежний профиль — с нулями', async () => {
    await loadProfile();
    const s = newShift(db, { seed: 21, season: 'winter' });
    // три приёма: ангина с амоксициллином (показан), ОРВИ с амоксициллином (не показан), ОКС домой и в скорую
    const see = (dx: string, tx: string[], setting: 'home' | 'ward' | 'ambulance', truth?: string) => {
      for (let i = 0; i < 600 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
      const id = s.queue[0];
      const p = s.patients[id];
      if (truth) p.patient.truth.conditions = [{ ...p.patient.truth.conditions[0], id: truth, role: 'primary' }];
      apply(db, s, { kind: 'call', id });
      apply(db, s, { kind: 'exam', exam: 'exam.ask_complaints' });
      apply(db, s, { kind: 'diagnose', id: dx });
      for (const t of tx) apply(db, s, { kind: 'toggleTreatment', id: t });
      apply(db, s, { kind: 'setting', setting });
      apply(db, s, { kind: 'finish' });
      return s.patients[id];
    };
    const cases = [
      see('cond.strep_pharyngitis', ['tx.amoxicillin'], 'home', 'cond.strep_pharyngitis'),
      see('cond.arvi', ['tx.amoxicillin'], 'home', 'cond.arvi'),
      see('cond.acs', ['tx.aspirin_acs'], 'ambulance', 'cond.acs'),
      see('cond.arvi', ['tx.rest_fluids'], 'home', 'cond.acs'),
    ];
    recordCases(asRecords(s, cases));
    const st = profile().stats;
    expect(st.antibiotics).toEqual({ given: 2, indicated: 1 });
    expect(st.danger).toEqual({ met: 2, caught: 1 });
    expect([st.timed, st.minutes]).toEqual([4, cases.reduce((a, p) => a + Math.round(p.spent.seconds / 60), 0)]);
    expect(practiceLines(profile())).toContain('Антибиотик по показаниям — 1 из 2\u00a0назначений');
    expect(practiceLines(profile())).toContain('Нужны были стационар или скорая — направлено 1 из 2');
    expect(practiceLines(profile()).some(l => /^В среднем на приём — \d+ мин$/.test(l))).toBe(true);
    // профиль до 0.0.30 — без новых счётчиков: нули, и строк о них нет
    const old = sanitizeProfile({ stats: { cases: 5, correct: 5 } });
    expect([old.stats.timed, old.stats.antibiotics.given, old.stats.danger.met]).toEqual([0, 0, 0]);
    expect(practiceLines(old).some(l => l.startsWith('В среднем') || l.startsWith('Антибиотик') || l.startsWith('Нужны'))).toBe(false);
  });
});
