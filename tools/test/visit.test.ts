// Приём пациента прототипа П4 (spec 2026-09-spikes): модуль грузится, часы идут делами,
// результаты приходят в свой срок, правда видна только в разборе после диагноза.
import { describe, expect, test } from 'bun:test';
import { act, conditionChoices, diagnose, examInfo, examsByAction, nextPatient, visitView, waitForResults } from '../../src/state/visit';

describe('приём', () => {
  test('разделы действий делят обследования без пересечений', () => {
    const by = examsByAction();
    const all = [...by.ask, ...by.examine, ...by.order];
    expect(new Set(all).size).toBe(all.length);
    expect(by.ask).toContain('exam.ask_complaints');
    expect(by.examine).toContain('exam.lung_auscultation');
    expect(by.order).toContain('exam.xray_chest');
    expect(examInfo('exam.xray_chest').minutes).toBeGreaterThan(examInfo('exam.throat').minutes);
    expect(conditionChoices().map(c => c.id)).toContain('cond.pneumonia_cap');
  });

  test('первый пациент готов при загрузке модуля', () => {
    const v = visitView();
    expect(v.clock).toBe('08:00');
    expect(v.complaints.length).toBeGreaterThan(0);
    expect(v.results).toEqual([]);
    expect(v.decision).toBeUndefined();
  });

  test('осмотр сразу даёт результат, анализ — позже; ожидание двигает часы', () => {
    act('exam.lung_auscultation');
    const a = visitView();
    expect(a.minutesSpent).toBe(examInfo('exam.lung_auscultation').minutes);
    expect(a.results.some(l => l.exam === 'exam.lung_auscultation')).toBe(true);

    act('exam.cbc');
    const b = visitView();
    expect(b.pending.map(p => p.name)).toContain(examInfo('exam.cbc').name);
    expect(b.results.some(l => l.exam === 'exam.cbc')).toBe(false);
    expect(b.money).toBeGreaterThan(a.money);

    act('exam.cbc'); // повтор не проводится и не стоит денег
    expect(visitView().money).toBe(b.money);

    waitForResults();
    const c = visitView();
    expect(c.pending).toEqual([]);
    expect(c.results.some(l => l.exam === 'exam.cbc')).toBe(true);
    expect(c.minutesSpent).toBeGreaterThan(b.minutesSpent);
    expect(c.meanwhile.join(' ')).toContain(examInfo('exam.cbc').name);
  });

  test('диагноз закрывает приём и открывает разбор', () => {
    const before = visitView();
    expect(before.hints.length).toBeGreaterThan(0);
    const guess = before.hints[0].id;
    diagnose(guess);
    const d = visitView().decision!;
    expect(d.diagnosis).toBe(guess);
    expect(['correct', 'partly', 'wrong']).toContain(d.verdict);
    expect(d.truthName.length).toBeGreaterThan(0);
    expect(d.outOf10).toBeGreaterThanOrEqual(0);
    expect(d.outOf10).toBeLessThanOrEqual(10);

    act('exam.xray_chest'); // после диагноза обследования не проводятся
    expect(visitView().done).not.toContain('exam.xray_chest');
  });

  test('следующий пациент начинает приём заново', () => {
    const prev = visitView().title;
    nextPatient();
    const v = visitView();
    expect(v.decision).toBeUndefined();
    expect(v.clock).toBe('08:00');
    expect(v.done).toEqual([]);
    expect(v.title).not.toBe(prev);
  });
});
