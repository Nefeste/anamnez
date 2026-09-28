// Смена в амбулатории (spec 2026-09-first-shift, «Движок»): приход, сортировка, очередь,
// терпение, сроки обследований и кабинеты, закрытие случая и дня, повторные обращения,
// детерминизм и сохранение снимком.
import { describe, expect, test } from 'bun:test';
import { apply, current, newShift } from '../../src/engine/shift/engine';
import { type Command, DAY, SHIFT_END, SHIFT_START, type ShiftState } from '../../src/engine/shift/types';
import { buildDb } from '../content/load';

const { db } = buildDb();
const winter = { season: 'winter' as const };
const minutes = (n: number): Command => ({ kind: 'advance', seconds: n * 60 });
const byStatus = (s: ShiftState, status: string) => Object.values(s.patients).filter(p => p.status === status);

describe('смена: приход и очередь', () => {
  test('за смену приходят 8–24 человека, с 08:00 до 14:00; в среднем 12–18', () => {
    let total = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const s = newShift(db, { seed, ...winter });
      const all = Object.values(s.patients);
      expect(all.length).toBeGreaterThanOrEqual(8);
      expect(all.length).toBeLessThanOrEqual(24);
      for (const p of all) {
        expect(p.arriveT).toBeGreaterThanOrEqual(SHIFT_START);
        expect(p.arriveT).toBeLessThan(SHIFT_END);
        expect(p.status).toBe('coming');
      }
      total += all.length;
    }
    expect(total / 40).toBeGreaterThanOrEqual(12);
    expect(total / 40).toBeLessThanOrEqual(18);
  });

  test('пришедшему медсестра меряет витальные; очередь — по срочности, затем по времени', () => {
    const s = newShift(db, { seed: 7, ...winter });
    apply(db, s, minutes(6 * 60));
    const waiting = s.queue.map(id => s.patients[id]);
    expect(waiting.length).toBeGreaterThan(0);
    for (const p of waiting) expect(p.results[0].exam).toBe('exam.vitals');
    const rank = { red: 0, yellow: 1, green: 2 };
    for (let i = 1; i < waiting.length; i++) {
      const [a, b] = [waiting[i - 1], waiting[i]];
      expect(rank[a.triage] < rank[b.triage] || (a.triage === b.triage && a.queuedT <= b.queuedT)).toBe(true);
    }
  });

  test('сортировка — по тому, что видит медсестра: давящая боль за грудиной или низкая сатурация — красный', () => {
    let checked = 0;
    for (let seed = 1; seed <= 60 && checked < 5; seed++) {
      const s = newShift(db, { seed, ...winter });
      apply(db, s, minutes(6 * 60));
      for (const p of Object.values(s.patients)) {
        if (p.status === 'coming') continue;
        const seen = new Set([...p.patient.complaints, ...p.results.flatMap(r => r.obs.filter(o => o.shown).map(o => o.f))]);
        if (seen.has('sym.chest_pain_pressing') || seen.has('vital.spo2_low')) {
          expect(p.triage).toBe('red');
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  test('если никого не принимать: жёлтые и зелёные уходят, не дождавшись, красные — ждут', () => {
    const s = newShift(db, { seed: 11, ...winter });
    apply(db, s, minutes(10 * 60)); // до 18:00
    expect(s.summary.left).toBeGreaterThan(0);
    for (const p of byStatus(s, 'left')) expect(p.triage).not.toBe('red');
    for (const id of s.queue) expect(s.patients[id].triage).toBe('red');
    expect(s.summary.left + s.queue.length).toBe(s.summary.arrived);
  });
});

describe('смена: приём', () => {
  /** Первая смена, где к 09:00 кто-то ждёт; вызвать его. */
  function withPatient(seed = 3): ShiftState {
    const s = newShift(db, { seed, ...winter });
    apply(db, s, minutes(60));
    expect(s.queue.length).toBeGreaterThan(0);
    apply(db, s, { kind: 'call', id: s.queue[0] });
    return s;
  }

  test('вызов и расспрос двигают часы на свою цену; результат расспроса — сразу', () => {
    const s = withPatient();
    const t0 = s.t;
    apply(db, s, { kind: 'exam', exam: 'exam.ask_complaints' });
    expect(s.t - t0).toBe(db.exams['exam.ask_complaints'].time.procedure * 60);
    const p = current(s)!;
    expect(p.results.at(-1)!.exam).toBe('exam.ask_complaints');
    apply(db, s, { kind: 'exam', exam: 'exam.ask_complaints' }); // повтор — ничего
    expect(p.done.filter(x => x === 'exam.ask_complaints').length).toBe(1);
  });

  test('мужчину о месячных и беременности не спрашивают: вопроса нет, часы не идут', () => {
    const s = newShift(db, { seed: 3, ...winter });
    apply(db, s, minutes(120));
    const man = s.queue.find(id => s.patients[id].patient.sex === 'm')!;
    expect(man).toBeDefined();
    apply(db, s, { kind: 'call', id: man });
    const p = current(s)!;
    const t0 = s.t;
    apply(db, s, { kind: 'exam', exam: 'exam.ask_pregnancy' });
    apply(db, s, { kind: 'exam', exam: 'exam.pregnancy_test' });
    expect(p.done).not.toContain('exam.ask_pregnancy');
    expect(p.done).not.toContain('exam.pregnancy_test');
    expect(s.t).toBe(t0);
    expect(p.results.some(r => r.exam === 'exam.ask_pregnancy')).toBe(false);
  });

  test('рентген-кабинет один: второй снимок ждёт, пока освободится аппарат', () => {
    const s = newShift(db, { seed: 5, ...winter });
    apply(db, s, minutes(90));
    expect(s.queue.length).toBeGreaterThan(1);
    const [a, b] = [s.queue[0], s.queue[1]];
    apply(db, s, { kind: 'call', id: a });
    apply(db, s, { kind: 'exam', exam: 'exam.xray_chest' });
    const first = s.patients[a].pending[0].readyAt;
    apply(db, s, { kind: 'sendAway' });
    apply(db, s, { kind: 'call', id: b });
    apply(db, s, { kind: 'exam', exam: 'exam.xray_chest' });
    const second = s.patients[b].pending[0].readyAt;
    const x = db.exams['exam.xray_chest'].time;
    expect(second - first).toBeGreaterThanOrEqual(x.procedure * 60);
  });

  test('ушёл на анализы — вернулся в очередь с результатами; новое видно при вызове', () => {
    const s = withPatient(9);
    const id = s.current!;
    apply(db, s, { kind: 'exam', exam: 'exam.cbc' });
    apply(db, s, { kind: 'sendAway' });
    expect(s.patients[id].status).toBe('away');
    expect(s.queue).not.toContain(id);
    const notices = apply(db, s, minutes(60));
    expect(notices).toContainEqual({ kind: 'resultsReady', id });
    expect(s.patients[id].status).toBe('waiting');
    expect(s.queue).toContain(id);
    const cbc = s.patients[id].results.find(r => r.exam === 'exam.cbc')!;
    expect(cbc.step).toBe(s.patients[id].step); // пришло после последнего действия — «новое»
  });

  test('в кабинете можно подождать результат: часы — до его готовности', () => {
    const s = withPatient(4);
    apply(db, s, { kind: 'exam', exam: 'exam.crp' });
    const ready = current(s)!.pending[0].readyAt;
    apply(db, s, { kind: 'waitResults' });
    expect(s.t).toBe(ready);
    expect(current(s)!.results.some(r => r.exam === 'exam.crp')).toBe(true);
  });

  test('завершить приём: без диагноза нельзя; с ним — случай закрыт с оценками и исходом', () => {
    const s = withPatient(6);
    const id = s.current!;
    apply(db, s, { kind: 'finish' });
    expect(s.current).toBe(id);
    apply(db, s, { kind: 'exam', exam: 'exam.ask_complaints' });
    apply(db, s, { kind: 'diagnose', id: 'cond.arvi' });
    apply(db, s, { kind: 'toggleTreatment', id: 'tx.rest_fluids' });
    apply(db, s, { kind: 'finish' });
    const p = s.patients[id];
    expect(p.status).toBe('done');
    expect(s.current).toBeUndefined();
    expect(['A', 'B', 'C', 'D']).toContain(p.closed!.grades.overall);
    expect(p.closed!.plan).toEqual({ treatments: ['tx.rest_fluids'], setting: 'home' });
    expect(s.summary.seen).toBe(1);
  });

  test('завершили, не дождавшись анализа, — результат приходит в пустоту, разбор не меняется', () => {
    const s = withPatient(6);
    const id = s.current!;
    apply(db, s, { kind: 'exam', exam: 'exam.ask_complaints' });
    apply(db, s, { kind: 'exam', exam: 'exam.crp' });
    apply(db, s, { kind: 'diagnose', id: 'cond.arvi' });
    apply(db, s, { kind: 'finish' });
    const results = s.patients[id].results.length;
    apply(db, s, minutes(120));
    expect(s.patients[id].pending).toEqual([]);
    expect(s.patients[id].results.length).toBe(results);
    expect(s.patients[id].results.some(r => r.exam === 'exam.crp')).toBe(false);
  });
});

describe('смена: закрытие дня и повторные обращения', () => {
  /** Принять всех подряд с одним и тем же нелепым планом — часть вернётся. */
  function playDay(s: ShiftState, plan: { dx: string; tx: string[] } = { dx: 'cond.arvi', tx: [] }) {
    for (let guard = 0; guard < 400 && (s.t % DAY < SHIFT_END || s.queue.length > 0); guard++) {
      if (!s.current && s.queue.length > 0) apply(db, s, { kind: 'call', id: s.queue[0] });
      if (s.current) {
        apply(db, s, { kind: 'exam', exam: 'exam.ask_complaints' });
        apply(db, s, { kind: 'diagnose', id: plan.dx });
        for (const tx of plan.tx) apply(db, s, { kind: 'toggleTreatment', id: tx });
        apply(db, s, { kind: 'finish' });
      } else apply(db, s, minutes(10));
    }
    apply(db, s, { kind: 'closeDay' });
  }

  test('закрыть день: итоги сходятся, кого не приняли — учтены; следующий день — с 08:00', () => {
    const s = newShift(db, { seed: 21, ...winter });
    apply(db, s, minutes(120));
    apply(db, s, { kind: 'closeDay' });
    const h = s.history[0];
    expect(h.seen + h.left + h.unseen).toBe(h.arrived);
    expect(s.dayOpen).toBe(false);
    apply(db, s, minutes(60)); // день закрыт — время не идёт
    expect(s.history.length).toBe(1);
    apply(db, s, { kind: 'nextDay' });
    expect(s.day).toBe(2);
    expect(s.t).toBe(DAY + SHIFT_START);
    expect(s.dayOpen).toBe(true);
    expect(Object.values(s.patients).some(p => p.id.startsWith('2-'))).toBe(true);
  });

  test('кто ушёл лечиться без лечения причины, возвращается тем же человеком, с той же болезнью', () => {
    const s = newShift(db, { seed: 33, ...winter });
    playDay(s);
    const planned = s.returns.length;
    expect(planned).toBeGreaterThan(0);
    for (let d = 0; d < 7 && !Object.values(s.patients).some(p => p.kind === 'return'); d++) {
      apply(db, s, { kind: 'nextDay' });
      playDay(s);
    }
    const back = Object.values(s.patients).find(p => p.kind === 'return')!;
    expect(back).toBeDefined();
    const prev = s.patients[back.returnOf!];
    expect(back.patient.seed).toBe(prev.patient.seed);
    expect(back.patient.sex).toBe(prev.patient.sex);
    expect(back.patient.age).toBe(prev.patient.age);
    expect(back.patient.truth.conditions[0].id).toBe(prev.patient.truth.conditions[0].id);
  });

  test('старое не копится: ушедших прошлых дней нет, принятых хранят неделю', () => {
    const s = newShift(db, { seed: 12, ...winter });
    for (let d = 1; d <= 9; d++) {
      playDay(s);
      apply(db, s, { kind: 'nextDay' });
    }
    const kept = Object.values(s.patients).filter(p => !p.id.startsWith(`${s.day}-`));
    expect(kept.length).toBeGreaterThan(0);
    const waiting = new Set(s.returns.map(r => r.of));
    for (const p of kept) {
      expect(p.status === 'done' || waiting.has(p.id)).toBe(true);
      expect(Number(p.id.split('-')[0]) >= s.day - 7 || waiting.has(p.id)).toBe(true);
    }
  });
});

describe('смена: детерминизм и сохранение', () => {
  const script = (s: ShiftState): Command[] => {
    const cmds: Command[] = [minutes(45)];
    return cmds.concat([{ kind: 'call', id: s.queue[0] ?? '1-01' }, { kind: 'exam', exam: 'exam.ask_complaints' }, { kind: 'exam', exam: 'exam.cbc' }, { kind: 'sendAway' }, minutes(50)]);
  };

  test('те же зерно и команды — та же смена; журнал повторяет день', () => {
    const a = newShift(db, { seed: 99, ...winter });
    apply(db, a, minutes(45));
    for (const c of script(a).slice(1)) apply(db, a, c);
    const b = newShift(db, { seed: 99, ...winter });
    for (const c of a.journal) apply(db, b, c);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  test('снимок сохраняется и читается: продолжение не отличается от несохранённого', () => {
    const a = newShift(db, { seed: 5, ...winter });
    apply(db, a, minutes(80));
    const saved = JSON.parse(JSON.stringify(a)) as ShiftState;
    const more: Command[] = [{ kind: 'call', id: a.queue[0] }, { kind: 'exam', exam: 'exam.xray_chest' }, { kind: 'sendAway' }, minutes(90)];
    for (const c of more) {
      apply(db, a, c);
      apply(db, saved, c);
    }
    expect(JSON.stringify(saved)).toBe(JSON.stringify(a));
  });
});

describe('смена: сложность (03-game-design.md §14)', () => {
  test('«Студент»: обследования и осмотр показывают правду, пациенты ждут в полтора раза дольше', () => {
    for (const seed of [3, 7, 11]) {
      const doctor = newShift(db, { seed, ...winter });
      const student = newShift(db, { seed, ...winter, difficulty: 'student' });
      expect(student.meta.difficulty).toBe('student');
      // приходят те же люди: план дня от сложности не зависит
      expect(Object.keys(student.patients).sort()).toEqual(Object.keys(doctor.patients).sort());
      apply(db, doctor, minutes(6 * 60));
      apply(db, student, minutes(6 * 60));
      for (const p of Object.values(student.patients)) {
        const d = doctor.patients[p.id];
        if (p.triage !== 'red' && p.triage === d.triage) expect(p.patience).toBe(Math.round(d.patience * 1.5));
      }
      // первый в очереди — все обследования подряд: показано ровно то, что есть
      const s = newShift(db, { seed, ...winter, difficulty: 'student' });
      for (let i = 0; i < 300 && s.queue.length === 0; i++) apply(db, s, minutes(1));
      const id = s.queue[0];
      apply(db, s, { kind: 'call', id });
      for (const exam of Object.keys(db.exams)) apply(db, s, { kind: 'exam', exam });
      apply(db, s, minutes(24 * 60));
      const p = s.patients[id];
      const present = new Set(p.patient.truth.findings.map(f => f.f));
      const all = [...p.results.flatMap(r => r.obs), ...p.pending.flatMap(x => x.obs)];
      expect(all.length).toBeGreaterThan(20);
      for (const o of all) expect({ f: o.f, shown: o.shown }).toEqual({ f: o.f, shown: present.has(o.f) });
    }
  });

  test('без сложности в сохранении — «Врач»: так шла смена до 0.0.16', () => {
    const s = newShift(db, { seed: 5, ...winter });
    expect(s.meta.difficulty).toBe('doctor');
  });
});
