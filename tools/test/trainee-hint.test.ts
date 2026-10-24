// Подсказка «Практиканту» (часть 94, spec 2026-10-trainee-hint, вопрос 57, вариант 2): «проверено N из M важного; не
// исключены K опасных причин» — по базе и тому, что врач узнал, без правды.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id } from '../../src/content/types';
import { Rng } from '../../src/engine/core/rng';
import { complaintObservations, NORMAL_SKILL, runExam } from '../../src/engine/med/exams';
import { generatePatient } from '../../src/engine/med/generate';
import { contextOf, priorWeight } from '../../src/engine/med/infer';
import { nextStep, type DoctorPhase } from '../../src/engine/med/policy';
import type { Patient } from '../../src/engine/med/types';
import { T } from '../../src/i18n';
import { type Arrival, candidates, DANGER_FLOOR, DANGER_GONE, makeCaseView } from '../../src/state/caseView';

const SEASONS = ['winter', 'spring', 'summer', 'autumn'] as const;
const CITY = ['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology', 'dept.infectious'];
const EXAMS = Object.keys(db.exams);

type Level = 'trainee' | 'student' | 'resident' | 'doctor';
const view = (p: Patient, difficulty: Level = 'trainee', arrived: Arrival[] = [], departments?: string[]) => makeCaseView({
  version: 0, patient: p, clock: 600, minutesSpent: 0, money: 0, step: arrived.length, arrived, pending: [], meanwhile: [],
  done: arrived.map(a => a.exam), draft: { treatments: [], setting: 'home' }, difficulty, ...(departments ? { departments } : {}),
});

/** Разумный врач без ошибок обследований, как у «Практиканта»: результаты — по шагам, приём за приёмом. */
function workup(p: Patient, departments: string[], each: (arrived: Arrival[]) => void): void {
  const obs = complaintObservations(p);
  const done: Id[] = [];
  const arrived: Arrival[] = [];
  const rng = Rng.seeded(p.seed).fork('hint');
  let phase: DoctorPhase = {};
  for (let i = 0; i < 40; i++) {
    const r = nextStep(db, p, obs, done, phase, { candidates: candidates(departments), exams: EXAMS, threshold: 0.9, minGain: 0.02 });
    phase = r.phase;
    if (r.step.kind === 'decide') return;
    const got = runExam(db, p, r.step.exam, rng.fork(`exam:${i}`), NORMAL_SKILL, true);
    obs.push(...got);
    done.push(r.step.exam);
    arrived.push({ exam: r.step.exam, step: i + 1, at: 600 + i, obs: got });
    each(arrived);
  }
}

describe('подсказка «Практиканту»: опасные причины жалобы', () => {
  test('только у «Практиканта» и только при жалобах', () => {
    const p = generatePatient(db, 5, { department: 'dept.therapy', season: 'winter', primary: 'cond.pneumonia_cap' });
    expect(p.complaints.length).toBeGreaterThan(0);
    expect(view(p).danger).toBeDefined();
    for (const level of ['student', 'resident', 'doctor'] as const) expect(view(p, level).danger).toBeUndefined();
    expect(view({ ...p, complaints: [] }).danger).toBeUndefined();
  });

  test('без правды: другой болезнью с теми же жалобами и находками — та же подсказка', () => {
    let compared = 0;
    for (let i = 0; i < 60; i++) {
      const p = generatePatient(db, 8_100_000 + i, { department: 'dept.therapy', departments: CITY, season: SEASONS[i % 4] });
      if (p.complaints.length === 0) continue;
      const arrived: Arrival[] = [];
      workup(p, CITY, a => {
        if (a.length <= 3) arrived.splice(0, arrived.length, ...a);
      });
      // правда — другая: болезнь, признаки и значения; жалобы — те же, с теми же подробностями
      const other: Patient = {
        ...p,
        truth: {
          ...p.truth,
          conditions: [{ id: p.truth.conditions[0].id === 'cond.arvi' ? 'cond.pneumonia_cap' : 'cond.arvi', role: 'primary' } as Patient['truth']['conditions'][0]],
          findings: p.truth.findings.filter(x => p.complaints.includes(x.f)),
          values: {},
        },
      };
      expect(view(other, 'trainee', arrived, CITY).danger).toEqual(view(p, 'trainee', arrived, CITY).danger!);
      compared++;
    }
    expect(compared).toBeGreaterThan(50);
  });

  test('опасные — угрожают жизни и бывают при этих жалобах хотя бы у 1 из 100; часть пациентов без них', () => {
    let none = 0;
    let some = 0;
    for (let i = 0; i < 200; i++) {
      const p = generatePatient(db, 8_200_000 + i, { department: 'dept.therapy', season: SEASONS[i % 4] });
      if (p.complaints.length === 0) continue;
      const d = view(p).danger!;
      expect(d.causes.every(x => db.conditions[x.id].severity === 'critical' && !x.excluded)).toBe(true);
      if (d.causes.length === 0) {
        none++;
        expect(d.important).toBe(0);
      } else {
        some++;
        expect(d.important).toBeGreaterThan(0);
        expect(d.checked).toBe(0);
      }
    }
    // в амбулатории опасного при жалобах чаще нет — так в замере части 94 (622 из 978)
    expect(none).toBeGreaterThan(some);
    expect(some).toBeGreaterThan(0);
    expect(DANGER_FLOOR).toBe(0.01);
    expect(DANGER_GONE).toBe(0.001);
  });

  test('проверено растёт с тем, что сделал врач; важное — без жалоб', () => {
    let grew = 0;
    for (let i = 0; i < 80; i++) {
      const p = generatePatient(db, 8_300_000 + i, { department: 'dept.therapy', season: SEASONS[i % 4] });
      if (p.complaints.length === 0 || view(p).danger!.causes.length === 0) continue;
      let last = 0;
      workup(p, ['dept.therapy'], a => {
        const d = view(p, 'trainee', a).danger!;
        expect(d.checked).toBeLessThanOrEqual(d.important);
        if (d.checked > last) grew++;
        last = Math.max(last, d.checked);
      });
    }
    expect(grew).toBeGreaterThan(10);
  });

  // настоящая болезнь, которая угрожает жизни и есть в списке, у разумного врача без ошибок не бывает «исключена»: так
  // в замере части 94 на 1000 пациентах амбулатории и 400 больницы главы 4; здесь — все такие болезни базы по три раза.
  // Болезнь задана заранее, и пациент может выйти таким, каким с ней не бывает (инсульт в 20 лет), — такие не в счёт
  test('настоящая опасная болезнь из списка не «исключена» ни на одном шаге; в списке — почти всегда', () => {
    const critical = candidates(CITY).filter(id => db.conditions[id].severity === 'critical');
    let seed = 0;
    let patients = 0;
    let listed = 0;
    for (const id of critical) {
      for (let k = 0; k < 3; k++) {
        const p = generatePatient(db, 8_400_000 + seed++, { department: db.conditions[id].department, departments: CITY, season: SEASONS[k], primary: id });
        if (p.complaints.length === 0 || p.truth.conditions[0].id !== id) continue;
        if (priorWeight(db, id, contextOf(db, p, complaintObservations(p))) === 0) continue;
        patients++;
        const start = view(p, 'trainee', [], CITY).danger!;
        if (start.causes.some(x => x.id === id)) listed++;
        workup(p, CITY, a => {
          const cause = view(p, 'trainee', a, CITY).danger!.causes.find(x => x.id === id);
          expect({ id, seed: p.seed, step: a.length, excluded: cause?.excluded ?? false }).toEqual({ id, seed: p.seed, step: a.length, excluded: false });
        });
      }
    }
    expect(patients).toBeGreaterThan(60);
    expect(listed / patients).toBeGreaterThan(0.8);
  }, 120_000);

  test('разумный врач чаще всего исключает опасное к концу приёма', () => {
    let listed = 0;
    let excluded = 0;
    for (let i = 0; i < 300; i++) {
      const p = generatePatient(db, 8_500_000 + i, { department: 'dept.therapy', season: SEASONS[i % 4] });
      if (p.complaints.length === 0 || view(p).danger!.causes.length === 0) continue;
      let end: Arrival[] = [];
      workup(p, ['dept.therapy'], a => {
        end = [...a];
      });
      const d = view(p, 'trainee', end).danger!;
      listed += d.causes.length;
      excluded += d.causes.filter(x => x.excluded).length;
    }
    expect(listed).toBeGreaterThan(30);
    expect(excluded / listed).toBeGreaterThan(0.5);
  }, 60_000);

  test('строка: проверено N из M важного; не исключены K опасных причин — с формами слов', () => {
    const t = T.spikes.patient;
    expect(t.danger(4, 11, 1, 2)).toBe('Проверено 4 из 11 важного; не исключена 1\u00a0опасная причина');
    expect(t.danger(4, 11, 2, 3)).toBe('Проверено 4 из 11 важного; не исключены 2\u00a0опасные причины');
    expect(t.danger(0, 20, 5, 5)).toBe('Проверено 0 из 20 важного; не исключены 5\u00a0опасных причин');
    expect(t.danger(6, 6, 0, 1)).toBe('Проверено 6 из 6 важного; опасная причина исключена');
    expect(t.danger(6, 9, 0, 2)).toBe('Проверено 6 из 9 важного; опасные причины исключены');
    expect(t.dangerOpen(1)).toBe('Не исключена');
    expect(t.dangerExcluded(2, 'сепсис, острый аппендицит')).toBe('Исключены: сепсис, острый аппендицит');
  });
});
