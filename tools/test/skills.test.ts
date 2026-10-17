// Специальности и умения врача (spec 2026-10-skills, часть 75; spec 2026-09-profile, часть 17): опыт — верные диагнозы
// отделения (почти верный — половина), уровни по порогам 10, 40, 100, 250, умения — по уровням, небольшие и выключаемые.
// Смене — умения дня: новое — со следующего дня; у нанятых врачей, «Виртуального врача» и «Случая дня» их нет.
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { askMinutes, examSkillWith, levelOf, mentorOf, pointsFor, skillsFor, specialtiesOf, toNextLevel } from '../../src/engine/career/skills';
import { Rng } from '../../src/engine/core/rng';
import { NORMAL_SKILL, runExam } from '../../src/engine/med/exams';
import { typicalPatient } from '../../src/engine/med/generate';
import { apply, newShift } from '../../src/engine/shift/engine';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';
import { T } from '../../src/i18n';
import { forgetProfile, loadProfile, profile, recordCases, sanitizeProfile, setProfileStore } from '../../src/state/profile';
import { skillRows, specialtyRows } from '../../src/state/profileView';
import { memoryStore } from '../../src/state/saves';
import { callPatient, forgetShift, playerSkills, setStore, shiftCaseView, shiftState, shiftView, startShift, tick } from '../../src/state/session';
import { DEFAULTS, setSettingsStore, updateSettings } from '../../src/state/settings';

const HEARING = 'skill.therapy_hearing';
const QUESTIONS = 'skill.therapy_questions';
const MENTOR = 'skill.therapy_mentor';

beforeEach(() => {
  const store = memoryStore();
  setStore(store);
  setProfileStore(store);
  setSettingsStore(store);
  forgetShift();
  forgetProfile();
});

describe('специальности', () => {
  test('отделения игры в порядке глав — терапия, хирургия, травма, неврология, инфекции; у каждой — название', () => {
    expect(specialtiesOf(db)).toEqual(['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology', 'dept.infectious']);
    for (const d of specialtiesOf(db)) expect(T.profile.specialty[d]).toBeDefined();
  });

  test('уровни — по порогам 10, 40, 100, 250; до следующего; очки — верный 1, почти верный 0,5, неверный 0', () => {
    expect([0, 9.5, 10, 39.5, 40, 99.5, 100, 249.5, 250, 1000].map(levelOf)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    expect([0, 9.5, 10, 250].map(toNextLevel)).toEqual([10, 0.5, 30, 0]);
    expect([pointsFor('correct'), pointsFor('partly'), pointsFor('wrong')]).toEqual([1, 0.5, 0]);
  });

  test('умения — по уровням: терапия 2 — слух, 3 — опрос, 4 — наставник; хирургия, травма, неврология, инфекции — со второго', () => {
    expect(skillsFor(db, {})).toEqual([]);
    expect(skillsFor(db, { 'dept.therapy': 10 })).toEqual([HEARING]);
    expect(skillsFor(db, { 'dept.therapy': 100 })).toEqual([MENTOR, QUESTIONS, HEARING].sort((a, b) => db.skills[a].level - db.skills[b].level));
    expect(skillsFor(db, { 'dept.surgery': 10, 'dept.neurology': 9.5 })).toEqual(['skill.surgery_hands']);
    for (const d of specialtiesOf(db)) expect(Object.values(db.skills).some(x => x.department === d && x.level === 2)).toBe(true);
  });
});

/** Закрыть в смене движка `n` приёмов подряд: первый в очереди, опрос, диагноз ОРВИ, домой. */
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

describe('профиль', () => {
  test('опыт — по отделению настоящей болезни: верный — 1, почти верный — 0,5, неверный — ничего', async () => {
    await loadProfile();
    const s = newShift(db, { seed: 75, season: 'winter' });
    const ps = closeCases(s, 6);
    recordCases(ps.map(p => ({ seed: s.meta.seed, department: s.meta.department, day: 1, patient: p })));
    const want: Record<string, number> = {};
    for (const p of ps) {
      const dept = db.conditions[p.patient.truth.conditions[0].id].department;
      const x = pointsFor(p.closed!.verdict);
      if (x > 0) want[dept] = (want[dept] ?? 0) + x;
    }
    expect(Object.keys(want).length).toBeGreaterThan(0);
    expect(profile().experience).toEqual(want);
  });

  test('профиль до 0.5.18 — опыт по доле встреченных болезней отделения, с точностью до половины; сохранённый — как есть', () => {
    const old = sanitizeProfile({ stats: { correct: 30, partly: 10 }, seen: { 'cond.arvi': 30, 'cond.cholecystitis': 10 } });
    // 35 очков: терапии — 30 из 40 встреч, хирургии — 10
    expect(old.experience).toEqual({ 'dept.therapy': 26, 'dept.surgery': 8.5 });
    expect(sanitizeProfile({}).experience).toEqual({});
    expect(sanitizeProfile({ experience: { 'dept.therapy': 12.5, 'dept.surgery': -3 } }).experience).toEqual({ 'dept.therapy': 12.5 });
  });

  test('в профиле — специальности с уровнем и сколько до следующего, умения строкой', () => {
    const rows = specialtyRows({ experience: { 'dept.therapy': 37.5 } });
    expect(rows[0]).toEqual({ department: 'dept.therapy', name: 'Терапия', level: 'уровень 2', hint: 'до следующего — 3 верных диагноза', points: 37.5, from: 10, of: 40 });
    expect([rows[1].name, rows[1].level, rows[1].from, rows[1].of]).toEqual(['Хирургия', 'уровень 1', 0, 10]);
    const top = specialtyRows({ experience: { 'dept.therapy': 300 } })[0];
    expect([top.hint, top.from, top.of]).toEqual(['высший уровень', 250, undefined]);
    expect(skillRows({ experience: { 'dept.therapy': 10 } })).toEqual([{ id: HEARING, line: '«Внимательный слух»: выслушивание лёгких на 10 п. п. чувствительнее.' }]);
  });
});

describe('умения в медицине', () => {
  test('«Внимательный слух»: тот же бросок, другой порог — хрипы при пневмонии слышны чаще; без умений — как прежде', () => {
    const ps = Array.from({ length: 1000 }, (_, i) => typicalPatient(db, k => 75_000 + i * 31 + k, { department: 'dept.therapy', season: 'winter', primary: 'cond.pneumonia_cap' }));
    const heard = (skills: string[]) => {
      let has = 0;
      let shown = 0;
      for (const p of ps) {
        if (!p.truth.findings.some(f => f.f === 'sign.crackles_local')) continue;
        has++;
        const obs = runExam(db, p, 'exam.lung_auscultation', Rng.seeded(p.seed).fork('ausc'), examSkillWith(db, skills, 'exam.lung_auscultation', NORMAL_SKILL));
        if (obs.some(o => o.f === 'sign.crackles_local' && o.shown)) shown++;
      }
      return { has, share: shown / has };
    };
    const without = heard([]);
    const withSkill = heard([HEARING]);
    expect(without.has).toBeGreaterThan(300);
    expect(withSkill.share - without.share).toBeGreaterThan(0.05);
    expect(examSkillWith(db, [], 'exam.lung_auscultation', NORMAL_SKILL)).toBe(NORMAL_SKILL);
    expect(examSkillWith(db, [HEARING], 'exam.heart_auscultation', NORMAL_SKILL)).toBe(NORMAL_SKILL);
  });

  test('«Быстрый опрос»: вопрос на минуту короче, не меньше минуты; осмотр — как в базе; «Наставник» — терапевтам вдвое', () => {
    expect(askMinutes(db, [QUESTIONS], db.exams['exam.ask_food'], 2)).toBe(1);
    expect(askMinutes(db, [QUESTIONS], db.exams['exam.ask_complaints'], 1)).toBe(1);
    expect(askMinutes(db, [QUESTIONS], db.exams['exam.general_exam'], 3)).toBe(3);
    expect(askMinutes(db, [], db.exams['exam.ask_food'], 2)).toBe(2);
    expect([mentorOf(db, [MENTOR], 'role.therapist'), mentorOf(db, [MENTOR], 'role.surgeon'), mentorOf(db, [], 'role.therapist')]).toEqual([2, 1, 1]);
  });
});

describe('смена', () => {
  test('умения дня — в состоянии смены: в начале игры сразу, новые — со следующего дня, в сохранении — те же', () => {
    const s = newShift(db, { seed: 76, season: 'winter' });
    apply(db, s, { kind: 'skills', ids: [HEARING], today: true });
    expect(s.meta.skills).toEqual([HEARING]);
    apply(db, s, { kind: 'skills', ids: [HEARING, QUESTIONS] });
    expect([s.meta.skills, s.meta.skillsNext]).toEqual([[HEARING], [HEARING, QUESTIONS]]);
    apply(db, s, { kind: 'advance', seconds: 13 * 3600 });
    apply(db, s, { kind: 'closeDay' });
    apply(db, s, { kind: 'nextDay' });
    expect([s.meta.skills, s.meta.skillsNext]).toEqual([[HEARING, QUESTIONS], undefined]);
    // выключили — завтра без них
    apply(db, s, { kind: 'skills', ids: [] });
    expect(s.meta.skillsNext).toEqual([]);
    const copy = JSON.parse(JSON.stringify(s)) as ShiftState;
    expect(copy.meta.skills).toEqual([HEARING, QUESTIONS]);
  });

  test('игра начинается с умениями профиля; выключены в настройках — без них', async () => {
    await loadProfile();
    const s0 = newShift(db, { seed: 77, season: 'winter' });
    recordCases(closeCases(s0, 12).map(p => ({ seed: s0.meta.seed, department: s0.meta.department, day: 1, patient: p })));
    const skills = skillsFor(db, profile().experience);
    expect(playerSkills()).toEqual(skills);
    startShift(78, 'winter');
    expect(shiftState()!.meta.skills).toEqual(skills.length > 0 ? skills : undefined);
    updateSettings({ skills: false });
    expect(playerSkills()).toEqual([]);
    expect(DEFAULTS.skills).toBe(true);
  });

  test('с «Быстрым опросом» в списке обследований — настоящие минуты вопросов, у осмотра — как в базе', async () => {
    await loadProfile();
    startShift(79, 'winter');
    apply(db, shiftState()!, { kind: 'skills', ids: [QUESTIONS], today: true });
    for (let i = 0; i < 180 && shiftView().queue.length === 0; i++) tick(1000);
    callPatient(shiftView().queue[0].id);
    const v = shiftCaseView()!;
    expect(v.minutes?.['exam.ask_food']).toBe(askMinutes(db, [QUESTIONS], db.exams['exam.ask_food'], 2));
    expect(v.minutes?.['exam.ask_food']).toBe(1);
    expect(v.minutes?.['exam.general_exam']).toBeUndefined();
  });
});
