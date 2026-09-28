// Достижения (spec 2026-09-campaign, часть 13): условие каждого вида; новые — только ещё не
// полученные, по порядку записи; приём и день засчитываются один раз; дата и что принесло —
// в профиле и переживают перезапуск; строка — на итоге приёма и в итогах дня.
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { achieved, type CareerFacts, caseFacts, newAchievements } from '../../src/engine/career/achievements';
import { apply, newShift } from '../../src/engine/shift/engine';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';
import {
  achievementsBy, caseKey, type DayRecord, forgetProfile, loadProfile, profile, profileSaved, recordCases, recordDay, sanitizeProfile, setProfileStore,
} from '../../src/state/profile';
import { achievementCount, achievementGroups } from '../../src/state/profileView';
import { memoryStore } from '../../src/state/saves';
import {
  callPatient, chooseDiagnosis, closeDay, examine, finishCase, forgetShift, setStore, shiftCaseView, shiftView, skipIdle, startShift, toggleTreatment,
} from '../../src/state/session';

const facts = (x: Partial<CareerFacts> = {}): CareerFacts => ({
  cases: 0, days: 0, run: 0, gradeA: 0, thrift: 0, allergy: 0, noLeftDays: 0, daily: 0, seen: {}, rooms: [], chapters: [], ...x,
});
const ach = (id: string) => db.achievements[id];

/** Закрыть в смене движка первый в очереди приём: опрос, ОРВИ, режим и питьё, домой. */
function closeOne(s: ShiftState): ShiftPatient {
  for (let i = 0; i < 600 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
  const id = s.queue[0];
  apply(db, s, { kind: 'call', id });
  apply(db, s, { kind: 'exam', exam: 'exam.ask_complaints' });
  apply(db, s, { kind: 'diagnose', id: 'cond.arvi' });
  apply(db, s, { kind: 'toggleTreatment', id: 'tx.rest_fluids' });
  apply(db, s, { kind: 'finish' });
  return s.patients[id];
}

describe('достижения: условия', () => {
  test('виды «сколько раз» — по своим счётчикам', () => {
    expect(achieved(db, ach('ach.first_patient'), facts({ cases: 1 }))).toBe(true);
    expect(achieved(db, ach('ach.first_patient'), facts())).toBe(false);
    expect(achieved(db, ach('ach.run_10'), facts({ run: 9 }))).toBe(false);
    expect(achieved(db, ach('ach.run_10'), facts({ run: 10 }))).toBe(true);
    expect(achieved(db, ach('ach.month'), facts({ days: 30 }))).toBe(true);
    expect(achieved(db, ach('ach.grade_a_10'), facts({ gradeA: 10 }))).toBe(true);
    expect(achieved(db, ach('ach.thrift_1'), facts({ thrift: 1 }))).toBe(true);
    expect(achieved(db, ach('ach.allergy_10'), facts({ allergy: 9 }))).toBe(false);
    expect(achieved(db, ach('ach.no_left'), facts({ noLeftDays: 1 }))).toBe(true);
    expect(achieved(db, ach('ach.daily_7'), facts({ daily: 6 }))).toBe(false);
    expect(achieved(db, ach('ach.daily_7'), facts({ daily: 7 }))).toBe(true);
    const ten = Object.fromEntries(Object.keys(db.conditions).slice(0, 10).map(id => [id, 1]));
    expect(achieved(db, ach('ach.seen_10'), facts({ seen: ten }))).toBe(true);
    expect(achieved(db, ach('ach.seen_10'), facts({ seen: { ...ten, [Object.keys(ten)[0]]: 0 } }))).toBe(false);
  });

  test('вся терапия — все болезни, с которыми приходят; помещение — работает в закрытый день; глава — выполнена', () => {
    const therapy = Object.values(db.conditions).filter(c => c.presenting && c.department === 'dept.therapy').map(c => c.id);
    const all = Object.fromEntries(therapy.map(id => [id, 1]));
    expect(achieved(db, ach('ach.therapy'), facts({ seen: all }))).toBe(true);
    expect(achieved(db, ach('ach.therapy'), facts({ seen: { ...all, [therapy[0]]: 0 } }))).toBe(false);
    expect(achieved(db, ach('ach.lab'), facts({ rooms: ['room.lab'] }))).toBe(true);
    expect(achieved(db, ach('ach.xray'), facts({ rooms: ['room.lab'] }))).toBe(false);
    expect(achieved(db, ach('ach.district'), facts({ chapters: ['chapter.district'] }))).toBe(true);
  });

  test('новые — только ещё не полученные, по порядку записи', () => {
    const f = facts({ cases: 50, days: 1, run: 5 });
    expect(newAchievements(db, f, {})).toEqual(['ach.first_patient', 'ach.first_shift', 'ach.cases_50', 'ach.run_5']);
    expect(newAchievements(db, f, { 'ach.first_patient': 1, 'ach.cases_50': 1 })).toEqual(['ach.first_shift', 'ach.run_5']);
  });

  test('приём: верный, на A, бережливый; вопрос об аллергии — если назначено лекарство', () => {
    const x = structuredClone(closeOne(newShift(db, { seed: 5, season: 'winter' })));
    Object.assign(x.closed!, { verdict: 'correct' });
    Object.assign(x.closed!.grades, { thrift: 'A', overall: 'A' });
    expect(caseFacts(db, x)).toEqual({ correct: true, gradeA: true, thrift: true, allergy: false });
    x.closed!.plan.treatments = ['tx.amoxicillin'];
    expect(caseFacts(db, x).allergy).toBe(false);
    x.done = [...x.done, 'exam.ask_allergies'];
    expect(caseFacts(db, x).allergy).toBe(true);
    x.closed!.plan.treatments = ['tx.rest_fluids'];
    expect(caseFacts(db, x).allergy).toBe(false);
    Object.assign(x.closed!, { verdict: 'partly' });
    expect(caseFacts(db, x)).toMatchObject({ correct: false, thrift: false });
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

describe('достижения в профиле', () => {
  test('первый приём — «Первый пациент» с датой и ключом приёма; тот же приём второй раз ничего не даёт', async () => {
    await loadProfile();
    const s = newShift(db, { seed: 5, season: 'winter' });
    const p = closeOne(s);
    recordCases([{ seed: 5, department: s.meta.department, day: 1, patient: p }]);
    const key = caseKey(5, p.id);
    expect(achievementsBy(key)).toContain('ach.first_patient');
    const got = profile().achievements.got['ach.first_patient'];
    expect(got.by).toBe(key);
    expect(Number.isNaN(Date.parse(got.at))).toBe(false);
    recordCases([{ seed: 5, department: s.meta.department, day: 1, patient: p }]);
    expect(profile().achievements.got['ach.first_patient']).toEqual(got);
    expect(achievementCount(profile()).got).toBe(Object.keys(profile().achievements.got).length);
  });

  test('верные подряд: неверный обнуляет счёт; пятый верный подряд — «Пять верных подряд»', async () => {
    await loadProfile();
    const base = closeOne(newShift(db, { seed: 5, season: 'winter' }));
    const rec = (i: number, verdict: 'correct' | 'wrong') => {
      const p = structuredClone(base);
      p.id = `1-${i}`;
      Object.assign(p.closed!, { verdict });
      recordCases([{ seed: 77, department: 'dept.therapy', day: 1, patient: p }]);
    };
    for (let i = 0; i < 4; i++) rec(i, 'correct');
    rec(4, 'wrong');
    expect(profile().achievements.run).toBe(0);
    for (let i = 5; i < 10; i++) rec(i, 'correct');
    expect(profile().achievements.run).toBe(5);
    expect(profile().achievements.got['ach.run_5'].by).toBe(caseKey(77, '1-9'));
  });

  test('день — один раз по ключу: рабочий, приняли всех, работающая лаборатория, выполненная глава', async () => {
    await loadProfile();
    const day = (key: string, x: Partial<DayRecord> = {}) => recordDay({ key, seen: 5, noLeft: false, rooms: [], chapters: [], ...x });
    expect(day('shift:1:1')).toEqual(['ach.first_shift']);
    expect(day('shift:1:1')).toEqual([]);
    expect(profile().achievements.days).toBe(1);
    expect(day('sandbox:2:1', { noLeft: true, rooms: ['room.lab', 'room.office'] })).toEqual(['ach.no_left', 'ach.lab']);
    expect(day('campaign:3:12', { chapters: ['chapter.district'] })).toEqual(['ach.district']);
    expect(day('shift:1:2', { seen: 0 })).toEqual([]);
    expect(profile().achievements.days).toBe(3);
    expect(achievementsBy('sandbox:2:1')).toEqual(['ach.no_left', 'ach.lab']);
  });

  test('полученное и счётчики переживают перезапуск; испорченные поля — пустыми', async () => {
    await loadProfile();
    recordDay({ key: 'shift:1:1', seen: 3, noLeft: true, rooms: [], chapters: [] });
    await profileSaved();
    forgetProfile();
    await loadProfile();
    expect(Object.keys(profile().achievements.got)).toEqual(['ach.first_shift', 'ach.no_left']);
    expect(profile().achievements).toMatchObject({ days: 1, noLeftDays: 1, closedDays: ['shift:1:1'] });
    const p = sanitizeProfile({ achievements: { got: { 'ach.run_5': { at: 'x', by: 'k' }, bad: 3 }, run: -2, closedDays: ['a', 5] } });
    expect(p.achievements).toMatchObject({ got: { 'ach.run_5': { at: 'x', by: 'k' } }, run: 0, closedDays: ['a'] });
    expect(sanitizeProfile({}).achievements.got).toEqual({});
  });

  test('профиль ещё не прочитан — день ждёт чтения', async () => {
    expect(recordDay({ key: 'shift:9:1', seen: 2, noLeft: false, rooms: [], chapters: [] })).toEqual([]);
    await loadProfile();
    expect(profile().achievements.got['ach.first_shift']?.by).toBe('shift:9:1');
  });

  test('список в профиле: группы по порядку, у полученного — дата, у остального — что нужно', async () => {
    await loadProfile();
    recordDay({ key: 'shift:1:1', seen: 3, noLeft: false, rooms: [], chapters: [] });
    const groups = achievementGroups(profile());
    expect(groups.map(g => g.key)).toEqual(['practice', 'diagnosis', 'care', 'knowledge', 'hospital', 'campaign', 'daily']);
    expect(groups.flatMap(g => g.items).length).toBe(Object.keys(db.achievements).length);
    const [first, shift] = groups[0].items;
    expect([first.id, first.got, first.need]).toEqual(['ach.first_patient', undefined, ach('ach.first_patient').need.ru]);
    expect(shift.got).toMatch(/^Получено \d\d\.\d\d\.\d{4}$/);
  });
});

describe('достижения в смене', () => {
  test('первый приём — строка на итоге приёма; закрытый день — в итогах дня', async () => {
    await loadProfile();
    startShift(6, 'winter', 'student');
    skipIdle();
    callPatient(shiftView().queue[0].id);
    examine('exam.ask_complaints');
    chooseDiagnosis(shiftCaseView()!.hints[0].id);
    toggleTreatment('tx.rest_fluids');
    finishCase();
    expect(shiftCaseView()!.achievements).toContain('Первый пациент');
    closeDay();
    expect(shiftView().summary!.achievements).toContain('Первая смена');
  });
});

describe('достижения и прежняя практика', () => {
  test('профиль из версии до достижений: по приёмам и болезням — сразу при чтении, без строки у следующего приёма', async () => {
    const { PROFILE_SLOT, EARLIER } = await import('../../src/state/profile');
    const { saveSlot } = await import('../../src/state/saves');
    const seen = Object.fromEntries(Object.keys(db.conditions).slice(0, 12).map(id => [id, 2]));
    await saveSlot(store, PROFILE_SLOT, { stats: { cases: 60 }, seen, archive: [] }, 1, 'x');
    await loadProfile();
    const got = profile().achievements.got;
    expect(Object.keys(got)).toEqual(['ach.first_patient', 'ach.cases_50', 'ach.seen_10']);
    expect(Object.values(got).every(g => g.by === EARLIER)).toBe(true);
    const p = closeOne(newShift(db, { seed: 5, season: 'winter' }));
    recordCases([{ seed: 5, department: 'dept.therapy', day: 1, patient: p }]);
    expect(achievementsBy(caseKey(5, p.id))).not.toContain('ach.first_patient');
  });
});
