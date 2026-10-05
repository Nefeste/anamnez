// Сроки и ЭКГ у постели (spec 2026-10-chapter-3, часть 37): ЭКГ при давящей боли в груди — в первые
// 10 минут от прихода; в смотровой приёмного с монитором — у постели за 5 минут, без очереди и
// описания; оценка срока — в разборе и десятой долей в итоге, в итогах дня — «в срок: N из M»;
// «Попросить подождать» — когда ждёт кто-то срочнее, с частью 43г — и ради идущего срока; разумный врач
// делает ЭКГ первым делом; срок без помещения — только там, где одно из его обследований можно сделать.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { complaintObservations } from '../../src/engine/med/exams';
import type { PlanEval } from '../../src/engine/med/plan';
import { indicated, nextStep, targetExams } from '../../src/engine/med/policy';
import { type CaseInput, scoreCase } from '../../src/engine/med/score';
import { apply, bedsideOf, candidatesOf, current, moreUrgent, newCampaign, targetPlace } from '../../src/engine/shift/engine';
import { dueIn, minutesTo, targetGrade, targetResults, targetsFor } from '../../src/engine/shift/targets';
import type { ShiftPatient, ShiftState } from '../../src/engine/shift/types';
import { T } from '../../src/i18n';

const CHEST = 'sym.chest_pain_pressing';
const TARGET = 'target.ecg_chest_pain';

/** Районная больница главы 2 (смотровая с монитором), открыт первый день. */
function district(seed: number): ShiftState {
  const s = newCampaign(db, { seed, season: 'winter', career: 1, chapter: 'chapter.hospital' });
  apply(db, s, { kind: 'nextDay' });
  return s;
}

/** Закрыть приём: диагноз — болезнь, с которой пришёл, перевод скорой. */
function finish(s: ShiftState, p: ShiftPatient) {
  apply(db, s, { kind: 'diagnose', id: p.patient.truth.conditions[0].id });
  apply(db, s, { kind: 'setting', setting: 'ambulance' });
  apply(db, s, { kind: 'finish' });
}

/**
 * Первый привезённый скорой с давящей болью в груди, лежащий в смотровой, — ещё не сортированный.
 * Прочих привезённых врач сразу переводит: иначе они займут оба места в смотровой.
 */
function chestPainBay(): { s: ShiftState; p: ShiftPatient } {
  for (let seed = 51; seed < 251; seed++) {
    const s = district(seed);
    for (let i = 0; i < 6 * 60; i++) {
      const waiting = Object.values(s.patients).filter(q => q.kind === 'ambulance' && q.status === 'waiting' && !q.sorted && q.scale);
      const p = waiting.find(q => q.bay && q.patient.complaints.includes(CHEST));
      if (p) return { s, p };
      const other = waiting.find(q => !q.patient.complaints.includes(CHEST));
      if (other && !s.current) {
        apply(db, s, { kind: 'sort', id: other.id, triage: other.scale!.triage });
        apply(db, s, { kind: 'call', id: other.id });
        if (current(s)?.id === other.id) finish(s, other);
        continue;
      }
      apply(db, s, { kind: 'advance', seconds: 60 });
    }
  }
  throw new Error('за 200 зёрен никто с болью в груди в смотровую не приехал');
}

describe('оценка срока', () => {
  test('в срок — A, до полутора сроков — B, до двух — C, позже или не сделано — D', () => {
    expect([0, 10, 11, 15, 16, 20, 21].map(m => targetGrade(m, 10))).toEqual(['A', 'A', 'B', 'B', 'C', 'C', 'D']);
    expect(targetGrade(undefined, 10)).toBe('D');
  });

  test('минуты — от прихода до первого пришедшего результата; нет результата — не сделано', () => {
    const t = db.targets[TARGET];
    const results = [{ exam: 'exam.ecg', obs: [], at: 600 + 7 * 60, step: 0 }, { exam: 'exam.ecg', obs: [], at: 600 + 30 * 60, step: 1 }];
    expect(minutesTo({ arriveT: 600, results }, t)).toBe(7);
    expect(minutesTo({ arriveT: 600, results: [] }, t)).toBeUndefined();
  });

  test('срок — десятая доля итога; у приёма без срока итог прежний', () => {
    // верно, уверенно, бережливо, препарат выбора, дома, как рекомендовано: всё A
    const plan: PlanEval = {
      primary: 'cond.arvi', roles: [{ tx: 'tx.paracetamol', role: 'firstLine' }], setting: { chosen: 'home', recommended: 'home' },
      violations: [], effective: true, unaskedRisk: [], firstLineBlocked: false, preHospital: [], preventMissing: [], requireMissing: [], requireWhen: {}, beforeTransferMissing: [], beforeTransferWhen: {}, companionsMissing: [], windowMissed: [], noFirstLine: false,
    };
    const base: CaseInput = {
      verdict: 'correct', confidence: 0.9, cost: 100, rationalCost: 100, selfLimiting: false, redFlags: [], plan, outcome: { kind: 'improved', day: 7, cured: true },
    };
    const without = scoreCase(base);
    expect(without.targets).toBeUndefined();
    const onTime = scoreCase({ ...base, targets: ['A'] });
    expect(onTime.targets).toBe('A');
    // худшая оценка срока — та, что в итоге
    expect(scoreCase({ ...base, targets: ['A', 'D'] }).targets).toBe('D');
    expect([without.overall, onTime.overall]).toEqual(['A', 'A']);
    // всё A, а срок сорван: 27 из 30 баллов — 2,7 в среднем, итог всё ещё A; срок — десятая доля
    expect(scoreCase({ ...base, targets: ['D'] }).overall).toBe('A');
  });
});

describe('ЭКГ у постели в смотровой приёмного', () => {
  test('лежит в смотровой с монитором — ЭКГ у постели за 5 минут, сразу, без очереди и описания; срок — A; в итогах дня — 1 из 1', () => {
    const { s, p } = chestPainBay();
    expect(targetsFor(db, p, targetPlace(db, s, p)).map(t => t.id)).toEqual([TARGET]);
    expect(bedsideOf(db, s, p, 'exam.ecg')).toEqual(db.exams['exam.ecg'].bedside);
    apply(db, s, { kind: 'sort', id: p.id, triage: p.scale!.triage });
    apply(db, s, { kind: 'call', id: p.id });
    expect(current(s)?.id).toBe(p.id);
    const before = s.t;
    apply(db, s, { kind: 'exam', exam: 'exam.ecg' });
    // врач занят 5 минут, результат — сразу у постели: ждать нечего
    expect(s.t - before).toBe(5 * 60);
    expect(p.pending).toEqual([]);
    expect(p.results.filter(r => r.exam === 'exam.ecg').map(r => r.at)).toEqual([s.t]);
    const [r] = targetResults(db, p, targetPlace(db, s, p));
    expect(r.grade).toBe('A');
    expect(r.minutes).toBeLessThanOrEqual(10);
    finish(s, p);
    // при подъёме ST на этой ЭКГ к ней добавляется срок перевода (часть 39б) — здесь важен срок ЭКГ
    expect(p.closed?.targets?.filter(t => t.id === TARGET)).toEqual([r]);
    expect(s.summary.targets?.[TARGET]).toEqual({ onTime: 1, total: 1 });
    // строки разбора и итогов дня
    expect(T.spikes.patient.targetLine(db.targets[TARGET].name.ru, r.minutes, 10)).toBe(`ЭКГ при боли в груди: через ${r.minutes} мин после прихода — в срок`);
    expect(T.shift.summary.targets.line(db.targets[TARGET].name.ru, 1, 1)).toBe('ЭКГ при боли в груди в срок: 1 из 1.');
  });

  test('без монитора в смотровой у постели не снять — и срока нет: в 10 минут не успеть не по вине игрока', () => {
    const { s, p } = chestPainBay();
    // больница — новым объектом, как после стройки: план больницы движок помнит по нему
    const h = s.hospital!;
    s.hospital = { ...h, rooms: h.rooms.map(r => (r.id === p.bay!.room ? { ...r, equipment: r.equipment.map(x => (x === 'eq.monitor_defib' ? null : x)) } : r)) };
    expect(bedsideOf(db, s, p, 'exam.ecg')).toBeUndefined();
    expect(targetsFor(db, p, targetPlace(db, s, p))).toEqual([]);
  });

  test('не сделали ЭКГ — срок не выполнен, D, и в итогах дня — 0 из 1', () => {
    const { s, p } = chestPainBay();
    apply(db, s, { kind: 'sort', id: p.id, triage: p.scale!.triage });
    apply(db, s, { kind: 'call', id: p.id });
    finish(s, p);
    expect(p.closed?.targets?.map(t => [t.id, t.grade, t.minutes])).toEqual([[TARGET, 'D', undefined]]);
    expect(s.summary.targets?.[TARGET]).toEqual({ onTime: 0, total: 1 });
    expect(T.spikes.patient.targetLine(db.targets[TARGET].name.ru, undefined, 10)).toBe('ЭКГ при боли в груди: не сделано, срок — 10 мин от прихода');
  });

  test('срок — только у лежащих в смотровой: у пришедшего самого с болью в груди срока нет', () => {
    const { s, p } = chestPainBay();
    const at = targetPlace(db, s, p);
    expect(targetsFor(db, { ...p, bay: undefined }, at)).toEqual([]);
    expect(targetsFor(db, { ...p, patient: { ...p.patient, complaints: p.patient.complaints.filter(f => f !== CHEST) } }, at)).toEqual([]);
  });
});

describe('попросить подождать', () => {
  test('ждать нечего и никто не срочнее — нельзя; привезли и отсортировали красным — можно, и пациент — в очередь на своё место', () => {
    for (let seed = 51; seed < 251; seed++) {
      const s = district(seed);
      // первый пришедший сам, не красный — к врачу
      let w: ShiftPatient | undefined;
      for (let i = 0; i < 3 * 60 && !w; i++) {
        w = s.queue.map(id => s.patients[id]).find(q => q.kind !== 'ambulance' && (q.triaged === false || q.triage !== 'red'));
        if (!w) apply(db, s, { kind: 'advance', seconds: 60 });
      }
      if (!w || Object.values(s.patients).some(q => q.kind === 'ambulance' && q.status === 'waiting')) continue;
      apply(db, s, { kind: 'call', id: w.id });
      expect(moreUrgent(db, s, w)).toBe(false);
      apply(db, s, { kind: 'sendAway' });
      expect(current(s)?.id).toBe(w.id);
      // опрос, пока не привезут скорую
      const asks = Object.keys(db.exams).filter(id => db.exams[id].kind === 'ask').sort();
      let car: ShiftPatient | undefined;
      for (const id of asks) {
        apply(db, s, { kind: 'exam', exam: id });
        car = Object.values(s.patients).find(q => q.kind === 'ambulance' && q.status === 'waiting' && !q.sorted && q.scale);
        if (car || w.pending.length > 0) break;
      }
      if (!car || w.pending.length > 0) continue;
      // ещё не сортировали — уже «срочнее»: по листу передачи может оказаться красным
      expect(moreUrgent(db, s, w)).toBe(true);
      apply(db, s, { kind: 'sort', id: car.id, triage: 'red' });
      expect(moreUrgent(db, s, w)).toBe(true);
      const t = s.t;
      apply(db, s, { kind: 'sendAway' });
      expect(s.current).toBeUndefined();
      expect(w.status).toBe('waiting');
      expect(s.t - t).toBe(60);
      // красный — первым, отпущенный — на своём месте среди прочих, по времени прихода
      expect(s.queue[0]).toBe(car.id);
      expect(s.queue).toContain(w.id);
      expect(w.queuedT).toBe(w.arriveT);
      return;
    }
    throw new Error('не нашлось зерна: пришедший сам у врача, и во время опроса привезли скорую');
  });

  test('ради идущего срока — можно и при той же срочности (часть 43г); у того, кто в кабинете, свой срок кончается раньше — нельзя', () => {
    const { s, p } = chestPainBay();
    apply(db, s, { kind: 'sort', id: p.id, triage: 'red' });
    expect(s.queue).toContain(p.id);
    // в кабинете — такой же красный, но без срока: не в смотровой
    const w: ShiftPatient = { ...p, id: 'w', bay: undefined, kind: 'walkIn', sorted: undefined, triage: 'red', results: [] };
    s.patients.w = w;
    expect(targetsFor(db, w, targetPlace(db, s, w))).toEqual([]);
    expect(moreUrgent(db, s, w)).toBe(true);
    // у того, кто в кабинете, такой же срок начался на 5 минут раньше — он и срочнее
    const v: ShiftPatient = { ...p, id: 'v', arriveT: p.arriveT - 5 * 60, triage: 'yellow' };
    s.patients.v = v;
    expect(dueIn(db, v, targetPlace(db, s, v), s.t)).toBeLessThan(dueIn(db, p, targetPlace(db, s, p), s.t)!);
    // и красного без срока ради него не отпускают: срок идёт у того, кто в кабинете
    expect(moreUrgent(db, s, v)).toBe(false);
    // ЭКГ сделана — срока у него больше нет, и красный в очереди снова срочнее
    v.results = [{ exam: 'exam.ecg', obs: [], at: s.t, step: 1 }];
    expect(dueIn(db, v, targetPlace(db, s, v), s.t)).toBeUndefined();
    expect(moreUrgent(db, s, v)).toBe(true);
  });
});

describe('срок там, где его можно выполнить', () => {
  test('КТ при подозрении на инсульт — только где есть КТ: в районной больнице его нет, и срока нет (часть 43г)', () => {
    const s = district(51);
    const p = Object.values(s.patients)[0] ?? (() => {
      throw new Error('нет пациента');
    })();
    const sudden: ShiftPatient = { ...p, bay: undefined, patient: { ...p.patient, complaints: ['sym.thunderclap'] }, results: [] };
    const at = targetPlace(db, s, sudden);
    expect([at.can('exam.ct_head'), at.can('exam.cta_head'), at.can('exam.neuro_exam')]).toEqual([false, false, true]);
    expect(targetsFor(db, sudden, at)).toEqual([]);
    // где КТ есть — срок есть
    expect(targetsFor(db, sudden, { ...at, can: () => true }).map(t => t.id)).toEqual(['target.stroke_ct']);
  });
});

describe('разумный врач и сроки', () => {
  test('при давящей боли в груди ЭКГ — первый шаг и показана всегда; без неё — не обязательно первой', () => {
    const { s, p } = chestPainBay();
    expect(targetExams(db, p.patient)).toEqual(['exam.ecg']);
    const exams = Object.keys(db.exams).sort();
    const candidates = candidatesOf(db, p.departments ?? s.meta.department);
    const obs = complaintObservations(p.patient);
    expect(indicated(db, p.patient, obs, candidates, 'exam.ecg')).toBe(true);
    const step = nextStep(db, p.patient, obs, [], {}, { candidates, exams, threshold: 0.9, minGain: 0.05 }).step;
    expect(step).toEqual({ kind: 'exam', exam: 'exam.ecg' });
    const calm = { ...p.patient, complaints: p.patient.complaints.filter(f => f !== CHEST) };
    expect(targetExams(db, calm)).toEqual([]);
  });

});
