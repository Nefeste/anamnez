// Глава 2 «Приёмное» (spec 2026-09-chapter-2, часть 34): районная больница из каталога — всё
// работает, кабинета УЗИ нет, скорая ездит; переход из выполненной главы 1 между сменами — новые
// больница, штат, касса и репутация, прежние врач и итоги; задания главы — сортировка скорой,
// операции без осложнения, сроки стационара, дни без осложнений из-за ожидания; вид главы.
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { ContentDb, Mission } from '../../src/content/types';
import { P_ONE } from '../../src/engine/core/rng';
import { type CampaignView, dayOk, missionProgress, nextChapterOf, startChapter } from '../../src/engine/campaign/campaign';
import { generatePatient } from '../../src/engine/med/generate';
import type { Patient } from '../../src/engine/med/types';
import { apply, current, departmentsOf, emergencyBays, freeBeds, hospitalCtx, newCampaign } from '../../src/engine/shift/engine';
import { primaryOf } from '../../src/engine/med/plan';
import { complicationAt, onsetHours } from '../../src/engine/shift/surgery';
import { DAY, type DaySummary, SHIFT_SCHEMA_VERSION, SHIFT_START, type ShiftPatient, type ShiftState } from '../../src/engine/shift/types';
import { T } from '../../src/i18n';
import { memoryStore, saveSlot } from '../../src/state/saves';
import {
  callPatient, campaignView, chooseDiagnosis, chooseSetting, closeDay, examine, finishCase, forgetShift, loadShift, moveToNextChapter, nextDay, savedGames, seenTip,
  setStore, shiftState, singleVenues, sortAmbulance, tipView,
} from '../../src/state/session';

const ch1 = db.chapters['chapter.district'];
const ch2 = db.chapters['chapter.hospital'];
const mission = (id: string) => ch2.missions.find(m => m.id === id)!;

/** Итог дня главы: по умолчанию — десять принятых, без скорой, палат и операций. */
const day = (n: number, x: Partial<DaySummary> = {}): DaySummary => ({
  day: n, arrived: 10, seen: 10, left: 0, unseen: 0, correct: 8, partly: 0, wrong: 2, grades: { A: 0, B: 0, C: 0, D: 0 }, money: 0,
  returnsPlanned: 0, returnsToday: 0, ...x,
});
const view = (history: DaySummary[], done: Record<string, number> = {}): CampaignView => ({ campaign: { ...startChapter(db, ch2.id, 0), done }, history });

/** Карьера, у которой глава 1 выполнена в день 3; день закрыт, подсказка показана. */
function doneChapter1(seed = 41): ShiftState {
  const s = newCampaign(db, { seed, season: 'winter', career: 1, difficulty: 'student' });
  s.day = 3;
  s.history = [1, 2, 3].map(n => day(n));
  for (const m of ch1.missions) if (m.main) s.campaign!.done[m.id] = 3;
  s.campaign!.complete = 3;
  s.campaign!.tips = { shown: ['tip.start'] };
  return s;
}

/** Глава 2 с начала: районная больница, касса — бюджет главы. */
const chapter2 = (seed = 51) => newCampaign(db, { seed, season: 'winter', career: 1, chapter: ch2.id });

describe('районная больница', () => {
  test('работает всё; палаты — восемь коек, смотровая — два места; кабинета УЗИ нет', () => {
    const s = chapter2();
    const ctx = hospitalCtx(db, s);
    const types = ctx.plan.rooms.map(r => r.type);
    expect(ctx.plan.rooms.filter(r => !ctx.working.has(r.id)).map(r => r.type)).toEqual([]);
    for (const t of ['room.reception', 'room.waiting', 'room.office', 'room.triage', 'room.procedure', 'room.lab', 'room.ecg', 'room.xray', 'room.toilet', 'room.staff', 'room.emergency', 'room.or']) {
      expect(types).toContain(t);
    }
    expect(types.filter(t => t === 'room.ward').length).toBe(2);
    expect(types).not.toContain('room.ultrasound');
    expect([freeBeds(db, s).length, emergencyBays(db, s).length]).toEqual([8, 2]);
    expect(departmentsOf(db, s)).toEqual(['dept.therapy', 'dept.surgery', 'dept.trauma']);
    expect([s.economy!.cash, s.economy!.reputation]).toEqual([ch2.budget, db.economy.reputation.start]);
    expect(s.campaign!.letters.map(l => l.id)).toEqual(ch2.letters.filter(l => l.when === 'start').map(l => l.id));
  });

  test('кабинет УЗИ ставится справа от ординаторской на бюджет главы; врач УЗД — среди кандидатов', () => {
    const s = chapter2();
    apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.ultrasound', size: 'S', x: 34, y: 0, rot: 0 } });
    const us = s.hospital!.rooms.find(r => r.type === 'room.ultrasound');
    expect(us).toBeDefined();
    apply(db, s, { kind: 'build', cmd: { kind: 'buy', room: us!.id, equipment: 'eq.us_basic' } });
    apply(db, s, { kind: 'buildEnd' });
    const sonographer = s.candidates!.find(c => c.role === 'role.sonographer');
    expect(sonographer).toBeDefined();
    apply(db, s, { kind: 'hire', id: sonographer!.id });
    apply(db, s, { kind: 'assign', id: sonographer!.id, room: us!.id });
    expect(hospitalCtx(db, s).working.has(us!.id)).toBe(true);
    // запас на первые дни остаётся
    expect(s.economy!.cash).toBeGreaterThanOrEqual(100_000);
    expect(missionProgress(db, { campaign: s.campaign!, history: s.history, hospital: s.hospital, staff: s.staff }, mission('ultrasound')).done).toBe(true);
  });

  test('первая смена: скорая едет, пришедшие — с болезнями терапии, хирургии и травмы', () => {
    const departments = new Set<string>();
    let cars = 0;
    for (const seed of [51, 52, 53, 54]) {
      const s = chapter2(seed);
      apply(db, s, { kind: 'nextDay' });
      expect(s.dayOpen).toBe(true);
      const all = Object.values(s.patients);
      cars += all.filter(p => p.kind === 'ambulance').length;
      for (const p of all) departments.add(db.conditions[p.patient.truth.conditions[0].id].department);
    }
    expect(cars).toBeGreaterThanOrEqual(4 * db.economy.ambulance.perDay[0]);
    expect([...departments].sort()).toEqual(['dept.surgery', 'dept.therapy', 'dept.trauma']);
  });
});

describe('переход в главу 2', () => {
  test('новые больница, штат, кандидаты, касса и репутация; прежние врач, сложность, итоги и подсказки; возврат снят', () => {
    const s = doneChapter1();
    // вернуться должен был в амбулаторию посёлка — его там и ждут
    s.returns = [{ day: 4, of: '3-01', reason: 'worse' }];
    const before = { seed: s.meta.seed, history: s.history.length, career: s.meta.career, difficulty: s.meta.difficulty };
    s.economy!.cash = 12_345;
    s.economy!.reputation = 71;
    apply(db, s, { kind: 'nextChapter' });
    expect(s.campaign!.chapter).toBe(ch2.id);
    expect([s.campaign!.since, s.campaign!.complete, s.campaign!.done]).toEqual([3, undefined, {}]);
    expect(s.campaign!.tips).toEqual({ shown: ['tip.start'] });
    expect(s.campaign!.letters).toEqual(ch2.letters.filter(l => l.when === 'start').map(l => ({ id: l.id, day: 3 })));
    expect({ seed: s.meta.seed, history: s.history.length, career: s.meta.career, difficulty: s.meta.difficulty }).toEqual(before);
    expect([s.day, s.dayOpen, s.economy!.cash, s.economy!.reputation, s.returns]).toEqual([3, false, ch2.budget, db.economy.reputation.start, []]);
    expect(s.hospital!.rooms.map(r => r.type)).toEqual(db.presets[ch2.preset].rooms.map(r => r.type));
    expect(s.staff!.map(m => m.role)).toEqual(db.presets[ch2.preset].staff.map(x => x.role));
    // в районной больнице нанимают и хирургов, и врачей УЗД
    expect(s.candidates!.some(c => c.role === 'role.surgeon')).toBe(true);
    // первый день главы 2 — в районной больнице, со скорой
    apply(db, s, { kind: 'nextDay' });
    expect([s.day, s.dayOpen, emergencyBays(db, s).length]).toEqual([4, true, 2]);
    expect(Object.values(s.patients).some(p => p.kind === 'ambulance')).toBe(true);
  });

  test('нельзя, пока глава не выполнена, днём и из последней главы', () => {
    const fresh = newCampaign(db, { seed: 42, season: 'winter', career: 1 });
    apply(db, fresh, { kind: 'nextChapter' });
    expect(fresh.campaign!.chapter).toBe(ch1.id);

    const open = doneChapter1();
    apply(db, open, { kind: 'nextDay' });
    apply(db, open, { kind: 'nextChapter' });
    expect([open.campaign!.chapter, open.dayOpen]).toEqual([ch1.id, true]);

    const last = chapter2();
    last.campaign!.complete = 0;
    expect(nextChapterOf(db, last.campaign!)).toBeUndefined();
    const cash = last.economy!.cash;
    apply(db, last, { kind: 'nextChapter' });
    expect([last.campaign!.chapter, last.economy!.cash]).toEqual([ch2.id, cash]);
  });

  test('те же команды — та же глава 2', () => {
    const run = () => {
      const s = doneChapter1(43);
      apply(db, s, { kind: 'nextChapter' });
      apply(db, s, { kind: 'nextDay' });
      apply(db, s, { kind: 'advance', seconds: 3 * 3600 });
      return JSON.stringify({ patients: s.patients, queue: s.queue, summary: s.summary, candidates: s.candidates, campaign: s.campaign });
    };
    expect(run()).toBe(run());
  });
});

describe('задания главы 2', () => {
  test('сортировка: лучшая смена без недооценённых и переоценённых, отсортировано не меньше четырёх', () => {
    const m = mission('triage');
    const amb = (sorted: number, under = 0, over = 0) => ({ ambulance: { arrived: sorted, sorted, under, over } });
    expect(missionProgress(db, view([day(1, amb(3)), day(2, amb(5, 1))]), m)).toEqual({ value: 3, target: 4, done: false });
    expect(missionProgress(db, view([day(1, amb(6, 0, 1)), day(2, amb(4))]), m)).toEqual({ value: 4, target: 4, done: true });
    expect(missionProgress(db, view([day(1)]), m).value).toBe(0);
  });

  test('операции: без осложнения и без смерти после неё', () => {
    const m = mission('operation');
    const op = (done: number, good: number) => ({ surgery: { done, onTime: done, late: 0, complications: done - good, good } });
    expect(missionProgress(db, view([day(1, op(1, 0))]), m)).toEqual({ value: 0, target: 1, done: false });
    expect(missionProgress(db, view([day(1, op(1, 0)), day(2, op(2, 1))]), m)).toEqual({ value: 1, target: 1, done: true });
  });

  test('сроки стационара: десять выписанных подряд, в среднем не дольше обычного; выписка раньше срока рвёт серию', () => {
    const m = mission('stay');
    const ward = (discharged: number, stayDays: number, stayNorm: number, early = 0) => ({ ward: { admitted: 0, discharged, early, transferred: 0, lying: 0, stayDays, stayNorm } });
    expect(missionProgress(db, view([day(1, ward(4, 12, 16)), day(2, ward(6, 18, 24))]), m)).toEqual({ value: 10, target: 10, stay: { days: 3, norm: 4 }, done: true });
    // дольше обычного — не выполнено, но видно, насколько
    expect(missionProgress(db, view([day(1, ward(10, 50, 40))]), m)).toEqual({ value: 10, target: 10, stay: { days: 5, norm: 4 }, done: false });
    // ранняя выписка вчера: считается только то, что после неё
    expect(missionProgress(db, view([day(1, ward(9, 20, 36)), day(2, ward(3, 6, 12, 1)), day(3, ward(2, 6, 8))]), m)).toEqual({ value: 2, target: 10, stay: { days: 3, norm: 4 }, done: false });
    expect(missionProgress(db, view([day(1)]), m)).toEqual({ value: 0, target: 10, done: false });
  });

  test('день без осложнений из-за ожидания: операции были, и никто не осложнился, пока ждал', () => {
    const h = (surgery?: DaySummary['surgery']) => day(1, surgery ? { surgery } : {});
    expect(dayOk('noWaitComplication', h())).toBe(false);
    expect(dayOk('noWaitComplication', h({ done: 2, onTime: 2, late: 0, complications: 0, complicated: 1 }))).toBe(true);
    expect(dayOk('noWaitComplication', h({ done: 2, onTime: 1, late: 1, complications: 0, complicated: 1, waited: 1 }))).toBe(false);
    const m = mission('onTime') as Extract<Mission, { kind: 'days' }>;
    const ok = h({ done: 1, onTime: 1, late: 0, complications: 0 });
    expect(missionProgress(db, view([ok, h(), ok, ok].map((x, i) => ({ ...x, day: i + 1 }))), m)).toEqual({ value: 3, target: m.days, done: true });
  });
});

describe('операции в итогах дня: без осложнения, осложнилось в ожидании', () => {
  /** База без осложнений и смертей после аппендэктомии; `early` — доля перфорации за первые 36 ч. */
  function base(early?: number): ContentDb {
    const d = structuredClone(db);
    const op = d.treatments['tx.appendectomy'].surgery!;
    op.complications = 0;
    op.death = 0;
    if (op.complicated) {
      op.complicated.complications = 0;
      op.complicated.death = 0;
    }
    if (early !== undefined) d.conditions['cond.appendicitis'].complication!.early!.p = early;
    return d;
  }

  /** Привезённый скорой: этот пациент; ждёт `hours` у входа, потом — «красный», решение — операция. */
  function operate(d: ContentDb, s: ShiftState, patient: Patient, hours: number): ShiftPatient {
    for (let i = 0; i < 80 && !Object.values(s.patients).some(p => p.kind === 'ambulance' && p.status === 'waiting' && !p.sorted); i++) apply(d, s, { kind: 'advance', seconds: 5 * 60 });
    const p = Object.values(s.patients).find(x => x.kind === 'ambulance' && x.status === 'waiting' && !x.sorted)!;
    p.patient = patient;
    if (hours > 0) apply(d, s, { kind: 'advance', seconds: hours * 3600 });
    apply(d, s, { kind: 'sort', id: p.id, triage: 'red' });
    expect(current(s)).toBeUndefined();
    apply(d, s, { kind: 'call', id: p.id });
    apply(d, s, { kind: 'diagnose', id: 'cond.appendicitis' });
    apply(d, s, { kind: 'setting', setting: 'surgery' });
    apply(d, s, { kind: 'finish' });
    for (let i = 0; i < 40 && !p.stay?.op?.done; i++) apply(d, s, { kind: 'advance', seconds: 10 * 60 });
    return p;
  }

  const patient = (d: ContentDb, pick: (margin: number) => boolean): Patient => {
    for (let k = 0; k < 5000; k++) {
      const p = generatePatient(d, 70_000 + k, { department: 'dept.therapy', season: 'winter', primary: 'cond.appendicitis', params: {} });
      if (p.truth.risks.some(r => r.startsWith('risk.allergy_'))) continue;
      if (pick(complicationAt(d, p) - onsetHours(p))) return p;
    }
    throw new Error('нет такого пациента');
  };

  test('вовремя и без осложнения — «без осложнения»; осложнилось, пока ждал у входа, — «в ожидании»', () => {
    const d = base();
    const s = newCampaign(d, { seed: 61, season: 'winter', career: 1, chapter: ch2.id });
    apply(d, s, { kind: 'nextDay' });
    const p = operate(d, s, patient(d, m => m > 48), 0);
    expect(p.stay?.op?.done).toBe(true);
    expect(s.summary.surgery).toMatchObject({ done: 1, good: 1 });
    expect(s.summary.surgery!.waited).toBeUndefined();

    // перфорация — у каждого за первые 36 ч, а у этого — меньше чем через час после приезда
    const e = base(P_ONE);
    const t = newCampaign(e, { seed: 62, season: 'winter', career: 1, chapter: ch2.id });
    apply(e, t, { kind: 'nextDay' });
    const q = operate(e, t, patient(e, m => m > 0 && m < 1), 2);
    expect(q.stay?.op?.complicated).toBe(true);
    expect(t.summary.surgery).toMatchObject({ done: 1, complicated: 1, waited: 1, good: 1 });
    expect(dayOk('noWaitComplication', t.summary)).toBe(false);
  });
});

describe('глава между сменами', () => {
  beforeEach(() => {
    setStore(memoryStore());
    forgetShift();
  });

  test('выполнена — «Перейти в районную больницу» с листом; после перехода — глава 2 с письмами и заданиями', async () => {
    const store = memoryStore();
    setStore(store);
    forgetShift();
    await saveSlot(store, 'campaign-1', doneChapter1(44), SHIFT_SCHEMA_VERSION, 'x');
    await loadShift('campaign', 1);
    const c = campaignView()!;
    expect([c.title, c.complete, c.after]).toEqual([T.campaign.chapter(1, ch1.name.ru), true, T.campaign.completeNext]);
    expect(c.next).toEqual({ title: T.campaign.chapter(2, ch2.name.ru), move: ch2.move!.ru, place: ch2.place.ru, text: T.campaign.moveText(ch1.place.ru), ready: true });

    moveToNextChapter();
    const v = campaignView()!;
    expect([v.title, v.place, v.day, v.complete, v.after, v.next]).toEqual([T.campaign.chapter(2, ch2.name.ru), ch2.place.ru, 0, false, undefined, undefined]);
    expect(v.letters.map(l => [l.id, l.from, l.day])).toEqual([...ch2.letters.filter(l => l.when === 'start')].reverse().map(l => [l.id, db.characters[l.from].short.ru, 0]));
    expect(v.missions.map(m => [m.id, m.progress])).toEqual([
      ['triage', 'лучшая смена: 0 из 4 пациентов скорой'],
      ['operation', '0 из 1 операции'],
      ['stay', '0 из 10 выписанных подряд'],
      ['ultrasound', T.campaign.notYet],
      ['onTime', '0 из 3 дней'],
    ]);
    expect(shiftState()!.hospital!.rooms.some(r => r.type === 'room.or')).toBe(true);

    // сохранение — уже главы 2; «Смена» — и в районной больнице, и в амбулатории посёлка
    const games = await savedGames();
    // день в строке карьеры — день главы: перед первой сменой главы 2 — ноль
    expect(games.filter(g => g.mode === 'campaign' && g.career === 1).map(g => [g.chapter, g.day, g.mains])).toEqual([[ch2.id, 0, { done: 0, of: 3 }]]);
    const venues = await singleVenues();
    expect(venues.filter(x => x.ok).map(x => x.venue)).toEqual(expect.arrayContaining(['preset.clinic', 'preset.village', 'preset.district']));
  });

  test('последняя глава выполнена — «в следующей версии», кнопки нет; ход сроков стационара — со средним', async () => {
    const s = chapter2(45);
    s.campaign!.complete = 0;
    s.history = [day(1, { ward: { admitted: 3, discharged: 3, early: 0, transferred: 0, lying: 0, stayDays: 10, stayNorm: 15 } })];
    const store = memoryStore();
    setStore(store);
    forgetShift();
    await saveSlot(store, 'campaign-2', { ...s, meta: { ...s.meta, career: 2 } }, SHIFT_SCHEMA_VERSION, 'x');
    await loadShift('campaign', 2);
    const c = campaignView()!;
    expect([c.after, c.next]).toEqual([T.campaign.completeLater(3), undefined]);
    expect(c.missions.find(m => m.id === 'stay')!.progress).toBe('3 из 10 выписанных подряд · в среднем 3,3 сут. при обычных 5');
  });
});

describe('первая смена главы 2 с наставником (часть 34б)', () => {
  /** Первый день главы 2 после перехода; подсказки главы 1 уже показаны. */
  function firstShift(seed: number): ShiftState {
    const s = doneChapter1(seed);
    s.campaign!.tips = { shown: Object.values(db.tips).filter(t => !t.chapter).map(t => t.id) };
    apply(db, s, { kind: 'nextChapter' });
    apply(db, s, { kind: 'nextDay' });
    return s;
  }
  const byArrival = (s: ShiftState) => Object.values(s.patients).sort((a, b) => a.arriveT - b.arriveT || (a.id < b.id ? -1 : 1));
  const waiting = (s: ShiftState) => Object.values(s.patients).find(p => p.kind === 'ambulance' && p.status === 'waiting' && !p.sorted);

  test('первая скорая — в первые двадцать минут, с аппендицитом; первый пришедший сам — перелом лодыжек без смещения; вторая скорая — тяжёлая пневмония', () => {
    expect(ch2.tutorial.map(t => t.condition)).toEqual(['cond.appendicitis', 'cond.ankle_fracture', 'cond.pneumonia_cap']);
    for (const seed of [71, 72, 73, 74, 75, 76]) {
      const s = firstShift(seed);
      const ps = byArrival(s);
      const amb = ps.filter(p => p.kind === 'ambulance');
      const walk = ps.filter(p => p.kind !== 'ambulance' && !p.returnOf);
      expect(amb[0].arriveT - ((s.day - 1) * DAY + SHIFT_START)).toBeLessThanOrEqual(20 * 60);
      expect(primaryOf(amb[0].patient).id).toBe('cond.appendicitis');
      // аппендицит — у молодого: так его и учат узнавать
      expect(amb[0].patient.age).toBeGreaterThanOrEqual(18);
      expect(amb[0].patient.age).toBeLessThanOrEqual(40);
      expect(primaryOf(walk[0].patient)).toMatchObject({ id: 'cond.ankle_fracture', params: { stability: 'stable' } });
      expect(primaryOf(amb[1].patient)).toMatchObject({ id: 'cond.pneumonia_cap', params: { severity: 'severe' } });
      // остальные — не заданные: заданных ровно трое
      const taught = ps.filter(p => p === amb[0] || p === amb[1] || p === walk[0]);
      expect(taught.length).toBe(3);
    }
  });

  test('второй день главы — как обычно; те же зерно и команды — те же заданные пациенты', () => {
    const s = firstShift(77);
    const first = byArrival(s).filter(p => p.kind === 'ambulance').map(p => p.patient);
    expect(byArrival(firstShift(77)).filter(p => p.kind === 'ambulance').map(p => p.patient)).toEqual(first);
    apply(db, s, { kind: 'closeDay' });
    apply(db, s, { kind: 'nextDay' });
    const second = Object.values(s.patients).filter(p => p.id.startsWith(`${s.day}-`) && p.kind === 'ambulance');
    expect(second.some(p => primaryOf(p.patient).id === 'cond.appendicitis' && p.arriveT - ((s.day - 1) * DAY + SHIFT_START) <= 20 * 60)).toBe(false);
  });

  test('подсказки главы 2 — только в ней: в главе 1 при аппендиците заведующий хирургией не подсказывает', () => {
    const scoped = Object.values(db.tips).filter(t => t.chapter === ch2.id).map(t => t.id).sort();
    expect(scoped).toEqual(['tip.appendicitis', 'tip.handover', 'tip.rounds']);
    expect(db.tips['tip.appendicitis'].from).toBe('char.surgeon');
  });

  test('скорая ждёт сортировки — «Лист передачи»; у аппендицита — заведующий хирургией; утром — «Обход»', async () => {
    const s = firstShift(78);
    for (let i = 0; i < 40 && !waiting(s); i++) apply(db, s, { kind: 'advance', seconds: 60 });
    const amb = waiting(s)!;
    expect(primaryOf(amb.patient).id).toBe('cond.appendicitis');
    const store = memoryStore();
    setStore(store);
    forgetShift();
    await saveSlot(store, 'campaign-1', s, SHIFT_SCHEMA_VERSION, 'x');
    await loadShift('campaign', 1);
    expect([tipView('queue')?.id, tipView('queue')?.from]).toEqual(['tip.handover', db.characters['char.mentor'].short.ru]);
    seenTip('tip.handover', 'queue');
    expect(tipView('queue')).toBeUndefined();
    sortAmbulance(amb.id, 'red');
    expect(callPatient(amb.id)).toBe(true);
    expect(tipView('card')).toBeUndefined();
    examine('exam.ask_onset');
    expect([tipView('card')?.id, tipView('card')?.from]).toEqual(['tip.appendicitis', db.characters['char.surgeon'].short.ru]);
    seenTip('tip.appendicitis', 'card');
    chooseDiagnosis('cond.appendicitis');
    chooseSetting('surgery');
    finishCase();
    expect(shiftState()!.patients[amb.id].status).toBe('admitted');
    // в первую смену обхода нет: лежащий — только что положенный; утром — подсказка
    closeDay();
    nextDay();
    expect(shiftState()!.day).toBe(shiftState()!.campaign!.since + 2);
    expect(tipView('rounds')?.id).toBe('tip.rounds');
    seenTip('tip.rounds', 'rounds');
    expect(tipView('rounds')).toBeUndefined();
    // на третий день подсказок нет
    closeDay();
    nextDay();
    expect(tipView('queue')).toBeUndefined();
  });
});

