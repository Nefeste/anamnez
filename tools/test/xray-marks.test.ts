// Разметка находок на рентгене и задача «Найдите на снимке» (spec 2026-11-xray-marks, вопрос 76): контуры — из той же
// геометрии, что рисунок, и на своей стороне; разметка в карте — у показанных строк снимка; на «Практиканте» и
// «Студенте», в разборе — сразу, на «Ординаторе» и «Враче» — задачей; попытка — одна на находку, только своя и только
// пришедшего результата; попадания копят опыт лучевой диагностики, её умение «Чтение снимков» — снимок без описания.
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { RADIOLOGY, reportMinutes, skillsFor } from '../../src/engine/career/skills';
import { generatePatient } from '../../src/engine/med/generate';
import type { Observation } from '../../src/engine/med/types';
import { apply, newShift, readyIn } from '../../src/engine/shift/engine';
import type { ShiftState } from '../../src/engine/shift/types';
import { abdomenMarks, boneMarks, chestMarks, ellipse, hits, inside } from '../../src/render/xray/marks';
import { infiltrateCenter, XRAY_ASPECT } from '../../src/render/xray/chestGeometry';
import { type CaseInput, makeCaseView } from '../../src/state/caseView';
import { forgetProfile, loadProfile, profile, recordCases, setProfileStore } from '../../src/state/profile';
import { specialtyRows } from '../../src/state/profileView';
import { memoryStore } from '../../src/state/saves';

const READING = 'skill.radiology_reading';

beforeEach(() => {
  setProfileStore(memoryStore());
  forgetProfile();
});

const within = (outlines: [number, number][][]) => outlines.flat().every(([x, y]) => x > -0.05 && x < 1.05 && y > -0.05 && y < 1.05);
const centerX = (o: [number, number][]) => o.reduce((a, p) => a + p[0], 0) / o.length;

describe('геометрия разметки', () => {
  test('многоугольник: внутри и снаружи; касание рядом с краем засчитывается, далеко — нет', () => {
    const square: [number, number][] = [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4], [0.2, 0.4]];
    expect(inside([0.3, 0.3], square)).toBe(true);
    expect(inside([0.5, 0.3], square)).toBe(false);
    const a = { outlines: [square], anchor: [0.3, 0.2] as [number, number] };
    expect(hits(a, [0.42, 0.3], 1)).toBe(true);
    expect(hits(a, [0.6, 0.3], 1)).toBe(false);
  });

  test('инфильтрат — на своей стороне, вокруг облака рисунка; оба лёгких — два контура', () => {
    const right = chestMarks({ infiltrate: { side: 'right', density: 0.75 } }, 2).infiltrate!;
    const left = chestMarks({ infiltrate: { side: 'left', density: 0.75 } }, 2).infiltrate!;
    expect(centerX(right.outlines[0])).toBeLessThan(0.5);
    expect(centerX(left.outlines[0])).toBeGreaterThan(0.5);
    expect(hits(right, infiltrateCenter(-1, {}), XRAY_ASPECT)).toBe(true);
    expect(hits(right, [0.75, 0.3], XRAY_ASPECT)).toBe(false);
    expect(chestMarks({ infiltrate: { side: 'both', density: 0.75 } }, 2).infiltrate!.outlines).toHaveLength(2);
    expect(within(right.outlines)).toBe(true);
    // подпись — над контуром
    expect(right.anchor[1]).toBeLessThanOrEqual(Math.min(...right.outlines[0].map(p => p[1])) + 1e-9);
  });

  test('травма груди: воздух и жидкость — на своей стороне, переломы рёбер — у мест переломов; норма — без контуров', () => {
    const m = chestMarks({ pneumothorax: { side: 'left', size: 'large' }, effusion: { side: 'right' }, ribFractures: { side: 'right', ribs: [5, 6, 7] } }, 9);
    expect(centerX(m.air!.outlines[0])).toBeGreaterThan(0.5);
    expect(centerX(m.fluid!.outlines[0])).toBeLessThan(0.5);
    expect(centerX(m.rib!.outlines[0])).toBeLessThan(0.5);
    for (const k of ['air', 'fluid', 'rib'] as const) expect(within(m[k]!.outlines)).toBe(true);
    expect(chestMarks({}, 1)).toEqual({});
    // эмфизема — по всему лёгкому: места у неё нет
    expect(chestMarks({ hyperinflation: true }, 1)).toEqual({});
    const heart = chestMarks({ congestion: { edema: true }, cardiomegaly: true }, 3);
    expect(heart.edema!.outlines).toHaveLength(2);
    expect(heart.heart).toBeDefined();
    expect(heart.congestion).toBeUndefined();
  });

  test('живот: серп газа — под правым куполом (слева на снимке, вверху), петли — посередине; кости — на обеих проекциях', () => {
    const gas = abdomenMarks({ freeGas: 0.8, levels: 0 }, 4);
    expect(centerX(gas.freeGas!.outlines[0])).toBeLessThan(0.5);
    expect(Math.max(...gas.freeGas!.outlines[0].map(p => p[1]))).toBeLessThan(0.35);
    expect(gas.levels).toBeUndefined();
    expect(abdomenMarks({ freeGas: 0, levels: 0.8 }, 4).levels).toBeDefined();
    const wrist = boneMarks({ view: 'wrist', side: 'right', fractures: [{ site: 'radius', displacement: 0.5 }] }, 3);
    expect(wrist.radius!.outlines.length).toBeGreaterThanOrEqual(2);
    expect(within(wrist.radius!.outlines)).toBe(true);
    expect(boneMarks({ view: 'wrist', side: 'right', fractures: [] }, 3)).toEqual({});
    expect(ellipse(0.5, 0.5, 0.1, 0.1)).toHaveLength(28);
  });
});

describe('разметка в карте пациента', () => {
  const p = generatePatient(db, 5, { department: 'dept.therapy', season: 'winter' });
  const xr = (f: string, shown: boolean, attrs?: Record<string, string>): Observation => ({ f, shown, exam: 'exam.xray_chest', ...(attrs ? { attrs } : {}) });
  const input = (o: Partial<CaseInput>): CaseInput => ({
    version: 0, patient: p, clock: 600, minutesSpent: 0, money: 0, step: 1,
    arrived: [{ exam: 'exam.xray_chest', step: 1, at: 600, obs: [xr('img.cxr_infiltrate', true, { side: 'right' }), xr('img.cxr_pneumothorax', false)] }],
    pending: [], meanwhile: [], done: ['exam.xray_chest'], draft: { treatments: [], setting: 'home' }, ...o,
  });

  test('у показанной находки снимка — контур с подписью; у ненайденной — нет', () => {
    const g = makeCaseView(input({})).groups[0];
    expect(g.marks?.map(m => [m.f, m.label])).toEqual([['img.cxr_infiltrate', 'Инфильтрат']]);
    expect(centerX(g.marks![0].area.outlines[0])).toBeLessThan(0.5);
  });

  test('«Практикант» и «Студент» — сразу; «Ординатор» и «Врач» — задачей; в разборе и у прототипа — сразу', () => {
    expect(makeCaseView(input({ difficulty: 'trainee' })).marks).toBe('show');
    expect(makeCaseView(input({ difficulty: 'student' })).marks).toBe('show');
    expect(makeCaseView(input({ difficulty: 'resident' })).marks).toBe('find');
    expect(makeCaseView(input({ difficulty: 'doctor' })).marks).toBe('find');
    expect(makeCaseView(input({})).marks).toBe('show');
  });

  test('попал — строка снимка «нашли сами»; промах — строка как была', () => {
    const hit = makeCaseView(input({ difficulty: 'doctor', looked: [{ f: 'img.cxr_infiltrate', hit: true }] }));
    expect(hit.groups[0].lines.find(l => l.f === 'img.cxr_infiltrate')?.self).toBe(true);
    expect(hit.looked).toEqual([{ f: 'img.cxr_infiltrate', hit: true }]);
    const miss = makeCaseView(input({ difficulty: 'doctor', looked: [{ f: 'img.cxr_infiltrate', hit: false }] }));
    expect(miss.groups[0].lines.find(l => l.f === 'img.cxr_infiltrate')?.self).toBeUndefined();
  });
});

/** Смена: первый в очереди — в кабинете, снимок груди сделан и пришёл. */
function withXray(): { s: ShiftState; id: string } {
  const s = newShift(db, { seed: 76, season: 'winter' });
  for (let i = 0; i < 600 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
  const id = s.queue[0];
  apply(db, s, { kind: 'call', id });
  apply(db, s, { kind: 'exam', exam: 'exam.xray_chest' });
  for (let i = 0; i < 120 && s.patients[id].pending.length > 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
  if (s.current !== id) apply(db, s, { kind: 'call', id });
  return { s, id };
}

describe('задача «Найдите на снимке» в смене', () => {
  test('попытка — одна на находку, только показанной находки пришедшего снимка; времени не тратит', () => {
    const { s, id } = withXray();
    const p = s.patients[id];
    const batch = p.results.find(r => r.exam === 'exam.xray_chest')!;
    expect(batch).toBeDefined();
    // находка снимка этого больного — показанная (для проверки)
    batch.obs.push({ f: 'img.cxr_infiltrate', shown: true, exam: 'exam.xray_chest', attrs: { side: 'right' } });
    const t = s.t;
    apply(db, s, { kind: 'look', f: 'img.cxr_infiltrate', hit: true });
    apply(db, s, { kind: 'look', f: 'img.cxr_infiltrate', hit: false });
    apply(db, s, { kind: 'look', f: 'img.cxr_edema', hit: true });
    expect(p.looked).toEqual([{ f: 'img.cxr_infiltrate', hit: true }]);
    expect(s.t).toBe(t);
  });

  test('попадания — опыт лучевой диагностики в профиле; с десяти — «Чтение снимков»; в профиле — её строка', async () => {
    await loadProfile();
    const { s, id } = withXray();
    const p = s.patients[id];
    p.results.find(r => r.exam === 'exam.xray_chest')!.obs.push({ f: 'img.cxr_infiltrate', shown: true, exam: 'exam.xray_chest' });
    apply(db, s, { kind: 'look', f: 'img.cxr_infiltrate', hit: true });
    apply(db, s, { kind: 'diagnose', id: 'cond.arvi' });
    apply(db, s, { kind: 'finish' });
    recordCases([{ seed: s.meta.seed, department: s.meta.department, day: 1, patient: p }]);
    expect(profile().experience[RADIOLOGY]).toBe(1);
    expect(skillsFor(db, { [RADIOLOGY]: 9 })).not.toContain(READING);
    expect(skillsFor(db, { [RADIOLOGY]: 10 })).toContain(READING);
    const row = specialtyRows({ experience: { [RADIOLOGY]: 3 } }).at(-1)!;
    expect([row.name, row.level, row.hint]).toEqual(['Лучевая диагностика', 'уровень 1', 'до следующего — 7\u00a0находок, показанных на снимках самим']);
  });

  test('«Чтение снимков»: свой снимок — без описания, анализ — как в базе; у нанятого врача — с описанием', () => {
    const xray = db.exams['exam.xray_chest'];
    expect(xray.time.report ?? 0).toBeGreaterThan(0);
    expect(reportMinutes(db, [], xray)).toBe(xray.time.report ?? 0);
    expect(reportMinutes(db, [READING], xray)).toBe(0);
    const lab = Object.values(db.exams).find(e => e.kind === 'lab' && (e.time.report ?? 0) > 0);
    if (lab) expect(reportMinutes(db, [READING], lab)).toBe(lab.time.report ?? 0);
    const s = newShift(db, { seed: 77, season: 'winter' });
    for (let i = 0; i < 600 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
    const id = s.queue[0];
    apply(db, s, { kind: 'call', id });
    const before = readyIn(db, s, s.patients[id], 'exam.xray_chest')!;
    s.meta.skills = [READING];
    const after = readyIn(db, s, s.patients[id], 'exam.xray_chest')!;
    expect(before - after).toBeCloseTo(xray.time.report ?? 0, 5);
  });
});
