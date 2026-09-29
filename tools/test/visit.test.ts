// Приём пациента прототипа П4 (spec 2026-09-spikes): модуль грузится, часы идут делами,
// результаты приходят в свой срок, правда видна только в разборе после диагноза.
import { describe, expect, test } from 'bun:test';
import { outcomeText } from '../../src/state/caseView';
import { act, chooseDiagnosis, chooseSetting, conditionChoices, conditionTerm, diagnosisGroups, examInfo, examsByAction, examTerm, findingInfo, finish, nextPatient, toggleTreatment, treatmentTerm, visitView, waitForResults } from '../../src/state/visit';

describe('приём', () => {
  test('разделы действий делят обследования без пересечений', () => {
    const by = examsByAction({ sex: 'f', age: 30, complaints: [] });
    const all = [...by.ask, ...by.examine, ...by.order];
    expect(new Set(all).size).toBe(all.length);
    expect(by.ask).toContain('exam.ask_complaints');
    expect(by.examine).toContain('exam.lung_auscultation');
    expect(by.order).toContain('exam.xray_chest');
    expect(examInfo('exam.xray_chest').minutes).toBeGreaterThan(examInfo('exam.throat').minutes);
    expect(conditionChoices().map(c => c.id)).toContain('cond.pneumonia_cap');
  });

  test('о месячных и беременности спрашивают женщин детородного возраста, а не мужчину и не женщину 73 лет', () => {
    const woman = examsByAction({ sex: 'f', age: 30, complaints: [] });
    expect(woman.ask).toContain('exam.ask_pregnancy');
    expect(woman.order).toContain('exam.pregnancy_test');
    for (const who of [{ sex: 'm', age: 73 }, { sex: 'm', age: 30 }, { sex: 'f', age: 73 }] as const) {
      const by = examsByAction({ ...who, complaints: [] });
      expect(by.ask).not.toContain('exam.ask_pregnancy');
      expect(by.order).not.toContain('exam.pregnancy_test');
      // остальное — как у всех
      expect(by.ask).toContain('exam.ask_onset');
    }
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

  test('решение: без диагноза приём не завершить; диагноз, лечение и место меняются до конца', () => {
    finish(); // без диагноза — ничего
    expect(visitView().decision).toBeUndefined();
    const guess = visitView().hints[0].id;
    chooseDiagnosis(guess);
    toggleTreatment('tx.amoxicillin');
    toggleTreatment('tx.rest_fluids');
    toggleTreatment('tx.amoxicillin'); // снова — снимает
    chooseSetting('ward');
    chooseSetting('home');
    expect(visitView().draft).toEqual({ diagnosis: guess, treatments: ['tx.rest_fluids'], setting: 'home' });
    expect(visitView().decision).toBeUndefined();
    act('exam.throat'); // до «Завершить» обследовать ещё можно
    expect(visitView().done).toContain('exam.throat');
  });

  test('«Завершить приём»: правда, исход, оценки, план с ролями и разбор', () => {
    const guess = visitView().draft.diagnosis!;
    finish();
    const d = visitView().decision!;
    expect(d.diagnosis).toBe(guess);
    expect(['correct', 'partly', 'wrong']).toContain(d.verdict);
    expect(d.truthName.length).toBeGreaterThan(0);
    expect(d.outcome.length).toBeGreaterThan(0);
    expect(d.grades.map(g => g.key)).toEqual(['accuracy', 'defensibility', 'thrift', 'treatment', 'setting', 'safety']);
    expect(['A', 'B', 'C', 'D']).toContain(d.overall);
    expect(d.plan).toEqual([{ name: 'Режим и обильное питьё', role: expect.any(String) }]);
    expect(d.timeline[0].label).toBe('Жалобы');
    expect(d.timeline.length).toBe(visitView().groups.length + 1);
    expect(d.rational.length).toBeGreaterThan(0);

    act('exam.xray_chest'); // после завершения обследования не проводятся
    expect(visitView().done).not.toContain('exam.xray_chest');
    toggleTreatment('tx.macrolide'); // и план не меняется
    expect(visitView().draft.treatments).toEqual(['tx.rest_fluids']);
  });

  test('решение: диагнозы по системам органов, лечение по группам — каждый ровно один раз', () => {
    const dx = diagnosisGroups();
    expect(dx.map(g => g.key)).toEqual(['airways', 'lungs', 'heart', 'digestive', 'urinary', 'metabolic', 'nerves']);
    const dxIds = dx.flatMap(g => g.items.map(c => c.id));
    expect(dxIds.sort()).toEqual(conditionChoices().map(c => c.id).sort());
    expect(dx.find(g => g.key === 'lungs')!.items.map(c => c.id)).toContain('cond.pneumonia_cap');
    const v = visitView();
    const txIds = v.treatmentGroups.flatMap(g => g.items.map(x => x.id));
    expect(txIds.sort()).toEqual(v.treatments.map(x => x.id).sort());
    const group = (tx: string) => v.treatmentGroups.find(g => g.items.some(x => x.id === tx))!.key;
    expect(group('tx.amoxicillin')).toBe('antibiotics');
    expect(group('tx.fosfomycin')).toBe('antibiotics');
    expect(group('tx.nasal_saline')).toBe('nose');
    expect(group('tx.aspirin_acs')).toBe('heart');
    expect(group('tx.rest_fluids')).toBe('regimen');
    expect(v.treatmentGroups.every(g => g.title.length > 0)).toBe(true);
  });

  test('«Что это?» у лечения; всё лечение базы в выборе', () => {
    expect(visitView().treatments.map(x => x.id)).toContain('tx.amoxicillin');
    expect(treatmentTerm('tx.amoxicillin').text[0]).toContain('пенициллин');
  });

  test('следующий пациент начинает приём заново', () => {
    const prev = visitView().title;
    nextPatient();
    const v = visitView();
    expect(v.decision).toBeUndefined();
    expect(v.draft).toEqual({ treatments: [], setting: 'home' });
    expect(v.clock).toBe('08:00');
    expect(v.done).toEqual([]);
    expect(v.title).not.toBe(prev);
  });

  test('рентген и ЭКГ — картинкой: сторона инфильтрата — как в протоколе снимка, частота — по пульсу', () => {
    let found = false;
    for (let i = 0; i < 200 && !found; i++) {
      nextPatient();
      act('exam.xray_chest');
      for (let k = 0; k < 3 && visitView().pending.length > 0; k++) waitForResults();
      found = visitView().results.some(l => l.f === 'img.cxr_infiltrate' && l.shown);
    }
    expect(found).toBe(true);
    const xray = visitView().groups.find(g => g.exam === 'exam.xray_chest')!;
    const side = xray.image?.kind === 'xray' ? xray.image.infiltrate : undefined;
    expect(side).toBeDefined();
    const words = { right: 'справа', left: 'слева', both: 'с обеих сторон' } as const;
    expect(xray.lines.find(l => l.f === 'img.cxr_infiltrate')!.text).toContain(words[side!]);
    // лента — у ЭКГ, а у пульса и давления картинки нет
    act('exam.vitals');
    act('exam.ecg');
    for (let k = 0; k < 3 && visitView().pending.length > 0; k++) waitForResults();
    const ecg = visitView().groups.find(g => g.exam === 'exam.ecg')!;
    expect(ecg.image?.kind).toBe('ecg');
    expect(ecg.image?.kind === 'ecg' && ecg.image.rate).toBeGreaterThan(30);
    expect(visitView().groups.find(g => g.exam === 'exam.vitals')!.image).toBeUndefined();
  });

  test('пациент сказал об аллергии — у пенициллинов предупреждение, у остального нет', () => {
    // ищем среди следующих пациентов того, кто назовёт аллергию на расспросе (~9 % взрослых)
    let told = false;
    for (let i = 0; i < 200 && !told; i++) {
      nextPatient();
      expect(visitView().treatments.every(x => x.warning === undefined)).toBe(true); // пока не спросили
      act('exam.ask_allergies');
      told = visitView().results.some(l => l.f === 'hx.allergy_penicillin' && l.shown);
    }
    expect(told).toBe(true);
    const warn = Object.fromEntries(visitView().treatments.map(x => [x.id, x.warning]));
    expect(warn['tx.amoxicillin']).toBe('Противопоказано: аллергия на пенициллины');
    expect(warn['tx.amoxicillin_clavulanate']).toBe(warn['tx.amoxicillin']);
    expect(warn['tx.macrolide']).toBeUndefined();
  });
});

describe('что было дальше — словами', () => {
  test('в день приёма — «в тот же день», на следующий — «на следующий день», дальше — число', () => {
    expect(outcomeText({ kind: 'recovered', day: 0, cured: true }, 'home', true)).toBe('В тот же день выздоровела');
    expect(outcomeText({ kind: 'recovered', day: 3, cured: true }, 'home', false)).toBe('Через 3\u00a0дня выздоровел');
    expect(outcomeText({ kind: 'worse', day: 0, returns: { day: 0, reason: 'worse' }, cured: false }, 'home', false)).toBe('В тот же день стало хуже — вернётся на приём');
    expect(outcomeText({ kind: 'worse', day: 1, returns: { day: 1, reason: 'worse' }, cured: false }, 'home', false)).toBe('На следующий день стало хуже — вернётся на приём');
    expect(outcomeText({ kind: 'worse', day: 4, returns: { day: 4, reason: 'worse' }, cured: false }, 'home', true)).toBe('На 4-й день стало хуже — вернётся на приём');
  });
});
