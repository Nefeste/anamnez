// «Главы короче» (часть 93, вопрос 54, spec 2026-10-short-chapters): настройка при начале карьеры — пороги заданий глав 1 и
// 3 ниже, каждый день один-два пришедших — с более редкой болезнью больницы; с «Как есть» — всё как было.
import { describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { campaignEvening, INTERESTING_WEIGHT, interestingOf, missionsOf, startChapter } from '../../src/engine/campaign/campaign';
import { type StaffMember, salaryOf } from '../../src/engine/hospital/staff';
import { apply, newCampaign } from '../../src/engine/shift/engine';
import type { Command, DaySummary, ShiftPatient, ShiftState } from '../../src/engine/shift/types';

const district = db.chapters['chapter.district'];
const vascular = db.chapters['chapter.vascular'];
const run = (s: ShiftState, ...cmds: Command[]) => {
  for (const c of cmds) apply(db, s, c);
  return s;
};
const day = (n: number, seen: number, correct: number): DaySummary => ({
  day: n, arrived: seen, seen, left: 0, unseen: 0, correct, partly: 0, wrong: seen - correct, grades: { A: 0, B: 0, C: 0, D: 0 }, money: 0, returnsPlanned: 0, returnsToday: 0,
});

describe('главы короче: задания', () => {
  test('глава 1 — 25 пациентов, глава 3 — по три больных с ЭКГ и КТ в срок; остальные задания те же', () => {
    const one = missionsOf(district, true);
    expect(one.find(m => m.id === 'seen')).toMatchObject({ count: 25, text: { ru: 'Принять 25 пациентов с точностью от 75 %' } });
    const three = missionsOf(vascular, true);
    expect(three.filter(m => m.id === 'ecg' || m.id === 'ct').map(m => ('count' in m ? m.count : 0))).toEqual([3, 3]);
    expect(three.find(m => m.id === 'ecg')!.text.ru).toBe('ЭКГ при боли в груди в первые 10 минут: три больных');
    for (const ch of Object.values(db.chapters)) {
      expect(missionsOf(ch, false)).toBe(ch.missions);
      const short = missionsOf(ch, true);
      expect(short.map(m => m.id)).toEqual(ch.missions.map(m => m.id));
      short.forEach((m, i) => (m.short ? expect(m).not.toBe(ch.missions[i]) : expect(m).toBe(ch.missions[i])));
    }
    // у глав 2 и 4 «Короче» нет — задания те же
    expect(Object.values(db.chapters).filter(ch => ch.missions.some(m => m.short)).map(ch => ch.id).sort()).toEqual(['chapter.district', 'chapter.vascular']);
  });

  test('вечер главы засчитывает «принять N» по порогу «Короче»: 25 верных из 30 — выполнено, с «Как есть» — нет', () => {
    const history = [day(1, 15, 13), day(2, 15, 12)];
    const short = { ...startChapter(db, district.id, 0) };
    expect(campaignEvening(db, { campaign: short, history, short: true }, 2).done).toContain('seen');
    const asis = { ...startChapter(db, district.id, 0) };
    expect(campaignEvening(db, { campaign: asis, history }, 2).done).not.toContain('seen');
  });
});

/** Дни карьеры с одним зерном: кто пришёл в каждый (без приёма — день закрывается сразу). */
function days(short: boolean, n: number, seed = 4242) {
  const s = newCampaign(db, { seed, season: 'winter', career: 1, short });
  const out: ShiftPatient[][] = [];
  for (let d = 1; d <= n; d++) {
    run(s, { kind: 'nextDay' });
    out.push(Object.values(s.patients).filter(p => p.id.startsWith(`${d}-`)).sort((a, b) => (a.id < b.id ? -1 : 1)));
    run(s, { kind: 'closeDay' });
  }
  return { s, out };
}

describe('главы короче: интересный больной дня', () => {
  test('новая карьера с «Короче» — поле в смене; с «Как есть» — нет; переход в следующую главу его не трогает', () => {
    const { s } = days(true, 1);
    expect(s.meta.shortChapters).toBe(true);
    expect(newCampaign(db, { seed: 1, season: 'winter', career: 1 }).meta.shortChapters).toBeUndefined();
    s.campaign!.complete = s.day;
    run(s, { kind: 'nextChapter' });
    expect([s.campaign!.chapter, s.meta.shortChapters]).toEqual(['chapter.hospital', true]);
  });

  test('один-два в день, кроме дня обучения; болезнь — из редких больницы; остальные пришедшие — те же, что с «Как есть»', () => {
    const counts = new Set<number>();
    for (const seed of [4242, 77, 1009]) {
      const short = days(true, 5, seed).out;
      const asis = days(false, 5, seed).out;
      // день 1 — день обучения главы: интересных нет, день тот же
      expect(short[0]).toEqual(asis[0]);
      for (let d = 1; d < 5; d++) {
        expect(short[d].map(p => [p.id, p.arriveT, p.kind])).toEqual(asis[d].map(p => [p.id, p.arriveT, p.kind]));
        const odd = short[d].filter(p => p.interesting);
        counts.add(odd.length);
        expect(odd.length).toBeGreaterThanOrEqual(1);
        expect(odd.length).toBeLessThanOrEqual(2);
        const rare = interestingOf(db, ['dept.therapy']);
        short[d].forEach((p, i) => {
          if (!p.interesting) {
            expect(p).toEqual(asis[d][i]);
            return;
          }
          // тот же человек, болезнь — более редкая: вес записи не больше порога
          expect([p.patient.sex, p.patient.age]).toEqual([asis[d][i].patient.sex, asis[d][i].patient.age]);
          expect(p.kind === 'walkIn' || p.kind === 'appointment').toBe(true);
          const id = p.patient.truth.conditions[0].id;
          expect(rare).toContain(id);
          expect(db.conditions[id].weight).toBeLessThanOrEqual(INTERESTING_WEIGHT);
        });
      }
    }
    expect([...counts].sort()).toEqual([1, 2]);
  }, 120_000);

  test('интересный — для вас: нанятые врачи его не берут, остальных пришедших сами — берут', () => {
    // городская больница: кабинет терапевта на месте готовой больницы и терапевт в нём — как у модели главы 4
    const s = newCampaign(db, { seed: 31, season: 'winter', career: 1, chapter: 'chapter.city', short: true });
    const preset = db.presets[db.chapters['chapter.city'].preset];
    const office = preset.rooms.find(r => r.later && r.type === 'room.office')!;
    const [dx, dy] = [s.hospital!.rooms[0].x - preset.rooms[0].x, s.hospital!.rooms[0].y - preset.rooms[0].y];
    apply(db, s, { kind: 'build', cmd: { kind: 'room', type: office.type, size: office.size, x: office.x + dx, y: office.y + dy, rot: office.rot } });
    const room = s.hospital!.rooms.find(r => r.type === 'room.office' && r.x === office.x + dx && r.y === office.y + dy)!;
    for (const e of office.equipment) apply(db, s, { kind: 'build', cmd: { kind: 'buy', room: room.id, equipment: e } });
    apply(db, s, { kind: 'buildEnd' });
    const m: StaffMember = { id: 'h1', role: 'role.therapist', sex: 'f', seed: 11, skill: 3, salary: salaryOf(db, 'role.therapist', 3), days: 0 };
    s.staff = [...(s.staff ?? []), m];
    apply(db, s, { kind: 'assign', id: m.id, room: room.id });
    run(s, { kind: 'nextDay' }, { kind: 'closeDay' }, { kind: 'nextDay' });
    for (let i = 0; i < 600; i++) apply(db, s, { kind: 'advance', seconds: 60 });
    const day2 = Object.values(s.patients).filter(p => p.id.startsWith('2-'));
    const odd = day2.filter(p => p.interesting);
    expect(odd.length).toBeGreaterThan(0);
    expect(odd.every(p => p.by === undefined)).toBe(true);
    expect(day2.some(p => p.by !== undefined && p.kind === 'walkIn')).toBe(true);
  }, 60_000);

  test('редкие болезни больницы — без частых: ОРВИ, гриппа, COVID-19 и боли в спине среди них нет', () => {
    const rare = interestingOf(db, ['dept.therapy', 'dept.surgery', 'dept.trauma']);
    for (const id of ['cond.arvi', 'cond.influenza', 'cond.covid19', 'cond.low_back_pain', 'cond.ankle_sprain']) expect(rare).not.toContain(id);
    for (const id of ['cond.strep_pharyngitis', 'cond.pneumonia_cap', 'cond.pancreatitis']) expect(rare).toContain(id);
    expect(rare.every(id => ['dept.therapy', 'dept.surgery', 'dept.trauma'].includes(db.conditions[id].department))).toBe(true);
  });
});
