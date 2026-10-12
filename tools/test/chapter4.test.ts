// Глава 4 «Большая больница» (spec 2026-10-chapter-4, часть 60а): городская больница в Верхнеборске — новая больница,
// как переход из главы 1 в главу 2: врач, история, подсказки — прежние; больница, штат, кандидаты, касса и репутация —
// новые; пока в прежней лежат больные — переход ждёт выписки. Готовая больница 56 × 40: в «Смене» — целиком, с
// реанимацией, боксами, эндоскопией, МРТ и специалистами; в начале главы кампании — без того, что строят заданием, и
// без специалистов: их нанимают — в главах 1–3 их среди кандидатов нет. Задания — приёмы специалистов, неделя
// смертности, смены без заразного в общей палате, антибиотик при сепсисе по серии сроков — и итоги дня для них; вид
// главы и «Смена».
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Id, Mission } from '../../src/content/types';
import { type CampaignView, dayOk, missionProgress, nextChapterOf, startChapter } from '../../src/engine/campaign/campaign';
import { presetHospital } from '../../src/engine/hospital/build';
import { presetStaff, type StaffMember } from '../../src/engine/hospital/staff';
import { generatePatient } from '../../src/engine/med/generate';
import { primaryOf, treatable } from '../../src/engine/med/plan';
import type { Patient } from '../../src/engine/med/types';
import { apply, current, departmentsOf, hospitalCtx, newCampaign, newSingle } from '../../src/engine/shift/engine';
import { type ColleagueDay, type DaySummary, SHIFT_SCHEMA_VERSION, SHIFT_START, type ShiftPatient, type ShiftState } from '../../src/engine/shift/types';
import { T } from '../../src/i18n';
import { memoryStore, saveSlot } from '../../src/state/saves';
import { callPatient, campaignView, examine, forgetShift, loadShift, moveToNextChapter, seenTip, setStore, singleVenues, sortAmbulance, tipView } from '../../src/state/session';

const ch3 = db.chapters['chapter.vascular'];
const ch4 = db.chapters['chapter.city'];
const city = db.presets['preset.city'];
const mission = (id: string) => ch4.missions.find(m => m.id === id)!;
const LATER = ['room.ricu', 'room.box', 'room.endoscopy', 'room.mri'];
const SPECIALISTS = ['role.endocrinologist', 'role.gastroenterologist', 'role.infectionist'];
const SEPSIS_T = 'target.sepsis_abx';
const SHOCK_T = 'target.sepsis_abx_shock';

/** Итог дня главы: по умолчанию — десять принятых, без стационара, сроков и нанятых врачей. */
const day = (n: number, x: Partial<DaySummary> = {}): DaySummary => ({
  day: n, arrived: 10, seen: 10, left: 0, unseen: 0, correct: 8, partly: 0, wrong: 2, grades: { A: 0, B: 0, C: 0, D: 0 }, money: 0,
  returnsPlanned: 0, returnsToday: 0, ...x,
});
const view = (history: DaySummary[], done: Record<string, number> = {}): CampaignView => ({ campaign: { ...startChapter(db, ch4.id, 0), done }, history });
/** Приёмы нанятого врача за день: столько, из них верно. */
const col = (role: Id | undefined, seen: number, correct: number): ColleagueDay => ({
  ...(role ? { role } : {}), seen, correct, partly: 0, wrong: seen - correct, grades: { A: 0, B: 0, C: 0, D: 0 },
});
/** Стационар за день: поступили, лежат вечером, умерли, переведены в тяжёлом состоянии вместо смерти. */
const ward = (admitted: number, lying: number, died = 0, severe = 0): Partial<DaySummary> => ({
  ward: { admitted, discharged: 0, early: 0, transferred: severe, lying, stayDays: 0, stayNorm: 0, ...(died ? { died } : {}), ...(severe ? { severe } : {}) },
});

/** Глава 4 с начала, а больница — вся, как в «Смене»: построено то, что строят заданием, специалисты на местах. */
function builtCity(seed: number): ShiftState {
  const s = newCampaign(db, { seed, season: 'winter', career: 1, chapter: ch4.id });
  s.hospital = presetHospital(db, city, [s.hospital!.w, s.hospital!.h]).hospital;
  s.staff = presetStaff(db, city);
  return s;
}

/**
 * Карьера в главе 3, выполненной в первый же день: день закрыт, подсказка показана; `admit` — первого пришедшего сама
 * положили в палату, и он лежит.
 */
function doneChapter3(seed: number, admit = false, career = 1): ShiftState {
  const s = newCampaign(db, { seed, season: 'winter', career, chapter: ch3.id });
  apply(db, s, { kind: 'nextDay' });
  if (admit) {
    const walkIn = () => Object.values(s.patients).find(p => p.status === 'waiting' && p.kind !== 'ambulance' && !p.bay);
    for (let i = 0; i < 6 * 60 && !walkIn(); i++) apply(db, s, { kind: 'advance', seconds: 60 });
    const p = walkIn()!;
    apply(db, s, { kind: 'call', id: p.id });
    apply(db, s, { kind: 'diagnose', id: p.patient.truth.conditions[0].id });
    apply(db, s, { kind: 'setting', setting: 'admit' });
    apply(db, s, { kind: 'finish' });
    expect(p.status).toBe('admitted');
  }
  apply(db, s, { kind: 'closeDay' });
  for (const m of ch3.missions) if (m.main) s.campaign!.done[m.id] = s.day;
  s.campaign!.complete = s.day;
  s.campaign!.tips = { shown: ['tip.start'] };
  return s;
}

/** Первый пришедший сам в открытый день — этот больной, у вас в кабинете. */
function walkIn(s: ShiftState, patient: Patient): ShiftPatient {
  for (let i = 0; i < 6 * 60; i++) {
    const p = Object.values(s.patients).find(q => q.status === 'waiting' && q.kind !== 'ambulance' && !q.to && !q.bay);
    if (p) {
      p.patient = patient;
      apply(db, s, { kind: 'call', id: p.id });
      expect(current(s)?.id).toBe(p.id);
      return p;
    }
    apply(db, s, { kind: 'advance', seconds: 60 });
  }
  throw new Error('за шесть часов никто не пришёл сам');
}

/**
 * Первая скорая дня везёт этого больного — подменён до приезда: показатели фельдшер меряет у него; в смотровой он
 * «красный» и у вас.
 */
function bay(s: ShiftState, patient: Patient): ShiftPatient {
  const p = Object.values(s.patients).filter(q => q.kind === 'ambulance' && q.status === 'coming').sort((a, b) => a.arriveT - b.arriveT)[0];
  if (!p) throw new Error('скорой в этот день нет');
  p.patient = patient;
  for (let i = 0; i < 12 * 60 && !(p.status === 'waiting' && p.bay); i++) apply(db, s, { kind: 'advance', seconds: 60 });
  apply(db, s, { kind: 'sort', id: p.id, triage: 'red' });
  apply(db, s, { kind: 'call', id: p.id });
  expect(current(s)?.id).toBe(p.id);
  return p;
}

describe('городская больница', () => {
  test('«Смена» — вся больница на участке 56 × 40: реанимация, боксы, эндоскопия, МРТ, специалисты и терапевт в кабинетах; всё работает', () => {
    const s = newSingle(db, { seed: 91, season: 'winter', venue: city.id });
    expect([s.hospital!.w, s.hospital!.h]).toEqual([56, 40]);
    const ctx = hospitalCtx(db, s);
    expect(ctx.plan.rooms.filter(r => !ctx.working.has(r.id)).map(r => r.type)).toEqual([]);
    expect(ctx.plan.rooms.length).toBe(city.rooms.length);
    for (const t of [...LATER, 'room.ct', 'room.icu', 'room.emergency', 'room.or']) expect(ctx.plan.rooms.map(r => r.type)).toContain(t);
    expect(s.staff!.filter(m => db.roles[m.role].stands).map(m => m.role).sort()).toEqual([...SPECIALISTS, 'role.therapist']);
    expect(departmentsOf(db, s)).toEqual(expect.arrayContaining(['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology', 'dept.infectious']));
  });

  test('начало главы 4 — без того, что строят заданием, и без специалистов: их три кабинета пустуют; номера помещений и людей — как в «Смене»', () => {
    const s = newCampaign(db, { seed: 92, season: 'winter', career: 1, chapter: ch4.id });
    expect([s.hospital!.w, s.hospital!.h]).toEqual(city.plot);
    const ctx = hospitalCtx(db, s);
    expect(ctx.plan.rooms.length).toBe(city.rooms.filter(r => !r.later).length);
    for (const t of LATER) expect(ctx.plan.rooms.map(r => r.type)).not.toContain(t);
    expect(ctx.plan.rooms.filter(r => !ctx.working.has(r.id)).map(r => r.type)).toEqual(['room.office', 'room.office', 'room.office']);
    expect(s.staff!.some(m => db.roles[m.role].profile)).toBe(false);
    const full = newSingle(db, { seed: 92, season: 'winter', venue: city.id });
    const ids = new Set(s.staff!.map(m => m.id));
    expect(s.staff!.map(m => [m.id, m.role, m.room])).toEqual(full.staff!.filter(m => ids.has(m.id)).map(m => [m.id, m.role, m.room]));
    expect(s.hospital!.rooms).toEqual(full.hospital!.rooms.slice(0, s.hospital!.rooms.length));
    // инфекционных больных без бокса не принимают; неврологию (кабинет КТ), хирургию и травму (приёмное) — да
    expect(departmentsOf(db, s)).toEqual(['dept.therapy', 'dept.neurology', 'dept.surgery', 'dept.trauma']);
    expect([s.economy!.cash, s.campaign!.chapter, s.meta.department]).toEqual([ch4.budget, ch4.id, ch4.department]);
    expect(s.campaign!.letters.map(l => l.id)).toEqual(['hello', 'sepsis', 'team']);
  });

  test('кандидаты: в главе 4 — и специалисты, и эндоскопист; в главах 1–3 специалистов нет', () => {
    const s = newCampaign(db, { seed: 93, season: 'winter', career: 1, chapter: ch4.id });
    const roles = new Set(s.candidates!.map(c => c.role));
    for (const r of [...SPECIALISTS, 'role.endoscopist', 'role.therapist', 'role.anesthetist', 'role.nurse']) expect(roles.has(r)).toBe(true);
    for (const id of ['chapter.district', 'chapter.hospital', ch3.id]) {
      const x = newCampaign(db, { seed: 93, season: 'winter', career: 1, chapter: id });
      expect(x.candidates!.some(c => db.roles[c.role].profile)).toBe(false);
      apply(db, x, { kind: 'nextDay' });
      apply(db, x, { kind: 'closeDay' });
      expect(x.candidates!.some(c => db.roles[c.role].profile)).toBe(false);
    }
  });

  test('реанимацию, боксы и эндоскопию строят у третьего коридора на бюджет главы — с запасом; задания «Открыть…» выполнены', () => {
    const s = newCampaign(db, { seed: 94, season: 'winter', career: 1, chapter: ch4.id });
    const cash = s.economy!.cash;
    let n = 0;
    const people: StaffMember[] = [];
    for (const r of city.rooms.filter(x => x.later && x.type !== 'room.mri')) {
      apply(db, s, { kind: 'build', cmd: { kind: 'room', type: r.type, size: r.size, x: r.x, y: r.y, rot: r.rot } });
      const room = s.hospital!.rooms[s.hospital!.rooms.length - 1];
      expect(room.type).toBe(r.type);
      for (const eq of r.equipment) apply(db, s, { kind: 'build', cmd: { kind: 'buy', room: room.id, equipment: eq } });
      // люди — по одному на должность помещения; кандидатов в день — один-два на должность, поэтому сразу в штат
      for (const role of db.rooms[r.type].staff) people.push({ id: `t${++n}`, role, sex: 'f', seed: n, skill: 3, salary: 3000, room: room.id, days: 0 });
    }
    apply(db, s, { kind: 'buildEnd' });
    s.staff = [...s.staff!, ...people];
    expect(cash - s.economy!.cash).toBeLessThan(0.8 * ch4.budget);
    const v = { campaign: s.campaign!, history: s.history, hospital: s.hospital, staff: s.staff };
    expect(['ricu', 'box', 'endoscopy', 'mri'].map(id => missionProgress(db, v, mission(id)).done)).toEqual([true, true, true, false]);
    expect(departmentsOf(db, s)).toContain('dept.infectious');
  });
});

describe('переход в главу 4', () => {
  test('новая больница: штат, кандидаты, касса и репутация — новые, возвратов нет; врач, история и подсказки — прежние', () => {
    const s = doneChapter3(101);
    expect(Object.values(s.patients).some(p => p.status === 'admitted')).toBe(false);
    s.returns = [{ day: s.day + 2, of: 'x', reason: 'worse' }];
    s.economy!.cash = 12_345;
    s.economy!.reputation = 71;
    const before = { seed: s.meta.seed, career: s.meta.career, history: s.history.length };
    expect(nextChapterOf(db, s.campaign!)?.id).toBe(ch4.id);
    apply(db, s, { kind: 'nextChapter' });
    expect([s.campaign!.chapter, s.campaign!.since, s.campaign!.complete, s.campaign!.done, s.campaign!.tips]).toEqual([ch4.id, s.day, undefined, {}, { shown: ['tip.start'] }]);
    expect(s.campaign!.letters).toEqual(ch4.letters.filter(l => l.when === 'start').map(l => ({ id: l.id, day: s.day })));
    expect([s.hospital!.w, s.hospital!.h, s.hospital!.rooms.length]).toEqual([...city.plot, city.rooms.filter(r => !r.later).length]);
    expect(s.staff).toEqual(presetStaff(db, city, true));
    expect([s.economy!.cash, s.economy!.reputation, s.meta.department, s.returns, s.undo, s.dayOpen]).toEqual([ch4.budget, db.economy.reputation.start, ch4.department, [], [], false]);
    expect(s.candidates!.some(c => db.roles[c.role].profile)).toBe(true);
    expect({ seed: s.meta.seed, career: s.meta.career, history: s.history.length }).toEqual(before);
    apply(db, s, { kind: 'nextDay' });
    expect(s.dayOpen).toBe(true);
  });

  test('пока в районной больнице лежат больные — переход ждёт выписки; те же команды — та же глава 4', () => {
    const s = doneChapter3(102, true);
    apply(db, s, { kind: 'nextChapter' });
    expect(s.campaign!.chapter).toBe(ch3.id);
    const run = () => {
      const x = doneChapter3(103);
      apply(db, x, { kind: 'nextChapter' });
      apply(db, x, { kind: 'nextDay' });
      apply(db, x, { kind: 'advance', seconds: 2 * 3600 });
      return JSON.stringify({ patients: x.patients, summary: x.summary, candidates: x.candidates, campaign: x.campaign, hospital: x.hospital });
    };
    expect(run()).toBe(run());
  });
});

describe('задания главы 4', () => {
  const GASTRO = 'role.gastroenterologist';
  const ENDO = 'role.endocrinologist';
  const INF = 'role.infectionist';

  test('приёмы специалистов: сто, точность от 85 %, принимали трое; терапевт и итоги без должности не в счёт', () => {
    const m = mission('staff');
    const three = { s1: col(GASTRO, 40, 36), s2: col(ENDO, 30, 27), s3: col(INF, 30, 27) };
    expect(missionProgress(db, view([day(1, { colleagues: three })]), m)).toEqual({ value: 100, target: 100, accuracy: 90, doctors: 3, done: true });
    // через несколько дней — то же; уволенного считают по его строке
    expect(missionProgress(db, view([day(1, { colleagues: { s1: col(GASTRO, 40, 36) } }), day(2, { colleagues: { s2: col(ENDO, 30, 27), s3: col(INF, 30, 27) } })]), m).done).toBe(true);
    const other = { s1: col(GASTRO, 40, 36), s2: col(ENDO, 30, 27), s4: col('role.therapist', 50, 50), s5: col(undefined, 30, 30) };
    expect(missionProgress(db, view([day(1, { colleagues: other })]), m)).toEqual({ value: 70, target: 100, accuracy: 90, doctors: 2, done: false });
    // точность ниже порога; двое специалистов — не трое
    expect(missionProgress(db, view([day(1, { colleagues: { s1: col(GASTRO, 50, 40), s2: col(ENDO, 30, 25), s3: col(INF, 30, 27) } })]), m)).toMatchObject({ value: 100, accuracy: 84, done: false });
    expect(missionProgress(db, view([day(1, { colleagues: { s1: col(GASTRO, 60, 55), s2: col(ENDO, 60, 55) } })]), m)).toMatchObject({ value: 100, doctors: 2, done: false });
    expect(missionProgress(db, view([day(1)], { staff: 1 }), m).done).toBe(true);
  });

  test('неделя смертности: семь дней подряд, лежавшие накануне и поступившие; умершие и переведённые в тяжёлом состоянии — поровну', () => {
    const m = mission('mortality');
    const week = (from: number, died = 0, severe = 0, admitted = 5) =>
      Array.from({ length: 7 }, (_, i) => day(from + i, ward(admitted, 20, i === 2 ? died : 0, i === 2 ? severe : 0)));
    expect(missionProgress(db, view(week(1).slice(0, 6)), m)).toEqual({ value: 6, target: 7, mortality: { died: 0, lying: 30 }, done: false });
    expect(missionProgress(db, view(week(1)), m)).toEqual({ value: 7, target: 7, mortality: { died: 0, lying: 35 }, done: true });
    // 1 из 35 — 2,9 %: больше двух
    expect(missionProgress(db, view(week(1, 1)), m)).toEqual({ value: 7, target: 7, mortality: { died: 1, lying: 35 }, done: false });
    expect(missionProgress(db, view(week(1, 0, 1)), m).done).toBe(false);
    // лежавшие вечером накануне первого дня — в счёт, хоть это и день прежней главы: 1 из 55 — 1,8 %
    expect(missionProgress(db, view([day(0, ward(0, 20)), ...week(1, 1)]), m)).toMatchObject({ mortality: { died: 1, lying: 55 }, done: true });
    // лежало меньше 30 — не в счёт, хоть никто и не умер
    expect(missionProgress(db, view(week(1, 0, 0, 4)), m)).toMatchObject({ mortality: { died: 0, lying: 28 }, done: false });
    // плохая неделя, потом хорошая — выполнено; ход — последняя неделя
    expect(missionProgress(db, view([...week(1, 3), ...week(8)]), m)).toMatchObject({ mortality: { died: 0, lying: 55 }, done: true });
  });

  test('смены без заразного в общей палате: заразные были, и ни один не лёг в общую палату', () => {
    expect(dayOk('noInfectiousInWard', day(1))).toBe(false);
    expect(dayOk('noInfectiousInWard', day(1, { isolation: { seen: 2, ward: 0 } }))).toBe(true);
    expect(dayOk('noInfectiousInWard', day(1, { isolation: { seen: 2, ward: 1 } }))).toBe(false);
    const m = mission('isolation') as Extract<Mission, { kind: 'days' }>;
    const ok = (n: number) => day(n, { isolation: { seen: 1, ward: 0 } });
    expect(missionProgress(db, view([ok(1), ok(2), day(3, { isolation: { seen: 1, ward: 1 } }), ok(4), ok(5)]), m)).toEqual({ value: 4, target: 5, done: false });
    expect(missionProgress(db, view([ok(1), ok(2), ok(3), ok(4), ok(5)]), m)).toEqual({ value: 5, target: 5, done: true });
  });

  test('сепсис: антибиотик при шоке и без шока — одна серия; задание — по сроку серии', () => {
    const m = mission('sepsis');
    expect([m.kind === 'deadline' && m.target, db.targets[SHOCK_T].series]).toEqual([SEPSIS_T, SEPSIS_T]);
    const seq = (x: Record<string, string>) => ({ targetSeq: x });
    expect(missionProgress(db, view([day(1, seq({ [SEPSIS_T]: 'A' })), day(2, seq({ [SEPSIS_T]: 'AA', [SHOCK_T]: 'A' }))]), m)).toEqual({ value: 3, target: 3, done: true });
    expect(missionProgress(db, view([day(1, seq({ [SEPSIS_T]: 'AAB' })), day(2, seq({ [SEPSIS_T]: 'A' }))]), m)).toEqual({ value: 1, target: 3, done: false });
    // строка срока при шоке сама задание не двигает: её оценки уже в строке серии
    expect(missionProgress(db, view([day(1, seq({ [SHOCK_T]: 'AAAAA' }))]), m).value).toBe(0);
  });
});

describe('итоги дня для заданий главы 4', () => {
  /** Больной сальмонеллёзом средней тяжести: ему нужен бокс. */
  function salmonella(from = 1): Patient {
    for (let seed = from; seed < from + 2000; seed++) {
      const p = generatePatient(db, seed, { department: 'dept.therapy', departments: ['dept.therapy', 'dept.infectious'], season: 'summer', primary: 'cond.salmonellosis', params: { severity: 'moderate' } });
      if (p.age >= 18) return p;
    }
    throw new Error('нет такого больного');
  }

  test('заразный, которому нужен бокс: в общей палате — в итогах дня и строкой разбора; в боксе — нет; приёмы инфекционисту — тоже в счёт', () => {
    const s = builtCity(111);
    apply(db, s, { kind: 'nextDay' });
    /** прибавка итогов изоляции за ваш приём: инфекционист тем временем принимает своих */
    const close = (setting: 'admit' | 'box', patient: Patient) => {
      const p = walkIn(s, patient);
      const was = { ...(s.summary.isolation ?? { seen: 0, ward: 0 }) };
      apply(db, s, { kind: 'diagnose', id: 'cond.salmonellosis' });
      apply(db, s, { kind: 'setting', setting });
      apply(db, s, { kind: 'finish' });
      expect(p.closed!.plan.setting).toBe(setting);
      const now = s.summary.isolation!;
      return { p, seen: now.seen - was.seen, ward: now.ward - was.ward };
    };
    const ward = close('admit', salmonella(1));
    expect([ward.p.closed!.notes.some(n => n.code === 'setting.contacts'), ward.seen, ward.ward]).toEqual([true, 1, 1]);
    expect(dayOk('noInfectiousInWard', s.summary)).toBe(false);
    const box = close('box', salmonella(3000));
    expect([box.p.closed!.notes.some(n => n.code === 'setting.contacts'), box.seen, box.ward]).toEqual([false, 1, 0]);
    // инфекционист кладёт в бокс: к вечеру заразных больше двух, в общей палате — один ваш
    for (let i = 0; i < 6 * 60; i++) apply(db, s, { kind: 'advance', seconds: 60 });
    expect(s.summary.isolation!.seen).toBeGreaterThan(2);
    expect(s.summary.isolation!.ward).toBe(1);
    // шесть часов смены с тремя специалистами — дольше пяти секунд по умолчанию
  }, 60_000);

  test('вне кампании итогов изоляции нет', () => {
    const s = newSingle(db, { seed: 112, season: 'winter', venue: city.id });
    const p = walkIn(s, salmonella(1));
    apply(db, s, { kind: 'diagnose', id: 'cond.salmonellosis' });
    apply(db, s, { kind: 'setting', setting: 'admit' });
    apply(db, s, { kind: 'finish' });
    expect(p.closed!.notes.some(n => n.code === 'setting.contacts')).toBe(true);
    expect(s.summary.isolation).toBeUndefined();
  });

  test('приёмы нанятого врача — с его должностью', () => {
    const s = builtCity(113);
    apply(db, s, { kind: 'nextDay' });
    // три специалиста и терапевт
    for (let i = 0; i < 8 * 60 && Object.keys(s.summary.colleagues ?? {}).length < 4; i++) apply(db, s, { kind: 'advance', seconds: 60 });
    const rows = Object.entries(s.summary.colleagues ?? {});
    for (const [id, c] of rows) expect(c.role).toBe(s.staff!.find(m => m.id === id)!.role);
    expect(rows.map(([, c]) => c.role).sort()).toEqual([...SPECIALISTS, 'role.therapist']);
  });

  test('антибиотик при септическом шоке в срок — оценка и в строке срока, и в строке серии', () => {
    for (let seed = 1; seed < 200; seed++) {
      const patient = generatePatient(db, seed, {
        department: 'dept.therapy', departments: ['dept.therapy', 'dept.surgery', 'dept.trauma'], season: 'winter', primary: 'cond.sepsis',
        params: { shock: 'yes', source: 'lungs', organ: 'mind' },
      });
      const s = newCampaign(db, { seed: 114, season: 'winter', career: 1, chapter: ch4.id });
      apply(db, s, { kind: 'nextDay' });
      const p = bay(s, patient);
      for (const exam of ['exam.vitals', 'exam.neuro_exam']) apply(db, s, { kind: 'exam', exam });
      for (const id of ['tx.blood_culture', 'tx.antibiotic_iv', 'tx.balanced_fluids', 'tx.norepinephrine']) apply(db, s, { kind: 'toggleTreatment', id });
      apply(db, s, { kind: 'diagnose', id: 'cond.sepsis' });
      apply(db, s, { kind: 'setting', setting: 'icu' });
      apply(db, s, { kind: 'finish' });
      if (!p.closed?.targets?.some(t => t.id === SHOCK_T)) continue;
      expect(p.closed.targets.find(t => t.id === SHOCK_T)!.grade).toBe('A');
      expect(s.summary.targetSeq).toMatchObject({ [SHOCK_T]: 'A', [SEPSIS_T]: 'A' });
      expect(s.summary.targets?.[SEPSIS_T]).toBeUndefined();
      return;
    }
    throw new Error('ни у одного больного qSOFA не дал двух баллов');
  });
});

describe('глава 4 между сменами', () => {
  beforeEach(() => {
    setStore(memoryStore());
    forgetShift();
  });

  test('глава 3 выполнена — «Перейти в городскую больницу»; лежат больные — ждать выписки; после перехода — письма, задания и «Смена»', async () => {
    const store = memoryStore();
    setStore(store);
    await saveSlot(store, 'campaign-1', doneChapter3(121, true), SHIFT_SCHEMA_VERSION, 'x');
    await loadShift('campaign', 1);
    expect(campaignView()!.next).toEqual({ title: T.campaign.chapter(4, ch4.name.ru), move: ch4.move!.ru, place: ch4.place.ru, text: T.campaign.moveText(ch3.place.ru), ready: false });
    expect((await singleVenues()).find(x => x.venue === city.id)).toMatchObject({ ok: false, hint: T.single.needChapter(4, ch4.name.ru) });

    await saveSlot(store, 'campaign-2', doneChapter3(122, false, 2), SHIFT_SCHEMA_VERSION, 'x');
    await loadShift('campaign', 2);
    expect(campaignView()!.next!.ready).toBe(true);
    moveToNextChapter();
    const v = campaignView()!;
    expect([v.title, v.place, v.day, v.complete, v.after, v.next]).toEqual([T.campaign.chapter(4, ch4.name.ru), ch4.place.ru, 0, false, undefined, undefined]);
    expect(v.missions.map(m => [m.id, m.progress])).toEqual([
      ['ricu', T.campaign.notYet],
      ['box', T.campaign.notYet],
      ['endoscopy', T.campaign.notYet],
      ['staff', '0 из 100, точность 0 %, специалистов 0 из 3'],
      ['sepsis', T.campaign.deadlineProgress(0, 3)],
      ['mortality', '0 из 7 дней'],
      ['mri', T.campaign.notYet],
      ['egd', T.campaign.deadlineProgress(0, 5)],
      ['isolation', T.campaign.dayProgress(0, 5)],
    ]);
    expect((await singleVenues()).find(x => x.venue === city.id)).toMatchObject({ ok: true, name: city.name.ru });
  });

  test('ход недели смертности словами', () => {
    const t = T.campaign;
    expect(t.mortalityProgress(3, 7, { died: 0, lying: 12 }, 30)).toBe('3 из 7 дней');
    expect(t.mortalityProgress(7, 7, { died: 0, lying: 20 }, 30)).toBe('за последние 7 дней лежали 20 — нужно не меньше 30');
    expect(t.mortalityProgress(7, 7, { died: 0, lying: 44 }, 30)).toBe('за последние 7 дней лежали 44, умерших нет');
    expect(t.mortalityProgress(7, 7, { died: 1, lying: 56 }, 30)).toBe('за последние 7 дней умер 1 из 56 лежавших — 1,8 %');
    expect(t.mortalityProgress(7, 7, { died: 2, lying: 41 }, 30)).toBe('за последние 7 дней умерли 2 из 41 лежавшего — 4,9 %');
  });

  test('глава 4 — последняя: выполнена — «следующей главы пока нет», кнопки нет', async () => {
    const store = memoryStore();
    setStore(store);
    const s = newCampaign(db, { seed: 123, season: 'winter', career: 2, chapter: ch4.id });
    s.campaign!.complete = 0;
    await saveSlot(store, 'campaign-2', s, SHIFT_SCHEMA_VERSION, 'x');
    await loadShift('campaign', 2);
    const c = campaignView()!;
    expect([c.after, c.next]).toEqual([T.campaign.completeLast, undefined]);
  });
});

describe('первая смена с заведующей реанимацией (часть 60б)', () => {
  const byArrival = (s: ShiftState) => Object.values(s.patients).sort((a, b) => a.arriveT - b.arriveT || (a.id < b.id ? -1 : 1));
  /** Глава 4 с начала, больница — вся: эндоскопия и бокс работают; открыт первый день; подсказки прежних глав показаны. */
  function firstShift(seed: number): ShiftState {
    const s = builtCity(seed);
    s.campaign!.tips = { shown: Object.values(db.tips).filter(t => t.chapter !== ch4.id).map(t => t.id) };
    apply(db, s, { kind: 'nextDay' });
    return s;
  }
  /** Построить на местах готовой больницы помещение этого вида, что строят заданием, — с аппаратами и людьми. */
  function open(s: ShiftState, type: Id) {
    const r = city.rooms.find(x => x.later && x.type === type)!;
    apply(db, s, { kind: 'build', cmd: { kind: 'room', type: r.type, size: r.size, x: r.x, y: r.y, rot: r.rot } });
    const room = s.hospital!.rooms[s.hospital!.rooms.length - 1];
    expect(room.type).toBe(type);
    for (const eq of r.equipment) apply(db, s, { kind: 'build', cmd: { kind: 'buy', room: room.id, equipment: eq } });
    apply(db, s, { kind: 'buildEnd' });
    s.staff = [...s.staff!, ...db.rooms[type].staff.map((role, i): StaffMember => ({ id: `t${room.id}-${i}`, role, sex: 'f', seed: i + 1, skill: 3, salary: 3000, room: room.id, days: 0 }))];
  }

  test('первая скорая — в первые двадцать минут, септический шок при пиелонефрите; потом пришедший сам — разрыв Мэллори–Вейсса, кровит; потом пришедшая сама — тяжёлое обезвоживание; каждый — не раньше чем через 40 минут после прежнего', () => {
    expect([ch4.tutorialRoom, ch4.tutorialGap, ch4.tutorial.map(t => t.condition)]).toEqual([['room.endoscopy', 'room.box'], 40, ['cond.sepsis', 'cond.mallory_weiss', 'cond.gastroenteritis']]);
    for (const seed of [131, 132, 133, 134]) {
      const s = firstShift(seed);
      expect(s.campaign!.tutorialDay).toBe(1);
      const ps = byArrival(s);
      const sepsis = ps.filter(p => p.kind === 'ambulance')[0];
      const tear = ps.find(p => p.kind !== 'ambulance' && primaryOf(p.patient).id === 'cond.mallory_weiss')!;
      const dry = ps.find(p => p.kind !== 'ambulance' && primaryOf(p.patient).id === 'cond.gastroenteritis' && primaryOf(p.patient).params.severity === 'severe')!;
      expect(sepsis.arriveT - SHIFT_START).toBeLessThanOrEqual(20 * 60);
      expect(tear.arriveT - sepsis.arriveT).toBeGreaterThanOrEqual(40 * 60);
      expect(dry.arriveT - tear.arriveT).toBeGreaterThanOrEqual(40 * 60);
      expect([tear.to, dry.to]).toEqual([undefined, undefined]);
      expect(primaryOf(sepsis.patient)).toMatchObject({ id: 'cond.sepsis', params: { source: 'urinary', shock: 'yes' } });
      expect(primaryOf(tear.patient)).toMatchObject({ id: 'cond.mallory_weiss', params: { active: 'yes' } });
      // жалобы заданы: без жара qSOFA не считают — срока антибиотика не было бы; срок ЭГДС — по рвоте кровью
      expect(sepsis.patient.complaints).toEqual(expect.arrayContaining(['sym.fever_hx', 'sym.flank_pain']));
      expect(tear.patient.complaints).toContain('sym.hematemesis');
      expect([sepsis, tear, dry].map(p => treatable(db, p.patient))).toEqual([true, true, true]);
    }
  });

  test('после перехода — без эндоскопии и бокса обычные дни, с одной эндоскопией — тоже; первая смена с заведующей — в первый день, когда работают оба', () => {
    const s = doneChapter3(135);
    apply(db, s, { kind: 'nextChapter' });
    apply(db, s, { kind: 'nextDay' });
    expect(s.campaign!.tutorialDay).toBeUndefined();
    apply(db, s, { kind: 'closeDay' });
    open(s, 'room.endoscopy');
    apply(db, s, { kind: 'nextDay' });
    expect(s.campaign!.tutorialDay).toBeUndefined();
    apply(db, s, { kind: 'closeDay' });
    open(s, 'room.box');
    apply(db, s, { kind: 'nextDay' });
    expect(s.campaign!.tutorialDay).toBe(s.day);
    const today = byArrival(s).filter(p => p.id.startsWith(`${s.day}-`));
    expect(primaryOf(today.filter(p => p.kind === 'ambulance')[0].patient)).toMatchObject({ id: 'cond.sepsis', params: { shock: 'yes' } });
    expect(today.some(p => primaryOf(p.patient).id === 'cond.mallory_weiss')).toBe(true);
    // назавтра — как обычно
    apply(db, s, { kind: 'closeDay' });
    apply(db, s, { kind: 'nextDay' });
    expect(s.campaign!.tutorialDay).toBe(s.day - 1);
  });

  test('подсказки заведующей — только в главе 4 и только в первую смену с ней', async () => {
    const scoped = Object.values(db.tips).filter(t => t.chapter === ch4.id);
    expect(scoped.map(t => [t.id, t.from, t.when])).toEqual([
      ['tip.sepsis', 'char.icu_head', { condition: 'cond.sepsis' }],
      ['tip.mallory', 'char.icu_head', { condition: 'cond.mallory_weiss' }],
      ['tip.dehydration', 'char.icu_head', { condition: 'cond.gastroenteritis' }],
    ]);
    const s = firstShift(136);
    const waiting = () => Object.values(s.patients).find(p => p.kind === 'ambulance' && p.status === 'waiting' && !p.sorted);
    for (let i = 0; i < 40 && !waiting(); i++) apply(db, s, { kind: 'advance', seconds: 60 });
    const amb = waiting()!;
    expect(primaryOf(amb.patient).id).toBe('cond.sepsis');
    const store = memoryStore();
    setStore(store);
    forgetShift();
    await saveSlot(store, 'campaign-1', s, SHIFT_SCHEMA_VERSION, 'x');
    await loadShift('campaign', 1);
    sortAmbulance(amb.id, 'red');
    expect(callPatient(amb.id)).toBe(true);
    expect(tipView('card')).toBeUndefined();
    examine('exam.ask_complaints');
    expect([tipView('card')?.id, tipView('card')?.from]).toEqual(['tip.sepsis', db.characters['char.icu_head'].short.ru]);
    seenTip('tip.sepsis', 'card');
    expect(tipView('card')).toBeUndefined();
  });
});
