// Песочница — своя больница (spec 2026-09-own-hospital, часть 7): начало с пустого участка или
// с готовой амбулаторией, стройка между сменами командами движка — с отменой и журналом,
// отдельное от практики сохранение, «Продолжить» — последняя записанная партия.
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import type { Cell } from '../../src/content/types';
import { apply, newSandbox } from '../../src/engine/shift/engine';
import type { ShiftState } from '../../src/engine/shift/types';
import { memoryStore, saveSlot } from '../../src/state/saves';
import {
  buildAction, buildView, compatible, endBuild, forgetShift, loadShift, nextDay, SANDBOX_SLOT, saved, savedGames, setStore, shiftState, shiftView, startSandbox,
  startShift, tick, undoBuild,
} from '../../src/state/session';
import { SHIFT_SCHEMA_VERSION } from '../../src/engine/shift/types';

let store = memoryStore();
beforeEach(() => {
  store = memoryStore();
  setStore(store);
  forgetShift();
});

const row = (x0: number, x1: number, y: number): Cell[] => Array.from({ length: x1 - x0 + 1 }, (_, i) => [x0 + i, y] as Cell);
const budgets = db.economy.sandbox.budgets;

/** Самая малая больница, в которой можно открыть смену: регистратура, зона ожидания, кабинет у коридора. */
function minimal() {
  expect(buildAction({ kind: 'corridor', cells: row(4, 30, 13) })).toBeNull();
  expect(buildAction({ kind: 'room', type: 'room.reception', size: 'S', x: 2, y: 6, rot: 0 })).toBeNull();
  expect(buildAction({ kind: 'room', type: 'room.waiting', size: 'M', x: 2, y: 14, rot: 2 })).toBeNull();
  expect(buildAction({ kind: 'room', type: 'room.office', size: 'M', x: 12, y: 6, rot: 0 })).toBeNull();
}

describe('песочница', () => {
  test('пустой участок: день 0, касса — бюджет; чтобы открыть смену, не хватает регистратуры, зоны ожидания и кабинета', () => {
    startSandbox({ start: 'empty', budget: 'normal', difficulty: 'student', seed: 11, season: 'winter' });
    const v = shiftView();
    expect([v.mode, v.day, v.dayOpen, v.cash]).toEqual(['sandbox', 0, false, budgets.normal]);
    const b = buildView()!;
    expect(b.plan.rooms).toEqual([]);
    expect(b.open.map(x => x.kind === 'noRoom' && x.room)).toEqual(['room.reception', 'room.waiting', 'room.office']);
  });

  test('стройка: каждое действие стоит денег и отменяется; нельзя — причина, и ничего не меняется', () => {
    startSandbox({ start: 'empty', budget: 'normal', difficulty: 'doctor', seed: 12, season: 'winter' });
    minimal();
    const b = buildView()!;
    expect(b.open).toEqual([]);
    expect(b.undo).toBe(4);
    const cost = 27 * db.economy.corridor.cost + db.rooms['room.reception'].sizes[0].cost + db.rooms['room.waiting'].sizes[1].cost + db.rooms['room.office'].sizes[0].cost;
    expect(b.cash).toBe(budgets.normal - cost);

    // на чужом полу — нельзя, касса та же
    expect(buildAction({ kind: 'room', type: 'room.triage', size: 'S', x: 4, y: 6, rot: 0 })).toMatchObject({ kind: 'blocked', room: 'r1' });
    expect(buildView()!.cash).toBe(budgets.normal - cost);

    undoBuild();
    expect(buildView()!.plan.rooms.map(r => r.type)).toEqual(['room.reception', 'room.waiting']);
    expect(buildView()!.cash).toBe(budgets.normal - cost + db.rooms['room.office'].sizes[0].cost);
    endBuild();
    expect(buildView()!.undo).toBe(0);
    undoBuild(); // отменять нечего
    expect(buildView()!.plan.rooms).toHaveLength(2);
  });

  test('готовая амбулатория: те же девять помещений, в кассе — доля бюджета', () => {
    startSandbox({ start: 'clinic', budget: 'generous', difficulty: 'doctor', seed: 13, season: 'winter' });
    const b = buildView()!;
    expect(b.plan.rooms).toHaveLength(9);
    expect([b.plan.grid.w, b.plan.grid.h]).toEqual(db.economy.sandbox.plot);
    expect(b.cash).toBe(Math.floor((budgets.generous * db.economy.sandbox.clinicShare) / 100));
    expect(Object.values(b.problems).flat()).toEqual([]);
  });

  test('журнал дня: те же команды на новой песочнице дают ту же больницу и кассу', () => {
    startSandbox({ start: 'empty', budget: 'modest', difficulty: 'doctor', seed: 14, season: 'spring' });
    minimal();
    undoBuild();
    buildAction({ kind: 'room', type: 'room.office', size: 'M', x: 20, y: 6, rot: 0 });
    endBuild();
    const live = shiftState()!;
    const again = newSandbox(db, { seed: 14, season: 'spring', difficulty: 'doctor', start: 'empty', budget: budgets.modest });
    for (const cmd of live.journal) apply(db, again, cmd);
    expect(again.hospital).toEqual(live.hospital);
    expect(again.economy).toEqual(live.economy);
  });

  test('смена в своей больнице — в следующей части: «Следующий день» пока ничего не делает, часы стоят', () => {
    startSandbox({ start: 'clinic', budget: 'normal', difficulty: 'doctor', seed: 15, season: 'winter' });
    nextDay();
    tick(1000);
    expect([shiftView().day, shiftView().dayOpen]).toEqual([0, false]);
  });
});

describe('практика и песочница — разные сохранения', () => {
  test('у каждой свой слот; «Продолжить» — последняя записанная; переключение возвращает партию как была', async () => {
    startShift(21, 'winter', 'student');
    for (let i = 0; i < 40; i++) tick(1000);
    const practice = { day: shiftView().day, clock: shiftView().clock };
    await saved();
    await new Promise(r => setTimeout(r, 5)); // записи отличаются временем
    startSandbox({ start: 'empty', budget: 'normal', difficulty: 'doctor', seed: 22, season: 'winter' });
    await new Promise(r => setTimeout(r, 5));
    minimal();
    await saved();

    const games = await savedGames();
    expect(games.map(g => g.mode)).toEqual(['sandbox', 'shift']);
    expect(games[0].cash).toBe(buildView()!.cash);
    expect({ day: games[1].day, clock: games[1].clock }).toEqual(practice);

    await loadShift('shift');
    expect([shiftView().mode, shiftView().clock]).toEqual(['shift', practice.clock]);
    expect(buildView()).toBeUndefined();
    await loadShift('sandbox');
    expect(shiftView().mode).toBe('sandbox');
    expect(buildView()!.plan.rooms).toHaveLength(3);

    // после «перезапуска» — то же самое с диска
    forgetShift();
    await loadShift('sandbox');
    expect(buildView()!.plan.rooms).toHaveLength(3);
  });

  test('песочницы нет — статус none в режиме песочницы, практика не тронута', async () => {
    startShift(23, 'winter');
    await saved();
    await loadShift('sandbox');
    expect([shiftView().status, shiftView().mode]).toEqual(['none', 'sandbox']);
    await loadShift('shift');
    expect([shiftView().status, shiftView().mode]).toEqual(['ready', 'shift']);
  });

  test('сохранение песочницы с помещением, которого нет в базе, не читается', async () => {
    const s: ShiftState = newSandbox(db, { seed: 1, season: 'winter', start: 'clinic', budget: 1 });
    expect(compatible(s)).toBe(true);
    const broken = JSON.parse(JSON.stringify(s)) as ShiftState;
    broken.hospital!.rooms[0].type = 'room.nothing';
    expect(compatible(broken)).toBe(false);
    await saveSlot(store, SANDBOX_SLOT, broken, SHIFT_SCHEMA_VERSION, 'x');
    await loadShift('sandbox');
    expect(shiftView().status).toBe('none');
  });
});
