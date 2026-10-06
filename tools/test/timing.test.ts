// Сроки разумного врача (spec 2026-10-chapter-3, часть 46а): срок решения — от находки, за вычетом минут после
// неё, и вопросы о противопоказаниях к лечению идущего срока — в нём; срок, который иначе не успеть, — сразу,
// только сначала — когда началось; срок, который ничего не решает, не торопит. С частью 46б — из обследований срока
// то, что успеет к его концу (и по времени этой больницы), а срок первого контакта, который уже не успеть, не
// держит другой.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, runExam } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import type { Plan, Venue } from '../../src/engine/med/plan';
import { decisionLimit, type DoctorPhase, examMinutes, nextStep, ORDER_MINUTES } from '../../src/engine/med/policy';
import type { Observation, Patient } from '../../src/engine/med/types';
import { candidatesOf } from '../../src/engine/shift/engine';

const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology'];
const BAY: Venue = { bedside: ['eq.monitor_defib'], icu: true, ward: true };
const STE = 'ecg.st_elevation';
const ECG = 'exam.ecg';
const NEURO = 'exam.neuro_exam';
const CT = ['exam.ct_head', 'exam.cta_head'];
const STROKE_SIGNS = ['sym.weakness_one_side', 'sym.speech_trouble', 'sym.face_droop'];
const cands = candidatesOf(db, ED);
const exams = Object.keys(db.exams).sort();

const minutesOf = (done: readonly Id[]) => done.reduce((a, id) => a + examMinutes(db.exams[id]), 0);
/** Шаги разумного врача до решения; минуты с прихода — по сделанным обследованиям и `before` до первого (сортировка, вызов). */
function run(p: Patient, venue: Venue, before = 0): { done: Id[]; plan: Plan; diagnosis: Id; obs: Observation[] } {
  const obs: Observation[] = complaintObservations(p);
  const done: Id[] = [];
  let phase: DoctorPhase = {};
  const rng = Rng.seeded(p.seed).fork('doctor');
  for (let k = 0; k < 40; k++) {
    const r = nextStep(db, p, obs, done, phase, { candidates: cands, exams, threshold: 0.9, minGain: 0.02, venue: { ...venue, minutes: before + minutesOf(done) } });
    phase = r.phase;
    if (r.step.kind === 'decide') return { done, plan: r.step.plan, diagnosis: r.step.diagnosis, obs };
    obs.push(...runExam(db, p, r.step.exam, rng.fork(`${k}`)));
    done.push(r.step.exam);
  }
  throw new Error('врач не решил');
}
/** `n` больных болезнью `primary` подряд от зерна `from`, для которых верно `ok`. */
function people(n: number, primary: Id, ok: (p: Patient) => boolean, params: Record<string, string> = {}, from = 1): Patient[] {
  const out: Patient[] = [];
  for (let seed = from; out.length < n; seed++) {
    const p = generatePatient(db, seed, { department: db.conditions[primary].department, departments: ED, season: 'winter', primary, params });
    if (p.age >= db.conditions[primary].age.min && ok(p)) out.push(p);
  }
  return out;
}

describe('срок решения — от находки', () => {
  test('подъём ST — тромболизис в 10 минут от ЭКГ: после неё прошло 4 минуты — осталось 6', () => {
    const obs: Observation[] = [{ f: STE, shown: true, exam: ECG }];
    expect(decisionLimit(db, obs)).toBe(10);
    expect(decisionLimit(db, obs, [], 0, () => 4)).toBe(6);
  });

  test('инфаркт с подъёмом ST под монитором: расспрос перед тромболизисом — всегда, решение — в 10 минут после ЭКГ', () => {
    const runs = people(60, 'cond.acs', p => p.complaints.includes('sym.chest_pain_pressing'), { type: 'stemi' })
      .map(p => run(p, BAY))
      .filter(r => r.obs.some(o => o.f === STE && o.shown));
    expect(runs.length).toBeGreaterThan(50);
    for (const r of runs) {
      expect(r.diagnosis).toBe('cond.acs');
      expect(r.done).toContain('exam.ask_lysis');
    }
    const inTime = runs.filter(r => minutesOf(r.done.slice(r.done.indexOf(ECG) + 1)) <= 10);
    expect(inTime.length / runs.length).toBeGreaterThan(0.95);
    expect(runs.filter(r => r.plan.treatments.includes('tx.thrombolysis')).length).toBeGreaterThan(30);
  }, 30_000);
});

describe('срок, который иначе не успеть', () => {
  test('КТ при подозрении на инсульт: осмотр, когда началось, сразу КТ — с заключением в 40 минут; остальной расспрос — потом', () => {
    const strokes = people(40, 'cond.stroke_ischemic', p => p.complaints.some(f => STROKE_SIGNS.includes(f)) && !p.complaints.includes('sym.chest_pain_pressing'));
    for (const p of strokes) {
      const { done } = run(p, BAY);
      expect(done.slice(0, 2)).toEqual([NEURO, 'exam.ask_stroke']);
      expect(CT).toContain(done[2]);
      expect(minutesOf(done.slice(0, 3))).toBeLessThanOrEqual(40);
    }
  }, 30_000);
});

describe('срок — тем, что успеет (часть 46б)', () => {
  const strokes = () => people(30, 'cond.stroke_ischemic', p => p.complaints.some(f => STROKE_SIGNS.includes(f)) && !p.complaints.includes('sym.chest_pain_pressing'));

  test('сортировка и вызов отняли две минуты: КТ-ангиография после вопроса о начале к 40-й минуте не успеет — КТ сразу после осмотра', () => {
    for (const p of strokes()) {
      const { done } = run(p, BAY, 2);
      expect(done.slice(0, 2)).toEqual([NEURO, 'exam.ct_head']);
      expect(2 + minutesOf(done.slice(0, 2)) + ORDER_MINUTES).toBeLessThanOrEqual(40);
    }
  }, 30_000);

  test('врач освободился на седьмой минуте: осмотр в 10 минут уже не успеть — сначала назначить КТ, осмотр сразу после', () => {
    for (const p of strokes()) {
      const { done } = run(p, BAY, 7);
      expect(done.slice(0, 2)).toEqual(['exam.ct_head', NEURO]);
    }
  }, 30_000);

  test('томограф этой больницы медленнее записанного: КТ-ангиография не успеет — КТ без вопроса о начале', () => {
    // КТ-ангиография здесь — 40 минут до заключения, КТ — 30
    const ready = (id: Id) => (id === 'exam.cta_head' ? 40 : id === 'exam.ct_head' ? 30 : undefined);
    for (const p of strokes()) {
      const { done } = run(p, { ...BAY, ready });
      expect(done.slice(0, 2)).toEqual([NEURO, 'exam.ct_head']);
    }
  }, 30_000);
});

describe('срок, который ничего не решает', () => {
  test('подъём ST у больного с ТИА без инфаркта: срок решения есть, но врач не торопится — КТ, как всем', () => {
    const [p] = people(1, 'cond.tia', x => x.complaints.includes('sym.transient_speech') || x.complaints.includes('sym.transient_weakness'));
    const rng = Rng.seeded(p.seed).fork('ложный подъём');
    const done = [ECG, NEURO, 'exam.ask_chronic', 'exam.ask_tia'];
    const obs: Observation[] = [...complaintObservations(p), { f: STE, shown: true, exam: ECG }];
    for (const id of done.slice(1)) obs.push(...runExam(db, p, id, rng.fork(id)));
    // подъём ST — тромболизис в 10 минут; КТ с заключением — 25, не успеть
    expect(decisionLimit(db, obs, p.complaints)).toBe(10);
    const step = nextStep(db, p, obs, done, {}, { candidates: cands, exams, threshold: 0.9, minGain: 0.02, venue: { ...BAY, minutes: minutesOf(done) } }).step;
    expect(step.kind).toBe('exam');
    expect(CT).toContain(step.kind === 'exam' ? step.exam : '');
  });
});
