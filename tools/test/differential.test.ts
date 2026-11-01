// Дифференциальный ряд игрока (FR-DX-7, spec 2026-10-differential, 0.5.8): гипотезы с доводами «за» и «против», «не
// проверено» и «чем подтвердить» — по модели вывода, без правды; ряд — в черновике приёма смены и «Случая дня»;
// уверенность — у «Практиканта» и «Студента», у «Врача» её нет.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { evidenceFor, PRO_MIN, PRO_RATIO, TYPICAL, UNCHECKED_MAX } from '../../src/engine/med/differential';
import { generatePatient } from '../../src/engine/med/generate';
import { contextOf, findingProbability } from '../../src/engine/med/infer';
import type { Observation } from '../../src/engine/med/types';
import { apply, current, newShift } from '../../src/engine/shift/engine';
import type { ShiftState } from '../../src/engine/shift/types';
import { T } from '../../src/i18n';
import { makeCaseView, staleHypotheses } from '../../src/state/caseView';
import { createVisit } from '../../src/state/visit';

const PNEUMONIA = 'cond.pneumonia_cap';
const seen = (f: string, shown: boolean, exam: string): Observation => ({ f, shown, exam });
const patient = { sex: 'm' as const, age: 40, season: 'winter' as const, complaints: ['sym.cough', 'sym.fever_hx', 'sym.headache', 'sym.photophobia'] };
// кашель, температура, головная боль и светобоязнь со слов; хрипов при аускультации нет
const obs: Observation[] = [
  ...patient.complaints.map(f => seen(f, true, 'complaint')),
  seen('sign.crackles_local', false, 'exam.lung_auscultation'),
];

describe('доводы за гипотезу и против неё', () => {
  const ctx = contextOf(db, patient, obs);
  const ev = evidenceFor(db, PNEUMONIA, obs, ctx, patient, ['exam.lung_auscultation']);
  const withH = (f: string) => findingProbability(db, f, [PNEUMONIA], []);
  const without = (f: string) => findingProbability(db, f, [], []);

  test('«за» — найденное, что при гипотезе хотя бы вдвое чаще и на 10 из 100: кашель, температура, головная боль', () => {
    expect(ev.pro.map(x => x.f)).toEqual(['sym.cough', 'sym.fever_hx', 'sym.headache']);
    for (const x of ev.pro) {
      expect(x.p).toBeCloseTo(withH(x.f), 10);
      expect(x.p >= PRO_RATIO * without(x.f) && x.p - without(x.f) >= PRO_MIN).toBe(true);
    }
  });

  test('«против» — найденное, чего она не объясняет (светобоязнь), и типичное, которого нет (хрипы — у половины)', () => {
    expect(ev.con.map(x => [x.f, x.kind])).toEqual([['sym.photophobia', 'unexplained'], ['sign.crackles_local', 'absent']]);
    expect(ev.con[1].p).toBeGreaterThanOrEqual(TYPICAL);
    // светобоязнь — редкость и без пневмонии, и с ней
    expect(without('sym.photophobia')).toBeLessThan(0.3);
  });

  test('«не проверено» — самые частые при ней признаки, которых не искали; у каждого — самое дешёвое обследование', () => {
    expect(ev.unchecked.length).toBe(UNCHECKED_MAX);
    expect(ev.unchecked.slice(0, 2)).toEqual([
      { f: 'img.cxr_infiltrate', p: withH('img.cxr_infiltrate'), exam: 'exam.xray_chest' },
      { f: 'lab.crp_high', p: withH('lab.crp_high'), exam: 'exam.crp' },
    ]);
    const checked = new Set([...obs.map(o => o.f), ...db.exams['exam.lung_auscultation'].checks.map(c => c.f)]);
    for (const [i, x] of ev.unchecked.entries()) {
      expect(x.p).toBeGreaterThanOrEqual(TYPICAL);
      expect(checked.has(x.f)).toBe(false);
      if (i > 0) expect(x.p).toBeLessThanOrEqual(ev.unchecked[i - 1].p);
      if (x.exam) expect(db.exams[x.exam].checks.some(c => c.f === x.f)).toBe(true);
    }
    // сделали обследование — его признаки проверены, даже если строки о них нет
    const vitals = evidenceFor(db, PNEUMONIA, obs, ctx, patient, ['exam.lung_auscultation', 'exam.vitals']);
    expect(vitals.unchecked.some(x => x.f.startsWith('vital.'))).toBe(false);
  });

  test('правды движок не берёт: у больного и у здорового с теми же наблюдениями доводы одни', () => {
    const sick = generatePatient(db, 41, { department: 'dept.therapy', season: 'winter' });
    const other = { ...sick, truth: { ...sick.truth, conditions: [{ id: 'cond.migraine', params: {} }] } };
    const a = evidenceFor(db, PNEUMONIA, obs, contextOf(db, sick, obs), sick, []);
    const b = evidenceFor(db, PNEUMONIA, obs, contextOf(db, other, obs), other, []);
    expect(a).toEqual(b);
  });
});

/** Смена: первый из очереди в кабинете. */
function inRoom(): ShiftState {
  const s = newShift(db, { seed: 5, season: 'winter', difficulty: 'doctor' });
  for (let i = 0; i < 120 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
  apply(db, s, { kind: 'call', id: s.queue[0] });
  return s;
}

describe('ряд в черновике приёма', () => {
  test('смена: гипотеза — в конец ряда, второй раз — убрана; не из отделений больницы и не у того, кто в кабинете, — нет', () => {
    const s = inRoom();
    const p = current(s)!;
    const time = s.t;
    apply(db, s, { kind: 'hypothesis', id: PNEUMONIA });
    apply(db, s, { kind: 'hypothesis', id: 'cond.arvi' });
    expect(p.draft.hypotheses).toEqual([PNEUMONIA, 'cond.arvi']);
    apply(db, s, { kind: 'hypothesis', id: PNEUMONIA });
    expect(p.draft.hypotheses).toEqual(['cond.arvi']);
    // перелом лодыжки — травматология: в амбулатории его не поставить и в ряд не добавить; времени ряд не тратит
    apply(db, s, { kind: 'hypothesis', id: 'cond.ankle_fracture' });
    expect(p.draft.hypotheses).toEqual(['cond.arvi']);
    expect(s.t).toBe(time);
    apply(db, s, { kind: 'diagnose', id: 'cond.arvi' });
    apply(db, s, { kind: 'finish' });
    apply(db, s, { kind: 'hypothesis', id: PNEUMONIA });
    expect(p.draft.hypotheses).toEqual(['cond.arvi']);
  });

  test('«Случай дня»: тот же ряд; после решения не меняется', () => {
    const v = createVisit(77);
    v.toggleHypothesis(PNEUMONIA);
    v.toggleHypothesis('cond.arvi');
    expect(v.view().differential.map(h => h.id)).toEqual([PNEUMONIA, 'cond.arvi']);
    v.toggleHypothesis(PNEUMONIA);
    expect(v.view().differential.map(h => h.id)).toEqual(['cond.arvi']);
    v.chooseDiagnosis('cond.arvi');
    v.finish();
    v.toggleHypothesis(PNEUMONIA);
    expect(v.view().differential.map(h => h.id)).toEqual(['cond.arvi']);
  });

  // часть 105 (spec 2026-10-publish-ready, просьба владельца 01.11.2026): убрать из ряда то, чего нет в «Похоже на»
  test('«Обновить гипотезы»: выпавшие из «Похоже на» — по порядку ряда; без «Похоже на» — нечего обновлять', () => {
    const v = createVisit(77);
    v.act('exam.ask_complaints');
    const likely = v.view().hints.map(h => h.id);
    const other = v.view().diagnoses.flatMap(g => g.items.map(c => c.id)).filter(id => !likely.includes(id)).slice(0, 2);
    expect(likely.length > 0 && other.length === 2).toBe(true);
    for (const id of [other[0], likely[0], other[1]]) v.toggleHypothesis(id);
    expect(staleHypotheses(v.view())).toEqual(other);
    for (const id of staleHypotheses(v.view())) v.toggleHypothesis(id);
    expect(v.view().differential.map(h => h.id)).toEqual([likely[0]]);
    expect(staleHypotheses(v.view())).toEqual([]);
    expect(staleHypotheses({ ...v.view(), hints: [] })).toEqual([]);
  });
});

describe('карточка гипотезы в карте пациента', () => {
  const p = generatePatient(db, 41, { department: 'dept.therapy', season: 'winter' });
  const view = (difficulty: 'trainee' | 'student' | 'doctor', done: string[] = []) => makeCaseView({
    version: 0, patient: p, clock: 600, minutesSpent: 0, money: 0, step: 0, arrived: [], pending: [], meanwhile: [], done,
    draft: { treatments: [], setting: 'home', hypotheses: [PNEUMONIA, 'cond.arvi'] }, difficulty,
  });

  test('уверенность — у «Практиканта» и «Студента» та же, что в «Похоже на»; у «Врача» её нет, доводы — те же', () => {
    const student = view('student');
    expect(student.differential.map(h => h.id)).toEqual([PNEUMONIA, 'cond.arvi']);
    for (const h of student.hints) {
      const row = student.differential.find(x => x.id === h.id);
      if (row) expect(row.outOf10).toBe(h.outOf10);
    }
    expect(view('trainee').differential.every(h => h.outOf10 !== undefined)).toBe(true);
    const doctor = view('doctor');
    expect(doctor.differential.every(h => h.outOf10 === undefined)).toBe(true);
    expect(doctor.differential.map(({ outOf10: _, ...h }) => h)).toEqual(student.differential.map(({ outOf10: _, ...h }) => h));
  });

  test('чем подтвердить: у пневмонии — снимок, сделан или нет; у ОРВИ — клинически', () => {
    const [pneumonia, arvi] = view('doctor').differential;
    // значок (0.6.8): снимок не сделан — неизвестно
    expect(pneumonia.confirm).toEqual([{ name: db.exams['exam.xray_chest'].name.ru, done: false, exam: 'exam.xray_chest', state: 'unknown' }]);
    expect(view('doctor', ['exam.xray_chest']).differential[0].confirm[0].done).toBe(true);
    expect(arvi.confirm).toEqual([]);
    expect(arvi.clinical).toBe(true);
  });

  test('строки: «за» — как часто при ней, «против» — чего нет или что не объяснить, «не проверено» — чем искать', () => {
    const t = T.spikes.differential;
    expect(t.pro('Кашель', 8)).toBe('Кашель — у 8 из 10 с этой болезнью');
    expect(t.absent('Влажные хрипы', 5)).toBe('Влажные хрипы — нет, а у 5 из 10 с этой болезнью есть');
    expect(t.unexplained('Светобоязнь')).toBe('Светобоязнь — этой болезнью не объяснить');
    expect(t.unchecked('Инфильтрат', 10, 'рентген грудной клетки')).toBe('Инфильтрат — у 10 из 10 с этой болезнью; ищут: рентген грудной клетки');
    const pneumonia = view('doctor').differential[0];
    expect(pneumonia.unchecked.length).toBeGreaterThan(0);
    expect(pneumonia.unchecked[0].text).toContain(`; ищут: ${db.exams['exam.xray_chest'].name.ru.toLowerCase().slice(0, 1)}`);
    // инфильтрат — у 95 из 100: «у 9 из 10», а не «у 10 из 10» — «всегда» обещает только 995 из 1000
    expect(pneumonia.unchecked[0].text).toStartWith(`${db.findings['img.cxr_infiltrate'].name.ru} — у 9 из 10`);
    // значок довода (0.6.8): не проверено — неизвестно, признак — тот, о котором строка
    expect(pneumonia.unchecked[0]).toMatchObject({ f: 'img.cxr_infiltrate', state: 'unknown' });
  });
});
