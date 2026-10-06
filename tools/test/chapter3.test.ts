// Глава 3 «Сердце и мозг» (spec 2026-10-chapter-3, часть 45а): та же районная больница, к участку
// которой справа пристраивают крыло. Переход из выполненной главы 2 — между сменами и без ожидания
// выписки: штат, построенное, лежащие, кто должен вернуться, репутация и касса с бюджетом главы —
// прежние, участок шире на крыло, отмена стройки — с чистого листа; в крыле строят кабинет КТ и ПИТ.
// Готовая больница главы — районная с крылом: КТ, ПИТ на четыре койки и УЗИ. Задания — срок у больных
// подряд, тромболизис без противопоказаний, смены без пропущенного инфаркта — и итоги дня для них;
// вид главы и «Смена».
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Cell, Id, Mission } from '../../src/content/types';
import { type CampaignView, dayOk, missionProgress, nextChapterOf, startChapter } from '../../src/engine/campaign/campaign';
import { generatePatient } from '../../src/engine/med/generate';
import type { Patient } from '../../src/engine/med/types';
import { type HospitalState, planOf, widenPlot } from '../../src/engine/hospital/build';
import { apply, current, departmentsOf, emergencyBays, freeBeds, hospitalCtx, icuBeds, newCampaign, newSingle } from '../../src/engine/shift/engine';
import { type DaySummary, SHIFT_SCHEMA_VERSION, type ShiftPatient, type ShiftState } from '../../src/engine/shift/types';
import { T } from '../../src/i18n';
import { memoryStore, saveSlot } from '../../src/state/saves';
import { campaignView, forgetShift, loadShift, moveToNextChapter, savedGames, setStore, shiftState, singleVenues } from '../../src/state/session';

const ch2 = db.chapters['chapter.hospital'];
const ch3 = db.chapters['chapter.vascular'];
const mission = (id: string) => ch3.missions.find(m => m.id === id)!;
const ACS = 'cond.acs';
const LYSIS = 'tx.thrombolysis';
const ECG = 'target.ecg_chest_pain';
const CT = 'target.stroke_ct';
const CHEST = 'sym.chest_pain_pressing';
const RISKS = ['risk.anticoagulants', 'risk.bleeding_tendency', 'risk.recent_bleed_surgery', 'risk.stroke_history'];

/** Итог дня главы: по умолчанию — десять принятых, без сроков, тромболизисов и ОКС. */
const day = (n: number, x: Partial<DaySummary> = {}): DaySummary => ({
  day: n, arrived: 10, seen: 10, left: 0, unseen: 0, correct: 8, partly: 0, wrong: 2, grades: { A: 0, B: 0, C: 0, D: 0 }, money: 0,
  returnsPlanned: 0, returnsToday: 0, ...x,
});
const view = (history: DaySummary[], done: Record<string, number> = {}): CampaignView => ({ campaign: { ...startChapter(db, ch3.id, 0), done }, history });

/** Клетки прямоугольника: x0, y0, x1, y1 включительно. */
const rect = (x0: number, y0: number, x1: number, y1: number): Cell[] =>
  Array.from({ length: (x1 - x0 + 1) * (y1 - y0 + 1) }, (_, i) => [x0 + (i % (x1 - x0 + 1)), y0 + Math.floor(i / (x1 - x0 + 1))]);
/** Клетки коридора — координатами, а не номерами: номер зависит от ширины участка. */
const corridorCells = (h: HospitalState) => h.corridor.map(i => [i % h.w, Math.floor(i / h.w)]);

/**
 * Карьера в главе 2, выполненной в первый же её день: первый пришедший сам лежит в палате, день
 * закрыт, подсказка показана.
 */
function doneChapter2(seed = 71): ShiftState {
  const s = newCampaign(db, { seed, season: 'winter', career: 1, chapter: ch2.id });
  apply(db, s, { kind: 'nextDay' });
  const walkIn = () => Object.values(s.patients).find(p => p.status === 'waiting' && p.kind !== 'ambulance' && !p.bay);
  for (let i = 0; i < 6 * 60 && !walkIn(); i++) apply(db, s, { kind: 'advance', seconds: 60 });
  const p = walkIn()!;
  apply(db, s, { kind: 'call', id: p.id });
  expect(current(s)?.id).toBe(p.id);
  apply(db, s, { kind: 'diagnose', id: p.patient.truth.conditions[0].id });
  apply(db, s, { kind: 'setting', setting: 'admit' });
  apply(db, s, { kind: 'finish' });
  expect(p.status).toBe('admitted');
  apply(db, s, { kind: 'closeDay' });
  for (const m of ch2.missions) if (m.main) s.campaign!.done[m.id] = s.day;
  s.campaign!.complete = s.day;
  s.campaign!.tips = { shown: ['tip.start'] };
  return s;
}

/** Глава 3 с начала — готовая больница с крылом, открыт первый день; первый привезённый в смотровую — этот больной. */
function bay(seed: number, patient: Patient): { s: ShiftState; p: ShiftPatient } {
  const s = newCampaign(db, { seed, season: 'winter', career: 1, chapter: ch3.id });
  apply(db, s, { kind: 'nextDay' });
  for (let i = 0; i < 6 * 60; i++) {
    const p = Object.values(s.patients).find(q => q.kind === 'ambulance' && q.status === 'waiting' && !q.sorted && q.bay);
    if (p) {
      p.patient = patient;
      return { s, p };
    }
    apply(db, s, { kind: 'advance', seconds: 60 });
  }
  throw new Error('за шесть часов скорая в смотровую не приехала');
}

/** Принять лежащего в смотровой: ЭКГ у постели, расспрос о противопоказаниях (`ask`), лечение, диагноз — и перевод. */
function treat(s: ShiftState, p: ShiftPatient, diagnosis: Id, treatments: Id[], ask = true) {
  apply(db, s, { kind: 'sort', id: p.id, triage: 'red' });
  apply(db, s, { kind: 'call', id: p.id });
  expect(current(s)?.id).toBe(p.id);
  apply(db, s, { kind: 'exam', exam: 'exam.ecg' });
  if (ask) apply(db, s, { kind: 'exam', exam: 'exam.ask_lysis' });
  for (const id of treatments) apply(db, s, { kind: 'toggleTreatment', id });
  apply(db, s, { kind: 'diagnose', id: diagnosis });
  apply(db, s, { kind: 'setting', setting: 'ambulance' });
  apply(db, s, { kind: 'finish' });
}

/** Больной ОКС с давящей болью в груди и без противопоказаний к тромболизису; `params` — его форма. */
function acs(params: Record<string, string>, from = 1): Patient {
  for (let seed = from; seed < from + 2000; seed++) {
    const p = generatePatient(db, seed, { department: 'dept.therapy', departments: ['dept.therapy', 'dept.surgery', 'dept.trauma'], season: 'winter', primary: ACS, params });
    if (p.complaints.includes(CHEST) && !RISKS.some(r => p.truth.risks.includes(r))) return p;
  }
  throw new Error('нет такого больного');
}

describe('районная больница с сосудистым отделением', () => {
  test('районная больница главы 2 с крылом: всё работает — КТ, ПИТ на четыре койки и УЗИ; неврологию привозят', () => {
    const s = newCampaign(db, { seed: 72, season: 'winter', career: 1, chapter: ch3.id });
    const ctx = hospitalCtx(db, s);
    expect(ctx.plan.rooms.filter(r => !ctx.working.has(r.id)).map(r => r.type)).toEqual([]);
    const types = ctx.plan.rooms.map(r => r.type);
    for (const t of ['room.ct', 'room.icu', 'room.ultrasound', 'room.emergency', 'room.or']) expect(types).toContain(t);
    expect([s.hospital!.w, s.hospital!.h]).toEqual(db.presets[ch3.preset].plot);
    expect([freeBeds(db, s).length, emergencyBays(db, s).length, icuBeds(db, s).length]).toEqual([8, 2, 4]);
    expect(departmentsOf(db, s)).toEqual(['dept.therapy', 'dept.surgery', 'dept.trauma', 'dept.neurology']);
    expect([s.economy!.cash, s.campaign!.chapter]).toEqual([ch3.budget, ch3.id]);
    expect(s.campaign!.letters.map(l => l.id)).toEqual(ch3.letters.filter(l => l.when === 'start').map(l => l.id));
  });

  test('«Смена» в ней — на её участке, с её штатом', () => {
    const s = newSingle(db, { seed: 73, season: 'winter', venue: ch3.preset });
    expect([s.hospital!.w, s.hospital!.h]).toEqual(db.presets[ch3.preset].plot);
    expect(hospitalCtx(db, s).plan.rooms.filter(r => !hospitalCtx(db, s).working.has(r.id))).toEqual([]);
    expect(departmentsOf(db, s)).toContain('dept.neurology');
  });
});

describe('участок шире', () => {
  test('крыло справа: помещения, вход и коридор — на прежних клетках; больница — новым объектом', () => {
    const h = newCampaign(db, { seed: 74, season: 'winter', career: 1, chapter: ch2.id }).hospital!;
    const w = widenPlot(h, 12);
    expect(w).not.toBe(h);
    expect([w.w, w.h, w.entrance, w.rooms, w.decor]).toEqual([h.w + 12, h.h, h.entrance, h.rooms, h.decor]);
    expect(corridorCells(w)).toEqual(corridorCells(h));
    const at = (x: HospitalState) => planOf(db, x).rooms.map(r => [r.id, r.x, r.y, r.door]);
    expect(at(w)).toEqual(at(h));
  });
});

describe('переход в главу 3', () => {
  test('та же больница: штат, построенное, лежащие, возвраты и репутация — прежние; касса — с бюджетом главы; участок шире на крыло', () => {
    const s = doneChapter2();
    const lying = Object.values(s.patients).filter(p => p.status === 'admitted').map(p => p.id);
    expect(lying.length).toBe(1);
    s.returns = [{ day: s.day + 2, of: lying[0], reason: 'worse' }];
    s.economy!.cash = 12_345;
    s.economy!.reputation = 71;
    const h = s.hospital!;
    const before = {
      rooms: h.rooms, corridor: corridorCells(h), staff: s.staff, returns: s.returns, seed: s.meta.seed, career: s.meta.career, history: s.history.length,
    };
    expect(nextChapterOf(db, s.campaign!)?.id).toBe(ch3.id);
    apply(db, s, { kind: 'nextChapter' });
    expect(s.campaign!.chapter).toBe(ch3.id);
    expect([s.campaign!.since, s.campaign!.complete, s.campaign!.done, s.campaign!.tips]).toEqual([s.day, undefined, {}, { shown: ['tip.start'] }]);
    expect(s.campaign!.letters).toEqual(ch3.letters.filter(l => l.when === 'start').map(l => ({ id: l.id, day: s.day })));
    const w = s.hospital!;
    expect([w.w, w.h, w.entrance]).toEqual([h.w + ch3.wing!, h.h, h.entrance]);
    expect([w.rooms, corridorCells(w), s.staff, s.returns]).toEqual([before.rooms, before.corridor, before.staff, before.returns]);
    expect({ seed: s.meta.seed, career: s.meta.career, history: s.history.length }).toEqual({ seed: before.seed, career: before.career, history: before.history });
    expect([s.economy!.cash, s.economy!.reputation, s.meta.department, s.undo, s.dayOpen]).toEqual([12_345 + ch3.budget, 71, ch3.department, [], false]);
    expect(Object.values(s.patients).filter(p => p.status === 'admitted').map(p => p.id)).toEqual(lying);
    // построенное работает, как работало
    const ctx = hospitalCtx(db, s);
    expect(ctx.plan.rooms.filter(r => !ctx.working.has(r.id)).map(r => r.type)).toEqual([]);
    // первый день главы 3 — в той же больнице; лежащий — на обходе, как был
    apply(db, s, { kind: 'nextDay' });
    expect([s.dayOpen, s.patients[lying[0]].status]).toEqual([true, 'admitted']);
  });

  test('нельзя днём и пока глава 2 не выполнена; те же команды — та же глава 3', () => {
    const open = doneChapter2(75);
    apply(db, open, { kind: 'nextDay' });
    apply(db, open, { kind: 'nextChapter' });
    expect([open.campaign!.chapter, open.hospital!.w]).toEqual([ch2.id, db.presets[ch2.preset].plot[0]]);

    const fresh = newCampaign(db, { seed: 76, season: 'winter', career: 1, chapter: ch2.id });
    const cash = fresh.economy!.cash;
    apply(db, fresh, { kind: 'nextChapter' });
    expect([fresh.campaign!.chapter, fresh.economy!.cash]).toEqual([ch2.id, cash]);

    const run = () => {
      const s = doneChapter2(77);
      apply(db, s, { kind: 'nextChapter' });
      apply(db, s, { kind: 'nextDay' });
      apply(db, s, { kind: 'advance', seconds: 2 * 3600 });
      return JSON.stringify({ patients: s.patients, summary: s.summary, candidates: s.candidates, campaign: s.campaign, hospital: s.hospital });
    };
    expect(run()).toBe(run());
  });

  test('в крыле строят кабинет КТ и ПИТ: коридоры продлевают, помещения встают за прежним краем; бюджета хватает', () => {
    const s = doneChapter2(78);
    apply(db, s, { kind: 'nextChapter' });
    const cash = s.economy!.cash;
    const edge = db.presets[ch2.preset].plot[0];
    apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells: rect(38, 7, 49, 9) } });
    apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells: rect(38, 17, 49, 19) } });
    apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.ct', size: 'M', x: edge + 1, y: 0, rot: 0 } });
    apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.icu', size: 'M', x: edge + 1, y: 20, rot: 2 } });
    const ct = s.hospital!.rooms.find(r => r.type === 'room.ct')!;
    const icu = s.hospital!.rooms.find(r => r.type === 'room.icu')!;
    expect([ct, icu].every(r => r && r.x >= edge)).toBe(true);
    apply(db, s, { kind: 'build', cmd: { kind: 'buy', room: ct.id, equipment: 'eq.ct_16' } });
    for (let i = 0; i < 4; i++) apply(db, s, { kind: 'build', cmd: { kind: 'buy', room: icu.id, equipment: 'eq.monitor_defib' } });
    apply(db, s, { kind: 'buildEnd' });
    for (const [role, room] of [['role.radiographer', ct.id], ['role.radiologist', ct.id], ['role.nurse', icu.id], ['role.anesthetist', icu.id]]) {
      const c = s.candidates!.find(x => x.role === role && !s.staff!.some(m => m.id === x.id));
      expect(c).toBeDefined();
      apply(db, s, { kind: 'hire', id: c!.id });
      apply(db, s, { kind: 'assign', id: c!.id, room });
    }
    const ctx = hospitalCtx(db, s);
    expect([ctx.working.has(ct.id), ctx.working.has(icu.id), icuBeds(db, s).length]).toEqual([true, true, 4]);
    expect(departmentsOf(db, s)).toContain('dept.neurology');
    // крыло обошлось в бюджет главы с запасом
    expect(cash - s.economy!.cash).toBeLessThan(ch3.budget);
    const v = { campaign: s.campaign!, history: s.history, hospital: s.hospital, staff: s.staff };
    expect([missionProgress(db, v, mission('ctRoom')).done, missionProgress(db, v, mission('icu')).done]).toEqual([true, true]);
  });
});

describe('задания главы 3', () => {
  test('срок у больных подряд: серия идёт через дни и рвётся первым опозданием; ход — нынешняя серия, выполнено — по лучшей', () => {
    const m = mission('ecg');
    const seq = (x: string, target = ECG) => ({ targetSeq: { [target]: x } });
    expect(missionProgress(db, view([day(1, seq('AAAAA')), day(2, seq('AAAAA'))]), m)).toEqual({ value: 10, target: 10, done: true });
    expect(missionProgress(db, view([day(1, seq('AAAAAAAAA')), day(2, seq('B'))]), m)).toEqual({ value: 0, target: 10, done: false });
    expect(missionProgress(db, view([day(1, seq('AAD')), day(2), day(3, seq('AAA'))]), m)).toEqual({ value: 3, target: 10, done: false });
    // десять подряд были — выполнено, что бы ни было потом
    expect(missionProgress(db, view([day(1, seq('AAAAAAAAAA')), day(2, seq('C'))]), m)).toEqual({ value: 10, target: 10, done: true });
    expect(missionProgress(db, view([day(1, seq('D'))], { ecg: 1 }), m)).toEqual({ value: 10, target: 10, done: true });
    // чужой срок не в счёт; КТ при инсульте — пять подряд
    expect(missionProgress(db, view([day(1, seq('AAAAAAAAAA', CT))]), m).value).toBe(0);
    expect(missionProgress(db, view([day(1, seq('AAAAA', CT))]), mission('ct'))).toEqual({ value: 5, target: 5, done: true });
  });

  test('тромболизис: в окне и без противопоказаний; с противопоказанием или не по показаниям — не в счёт', () => {
    const m = mission('lysis');
    expect(missionProgress(db, view([day(1, { lysis: { good: 0, bad: 2 } })]), m)).toEqual({ value: 0, target: 1, done: false });
    expect(missionProgress(db, view([day(1, { lysis: { good: 0, bad: 1 } }), day(2, { lysis: { good: 1, bad: 0 } })]), m)).toEqual({ value: 1, target: 1, done: true });
  });

  test('смена без пропущенного инфаркта: ОКС были, и ни один не пропущен; пять таких смен — задание', () => {
    expect(dayOk('noMissedMI', day(1))).toBe(false);
    expect(dayOk('noMissedMI', day(1, { acs: { seen: 2, missed: 0 } }))).toBe(true);
    expect(dayOk('noMissedMI', day(1, { acs: { seen: 2, missed: 1 } }))).toBe(false);
    const m = mission('noMissedMI') as Extract<Mission, { kind: 'days' }>;
    const ok = (n: number) => day(n, { acs: { seen: 1, missed: 0 } });
    expect(missionProgress(db, view([ok(1), ok(2), day(3), ok(4), ok(5)]), m)).toEqual({ value: 4, target: 5, done: false });
    expect(missionProgress(db, view([ok(1), ok(2), day(3), ok(4), ok(5), ok(6)]), m)).toEqual({ value: 5, target: 5, done: true });
  });
});

describe('итоги дня для заданий главы 3', () => {
  test('ЭКГ в срок, ОКС распознан, тромболизис в окне и без противопоказаний', () => {
    const { s, p } = bay(81, acs({ type: 'stemi', early: 'yes' }));
    treat(s, p, ACS, [LYSIS]);
    expect(p.closed!.plan.treatments).toContain(LYSIS);
    expect(s.summary.targetSeq?.[ECG]).toBe('A');
    expect([s.summary.lysis, s.summary.acs]).toEqual([{ good: 1, bad: 0 }, { seen: 1, missed: 0 }]);
    expect(dayOk('noMissedMI', s.summary)).toBe(true);
  });

  test('о противопоказаниях не спросили — тромболизис не в счёт, даже если их нет', () => {
    const { s, p } = bay(81, acs({ type: 'stemi', early: 'yes' }));
    treat(s, p, ACS, [LYSIS], false);
    expect(p.closed!.notes.some(n => n.code === 'safety.notAsked')).toBe(true);
    expect([s.summary.lysis, s.summary.acs]).toEqual([{ good: 0, bad: 1 }, { seen: 1, missed: 0 }]);
  });

  test('ОКС без подъёма ST принят за другое, а тромболизис ему вреден: пропущен и не в счёт', () => {
    const { s, p } = bay(82, acs({ type: 'nste' }));
    treat(s, p, 'cond.gerd', [LYSIS]);
    expect(p.closed!.verdict).toBe('wrong');
    expect([s.summary.lysis, s.summary.acs]).toEqual([{ good: 0, bad: 1 }, { seen: 1, missed: 1 }]);
    expect(dayOk('noMissedMI', s.summary)).toBe(false);
  });
});

describe('глава 3 между сменами', () => {
  beforeEach(() => {
    setStore(memoryStore());
    forgetShift();
  });

  test('глава 2 выполнена — «Открыть сосудистое отделение» с листом о крыле, лежащих ждать не нужно; после перехода — письма и задания главы 3', async () => {
    const store = memoryStore();
    setStore(store);
    const s = doneChapter2(83);
    expect(Object.values(s.patients).some(p => p.status === 'admitted')).toBe(true);
    await saveSlot(store, 'campaign-1', s, SHIFT_SCHEMA_VERSION, 'x');
    await loadShift('campaign', 1);
    const venues = await singleVenues();
    expect(venues.find(x => x.venue === ch3.preset)).toMatchObject({ ok: false, hint: T.single.needChapter(3, ch3.name.ru) });
    const c = campaignView()!;
    expect(c.next).toEqual({
      title: T.campaign.chapter(3, ch3.name.ru), move: ch3.move!.ru, place: ch3.place.ru, text: T.campaign.moveWingText(T.common.rub(ch3.budget)), ready: true,
    });
    expect(c.next!.text).toContain('2 500 000');

    moveToNextChapter();
    const v = campaignView()!;
    expect([v.title, v.place, v.day, v.complete, v.after, v.next]).toEqual([T.campaign.chapter(3, ch3.name.ru), ch3.place.ru, 0, false, undefined, undefined]);
    expect(v.letters.map(l => [l.id, l.from])).toEqual([...ch3.letters.filter(l => l.when === 'start')].reverse().map(l => [l.id, db.characters[l.from].short.ru]));
    expect(v.missions.map(m => [m.id, m.progress])).toEqual([
      ['ecg', '0 из 10 больных подряд'],
      ['ct', '0 из 5 больных подряд'],
      ['lysis', '0 из 1'],
      ['ctRoom', T.campaign.notYet],
      ['icu', T.campaign.notYet],
      ['noMissedMI', T.campaign.dayProgress(0, 5)],
      ['swallow', '0 из 5 больных подряд'],
    ]);
    expect(shiftState()!.hospital!.w).toBe(db.presets[ch2.preset].plot[0] + ch3.wing!);
    const games = await savedGames();
    expect(games.filter(g => g.mode === 'campaign' && g.career === 1).map(g => [g.chapter, g.day, g.mains])).toEqual([[ch3.id, 0, { done: 0, of: 5 }]]);
    // «Смена»: открылась и районная больница с сосудистым отделением
    const after = await singleVenues();
    expect(after.find(x => x.venue === ch3.preset)).toMatchObject({ ok: true, name: db.presets[ch3.preset].name.ru });
  });

  test('глава 3 — последняя: выполнена — «в следующей версии», кнопки нет', async () => {
    const store = memoryStore();
    setStore(store);
    const s = newCampaign(db, { seed: 84, season: 'winter', career: 2, chapter: ch3.id });
    s.campaign!.complete = 0;
    await saveSlot(store, 'campaign-2', s, SHIFT_SCHEMA_VERSION, 'x');
    await loadShift('campaign', 2);
    const c = campaignView()!;
    expect([c.after, c.next]).toEqual([T.campaign.completeLater(4), undefined]);
  });
});
