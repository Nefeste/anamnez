// Кампания (spec 2026-09-campaign, часть 11): карьера с главы 1 — больница главы и бюджет,
// письма в начале; задания по итогам дней и больнице; письма после дня, при задании и в
// конце главы; в главе строят только разрешённое; три карьеры — три независимых сохранения.
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Mission } from '../../src/content/types';
import { type CampaignView, campaignEvening, dayOk, missionProgress, startChapter } from '../../src/engine/campaign/campaign';
import { emptyLedger } from '../../src/engine/economy/economy';
import { apply, current, newCampaign } from '../../src/engine/shift/engine';
import type { Command, DaySummary, ShiftState } from '../../src/engine/shift/types';
import { memoryStore } from '../../src/state/saves';
import { campaignView, forgetShift, loadShift, readLetter, saved, savedGames, setStore, shiftState, startCampaign } from '../../src/state/session';

const ch = db.chapters['chapter.district'];
const mission = (id: string) => ch.missions.find(m => m.id === id)!;
const run = (s: ShiftState, ...cmds: Command[]) => {
  for (const c of cmds) apply(db, s, c);
  return s;
};
/** Итог дня: сколько пришло, принято, верно, ушло; антибиотики без показаний; касса дня. */
const day = (n: number, x: Partial<DaySummary> & { net?: number } = {}): DaySummary => {
  const ledger = emptyLedger();
  if (x.net !== undefined) (x.net >= 0 ? (ledger.income.oms = x.net) : (ledger.expenses.salaries = -x.net));
  return {
    day: n, arrived: 10, seen: 10, left: 0, unseen: 0, correct: 8, partly: 0, wrong: 2, grades: { A: 0, B: 0, C: 0, D: 0 }, money: 0,
    returnsPlanned: 0, returnsToday: 0, ...x,
    ...(x.net !== undefined ? { economy: { ledger, cash: 0, reputation: { from: 50, to: 50, reasons: [] }, level: { level: 100, rooms: [] } } } : {}),
  };
};
const view = (history: DaySummary[], done: Record<string, number> = {}): CampaignView => ({ campaign: { ...startChapter(db, ch.id, 0), done }, history });

describe('глава 1: начало', () => {
  test('карьера — с главы 1: амбулатория посёлка без лаборатории и рентгена, бюджет главы, письма в начале', () => {
    const s = newCampaign(db, { seed: 5, season: 'winter', career: 2 });
    expect([s.meta.mode, s.meta.career, s.day, s.dayOpen, s.economy!.cash]).toEqual(['campaign', 2, 0, false, ch.budget]);
    const types = s.hospital!.rooms.map(r => r.type);
    expect(types).not.toContain('room.lab');
    expect(types).not.toContain('room.xray');
    expect(types).toContain('room.ecg');
    expect(s.staff!.every(m => m.room)).toBe(true);
    expect(s.campaign!.letters.map(l => [l.id, l.day])).toEqual(ch.letters.filter(l => l.when === 'start').map(l => [l.id, 0]));
  });

  test('в главе строят только разрешённое: рентген — в главе 2', () => {
    const s = newCampaign(db, { seed: 6, season: 'winter', career: 1 });
    expect(ch.build).not.toContain('room.xray');
    const cash = s.economy!.cash;
    run(s, { kind: 'build', cmd: { kind: 'room', type: 'room.xray', size: 'M', x: 30, y: 16, rot: 0 } });
    expect([s.hospital!.rooms.some(r => r.type === 'room.xray'), s.economy!.cash]).toEqual([false, cash]);
    run(s, { kind: 'build', cmd: { kind: 'room', type: 'room.toilet', size: 'S', x: 30, y: 16, rot: 0 } });
    expect(s.hospital!.rooms.some(r => r.type === 'room.toilet' && r.x === 30)).toBe(true);
  });
});

describe('задания', () => {
  test('«принять N с точностью от P %» — по дням главы; выполненное остаётся выполненным', () => {
    const m = mission('seen') as Extract<Mission, { kind: 'seen' }>;
    const days = (k: number, correct: number) => Array.from({ length: k }, (_, i) => day(i + 1, { seen: 10, correct }));
    expect(missionProgress(db, view(days(3, 9)), m)).toEqual({ value: 30, target: m.count, accuracy: 90, done: false });
    expect(missionProgress(db, view(days(4, 8)), m).done).toBe(m.accuracy <= 80);
    expect(missionProgress(db, view(days(4, 5)), m)).toMatchObject({ value: 40, accuracy: 50, done: false });
    expect(missionProgress(db, view(days(1, 0), { seen: 3 }), m).done).toBe(true);
  });

  test('«N дней подряд» — считаются последние дни подряд; «N дней» — любые', () => {
    const streak = mission('antibiotics') as Extract<Mission, { kind: 'streak' }>;
    const bad = { needlessAntibiotic: 1 };
    expect(dayOk('noNeedlessAntibiotic', day(1))).toBe(true);
    expect(dayOk('noNeedlessAntibiotic', day(1, bad))).toBe(false);
    expect(dayOk('noNeedlessAntibiotic', day(1, { seen: 0 }))).toBe(false);
    const hist = [day(1), day(2), day(3, bad), day(4), day(5)];
    expect(missionProgress(db, view(hist), streak)).toEqual({ value: 2, target: streak.days, done: false });
    expect(missionProgress(db, view([...hist, day(6)]), streak).done).toBe(true);
    const cash = mission('cash') as Extract<Mission, { kind: 'days' }>;
    const mixed = [day(1, { net: 500 }), day(2, { net: -1 }), day(3, { net: 0 }), day(4, { net: 1 }), day(5, { net: -9 })];
    expect(missionProgress(db, view(mixed), cash)).toEqual({ value: 3, target: cash.days, done: false });
    expect(missionProgress(db, view([...mixed, day(6, { net: 2 }), day(7, { net: 3 })]), cash).done).toBe(true);
    expect(dayOk('noLeft', day(1, { left: 1 }))).toBe(false);
    expect(dayOk('noLeft', day(1, { arrived: 0 }))).toBe(false);
  });

  test('«открыть лабораторию» — когда лаборатория работает: помещение, анализатор, лаборант', () => {
    const s = newCampaign(db, { seed: 7, season: 'winter', career: 1 });
    const lab = mission('lab');
    const v = () => ({ campaign: s.campaign!, history: s.history, hospital: s.hospital, staff: s.staff });
    expect(missionProgress(db, v(), lab).done).toBe(false);
    // место лаборатории в амбулатории практики — пустое: там и строим, дверью к коридору
    const rec = db.presets[ch.preset].rooms[0];
    const [dx, dy] = [s.hospital!.rooms[0].x - rec.x, s.hospital!.rooms[0].y - rec.y];
    run(s, { kind: 'build', cmd: { kind: 'room', type: 'room.lab', size: 'S', x: 22 + dx, y: dy, rot: 0 } });
    const room = s.hospital!.rooms.find(r => r.type === 'room.lab')!;
    expect(room).toBeDefined();
    run(s, { kind: 'build', cmd: { kind: 'buy', room: room.id, equipment: 'eq.hematology_analyzer' } });
    expect(missionProgress(db, v(), lab).done).toBe(false);
    const tech = s.candidates!.find(c => c.role === 'role.lab_tech')!;
    run(s, { kind: 'hire', id: tech.id }, { kind: 'assign', id: tech.id, room: room.id });
    expect(missionProgress(db, v(), lab).done).toBe(true);
  });
});

describe('письма и конец главы', () => {
  test('после дня N, при задании и в конце — когда выполнены все основные; каждое письмо — один раз', () => {
    const first = day(1, { seen: 10, correct: 9, left: 1 });
    const c = view([first]).campaign;
    const got1 = campaignEvening(db, { campaign: c, history: [first] }, 1);
    expect(got1).toEqual({ done: [], letters: ['firstDay'] });
    const hist = [first, ...Array.from({ length: 3 }, (_, i) => day(i + 2, { seen: 10, correct: 9 }))];
    const got4 = campaignEvening(db, { campaign: c, history: hist }, 4);
    expect(got4.done).toEqual(['seen', 'antibiotics', 'noLeft']);
    expect(got4.letters).toEqual(['seenDone', 'antibioticsDone']);
    expect(c.complete).toBeUndefined();
    // лаборатория — последнее основное: глава выполнена, письмо «в конце»
    c.done.lab = 5;
    const again = campaignEvening(db, { campaign: c, history: [...hist, day(5)] }, 5);
    expect(again.letters).toEqual(['end']);
    expect(c.complete).toBe(5);
    expect(campaignEvening(db, { campaign: c, history: [...hist, day(5), day(6)] }, 6).letters).toEqual([]);
  });

  test('смена в главе: вечером задания и письма — в итогах дня; антибиотик без показаний — в счёт дня', () => {
    // первый пациент, которому амоксициллин не показан (вирусная инфекция и т. п.)
    let s: ShiftState | undefined;
    for (let seed = 9; seed < 80 && !s; seed++) {
      const x = newCampaign(db, { seed, season: 'winter', career: 1 });
      run(x, { kind: 'nextDay' });
      for (let i = 0; i < 600 && x.queue.length === 0; i++) apply(db, x, { kind: 'advance', seconds: 60 });
      const truth = db.conditions[x.patients[x.queue[0]].patient.truth.conditions[0].id];
      if (truth.treatment?.notIndicated.includes('tx.amoxicillin')) s = x;
    }
    expect(s).toBeDefined();
    run(s!, { kind: 'call', id: s!.queue[0] }, { kind: 'diagnose', id: 'cond.arvi' }, { kind: 'toggleTreatment', id: 'tx.amoxicillin' });
    const p = current(s!)!;
    run(s!, { kind: 'finish' }, { kind: 'closeDay' });
    expect(p.closed!.notes).toContainEqual({ code: 'tx.notIndicated', tx: 'tx.amoxicillin' });
    const h = s!.history[0];
    expect(h.needlessAntibiotic).toBe(1);
    expect(h.campaign?.letters).toContain('firstDay');
    expect(s!.campaign!.letters.map(l => l.id)).toContain('firstDay');
  });
});

describe('три карьеры', () => {
  let store = memoryStore();
  beforeEach(() => {
    store = memoryStore();
    setStore(store);
    forgetShift();
  });

  test('у каждой свой слот; «Продолжить» знает, какая карьера; письмо прочитано — отметка сохраняется', async () => {
    startCampaign({ career: 1, difficulty: 'student', seed: 11, season: 'winter' });
    await saved();
    await new Promise(r => setTimeout(r, 5));
    startCampaign({ career: 3, difficulty: 'doctor', seed: 12, season: 'winter' });
    await saved();
    await new Promise(r => setTimeout(r, 5)); // прежняя карьера записана при смене — эта позже
    readLetter('hello');
    expect(campaignView()!.letters.find(l => l.id === 'hello')!.read).toBe(true);
    await saved();
    const games = await savedGames();
    expect(games.filter(g => g.mode === 'campaign').map(g => [g.career, g.difficulty, g.chapter, g.mains])).toEqual([
      [3, 'doctor', ch.id, { done: 0, of: ch.missions.filter(m => m.main).length }],
      [1, 'student', ch.id, { done: 0, of: ch.missions.filter(m => m.main).length }],
    ]);
    await loadShift('campaign', 1);
    expect([shiftState()!.meta.career, shiftState()!.meta.seed]).toEqual([1, 11]);
    expect(campaignView()!.letters.find(l => l.id === 'hello')!.read).toBe(false);
    forgetShift();
    await loadShift('campaign', 3);
    expect([shiftState()!.meta.career, shiftState()!.meta.seed]).toEqual([3, 12]);
    expect(campaignView()!.letters.find(l => l.id === 'hello')!.read).toBe(true);
    // пустой слот — «нет сохранения»
    forgetShift();
    await loadShift('campaign', 2);
    expect(shiftState()).toBeUndefined();
  });

  test('вид главы: название, день, письма новые сверху, задания с ходом', () => {
    startCampaign({ career: 1, difficulty: 'student', seed: 13, season: 'winter' });
    const v = campaignView()!;
    expect(v.title).toBe(`Глава 1. ${ch.name.ru}`);
    expect(v.day).toBe(0);
    expect(v.letters.map(l => l.id)).toEqual(['grant', 'hello']);
    expect(v.missions.map(m => [m.id, m.main])).toEqual(ch.missions.map(m => [m.id, m.main]));
    expect(v.missions.find(m => m.id === 'seen')!.progress).toBe('0 из 40, точность 0 %');
    expect(v.complete).toBe(false);
  });
});
