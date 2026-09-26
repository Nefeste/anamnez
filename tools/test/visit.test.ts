// Приём пациента прототипа П4 (spec 2026-09-spikes): модуль грузится, часы идут делами,
// результаты приходят в свой срок, правда видна только в разборе после диагноза.
import { describe, expect, test } from 'bun:test';
import { act, conditionChoices, conditionTerm, diagnose, examInfo, examsByAction, examTerm, findingInfo, nextPatient, visitView, waitForResults } from '../../src/state/visit';

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

  test('новые результаты — сверху и помечены, до следующего действия', () => {
    act('exam.vitals');
    const a = visitView();
    expect(a.groups[0].exam).toBe('exam.vitals');
    expect(a.groups[0].fresh).toBe(true);
    expect(a.groups.slice(1).every(g => !g.fresh)).toBe(true);
    expect(a.freshCount).toBe(a.groups[0].lines.length);

    act('exam.crp'); // результат позже — нового пока ничего
    const b = visitView();
    expect(b.freshCount).toBe(0);
    expect(b.groups.every(g => !g.fresh)).toBe(true);

    waitForResults();
    const c = visitView();
    expect(c.groups[0].exam).toBe('exam.crp');
    expect(c.groups[0].fresh).toBe(true);
    expect(new Set(c.groups.map(g => g.key)).size).toBe(c.groups.length);
  });

  test('«Что это?»: признак, обследование и болезнь объясняются из базы', () => {
    const f = findingInfo('sign.crackles_local');
    expect(f.text[0]).toContain('треск');
    expect(f.list?.items).toContain(examInfo('exam.lung_auscultation').name);
    const e = examTerm('exam.cbc');
    expect(e.text.length).toBe(2);
    expect(e.list?.items.length).toBeGreaterThan(0);
    expect(conditionTerm('cond.pneumonia_cap').text[0].length).toBeGreaterThan(20);
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
