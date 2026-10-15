// Аллергия, о которой пациент не сказал (0.5.12, отзыв на 0.5.11): врач спросил «Аллергии», а пациент об аллергии не
// знал или не вспомнил — разбор не пишет «вы не спросили» и не снижает оценку безопасности; ответ «нет» о пенициллинах
// — о пенициллинах, а не обо всех лекарствах.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { generatePatient } from '../../src/engine/med/generate';
import { evaluatePlan, type Plan } from '../../src/engine/med/plan';
import { scoreCase } from '../../src/engine/med/score';
import type { Observation, Patient } from '../../src/engine/med/types';
import { T } from '../../src/i18n';

/** Пациент терапии с аллергией на пенициллины. */
function allergic(): Patient {
  for (let seed = 1; seed < 5000; seed++) {
    const p = generatePatient(db, seed, { department: 'dept.therapy', season: 'winter' });
    if (p.truth.risks.includes('risk.allergy_penicillin')) return p;
  }
  throw new Error('нет пациента с аллергией на пенициллины');
}

const PLAN: Plan = { treatments: ['tx.amoxicillin'], setting: 'home' };

function score(p: Patient, obs: Observation[]) {
  const ev = evaluatePlan(db, p, PLAN, obs);
  return scoreCase({ verdict: 'correct', confidence: 0.9, cost: 10, rationalCost: 10, plan: ev, outcome: { kind: 'improved', day: 7, cured: true }, selfLimiting: false, redFlags: [] });
}

const answer = (shown: boolean): Observation => ({ f: 'hx.allergy_penicillin', shown, exam: 'exam.ask_allergies' });

describe('аллергия, о которой пациент не сказал', () => {
  test('спросили, а пациент сказал «нет» — без упрёка и без снижения безопасности', () => {
    const p = allergic();
    const s = score(p, [answer(false)]);
    expect(s.notes).toContainEqual({ code: 'safety.deniedViolation', tx: 'tx.amoxicillin', by: 'risk.allergy_penicillin' });
    expect(s.notes.some(n => n.code === 'safety.unaskedViolation')).toBe(false);
    expect(s.safety).toBe('A');
  });

  test('не спросили — «вы не спросили, а оно было»; знали — «и вы об этом знали»', () => {
    const p = allergic();
    const unasked = score(p, []);
    expect(unasked.notes).toContainEqual({ code: 'safety.unaskedViolation', tx: 'tx.amoxicillin', by: 'risk.allergy_penicillin' });
    expect(unasked.safety).toBe('C');
    const known = score(p, [answer(true)]);
    expect(known.notes).toContainEqual({ code: 'safety.knownViolation', tx: 'tx.amoxicillin', by: 'risk.allergy_penicillin' });
    expect(known.safety).toBe('D');
  });

  test('строка разбора — что спросили и что так бывает', () => {
    const line = T.spikes.patient.note.deniedViolation('Амоксициллин', 'Аллергия на пенициллины');
    expect(line).toStartWith('Амоксициллин: противопоказано (аллергия на пенициллины) — вы спросили, но пациент о нём не сказал');
    expect(line).not.toContain('не спросили');
  });

  test('ответ «нет» о пенициллинах — о пенициллинах: рядом может быть аллергия на НПВС', () => {
    const absent = db.findings['hx.allergy_penicillin'].texts.absent?.map(t => t.ru) ?? [];
    expect(absent.length).toBeGreaterThan(0);
    for (const t of absent) {
      expect(t).toContain('пенициллин');
      expect(t).not.toMatch(/лекарств/);
    }
  });
});
