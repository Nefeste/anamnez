// Обновление поверх прежней версии (09-testing.md): сохранения 0.0.17 — последней версии, что
// стояла на телефоне владельца до 0.0.28, — открываются и доигрываются. Фикстуру записал код
// 0.0.17 (tools/test/fixtures/saves/0.0.17.json): профиль с тремя приёмами и практика посреди
// первого дня — один пациент на анализе, другой в кабинете с начатым расспросом. Изменится
// формат сохранения или уйдёт из базы то, на что они ссылаются, — этот тест скажет, что прежние
// сохранения нужно переводить. С 0.0.43 — ещё песочница, записанная кодом 0.0.42
// (fixtures/saves/0.0.42-sandbox.json): день 1 закрыт с кассой, день 2 идёт, пациент в кабинете;
// стационара в ней нет, а построить палату можно. С 0.3.4 у болезней есть пороги на измерении
// (сатурация ниже 95 % у COVID-19): у пациентов этих сохранений их нет — загрузка досчитывает.
import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../../src/content';
import { txRole } from '../../src/engine/med/plan';
import { apply, freeBeds, wardBeds } from '../../src/engine/shift/engine';
import { achievementsBy, EARLIER, forgetProfile, loadProfile, profile, setProfileStore } from '../../src/state/profile';
import { memoryStore } from '../../src/state/saves';
import {
  archiveCaseView, callPatient, chooseDiagnosis, closeDay, examine, finishCase, forgetShift, loadShift, nextDay, savedGames, setStore, shiftCaseView, shiftState,
  shiftView, skipIdle, tick,
} from '../../src/state/session';

const OLD = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/saves/0.0.17.json'), 'utf8')) as Record<string, unknown>;

beforeEach(() => {
  const store = memoryStore();
  for (const [name, envelope] of Object.entries(OLD)) store.files.set(name, JSON.stringify(envelope));
  setStore(store);
  setProfileStore(store);
  forgetShift();
  forgetProfile();
});

describe('обновление с 0.0.17', () => {
  test('профиль: врач, итоги и архив с разбором; прежние приёмы сразу приносят достижения', async () => {
    await loadProfile();
    const p = profile();
    expect([p.doctor, p.stats.cases, p.archive.length]).toEqual([{ first: 'Анна', last: 'Петрова', sex: 'f' }, 3, 3]);
    expect(achievementsBy(EARLIER)).toContain('ach.first_patient');
    expect(archiveCaseView(p.archive[0].key)?.decision).toBeDefined();
  });

  test('практика посреди дня: в меню — «Продолжить»; пациент в кабинете, анализ ждёт; день доигрывается и закрывается', async () => {
    await loadProfile();
    expect((await savedGames()).map(g => [g.mode, g.day, g.difficulty])).toEqual([['shift', 1, 'student']]);
    await loadShift('shift');
    const s = shiftState()!;
    expect([s.meta.mode, s.day, Object.values(s.patients).some(p => p.status === 'away')]).toEqual(['shift', 1, true]);
    expect(shiftCaseView()?.decision).toBeUndefined();
    for (let guard = 0; guard < 300 && !shiftView().allDone; guard++) {
      const c = shiftCaseView();
      if (c && !c.decision) {
        examine('exam.ask_complaints');
        chooseDiagnosis(c.hints[0]?.id ?? 'cond.arvi');
        finishCase();
      }
      skipIdle();
      const q = shiftView().queue;
      if (q.length > 0 && !shiftState()!.current) {
        callPatient(q[0].id);
        for (let i = 0; i < 40; i++) tick(1000);
      }
    }
    expect(shiftView().allDone).toBe(true);
    closeDay();
    const sum = shiftView().summary!;
    expect(sum.seen).toBeGreaterThan(3);
    nextDay();
    expect(shiftView().clock).toBe('08:00');
    // три приёма, закрытых в 0.0.17, в профиле уже были — второй раз не засчитаны
    expect(profile().stats.cases).toBe(sum.seen);
  });
});

describe('обновление с 0.0.42', () => {
  const openSandbox = async () => {
    const store = memoryStore();
    const saved = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/saves/0.0.42-sandbox.json'), 'utf8')) as Record<string, unknown>;
    for (const [name, envelope] of Object.entries(saved)) store.files.set(name, JSON.stringify(envelope));
    setStore(store);
    setProfileStore(store);
    forgetShift();
    forgetProfile();
    await loadProfile();
    await loadShift('sandbox');
  };

  test('песочница посреди дня 2: приём доигрывается, день закрывается; стационара нет, палату можно построить', async () => {
    await openSandbox();
    const s = shiftState()!;
    expect([s.meta.mode, s.day, s.current, s.history.length]).toEqual(['sandbox', 2, '2-01', 1]);
    // вчерашняя касса — без стационара: ни случаев, ни койко-дней
    expect(s.history[0].economy!.ledger.ward).toBeUndefined();
    expect(s.history[0].economy!.ledger.expenses.ward).toBeUndefined();
    expect(shiftView().inpatients).toBe(0);
    expect(wardBeds(db, s)).toEqual([]);
    const c = shiftCaseView()!;
    expect(c.settings.map(o => o.key)).toEqual(['home', 'ward', 'ambulance']);
    chooseDiagnosis(c.hints[0]?.id ?? 'cond.arvi');
    finishCase();
    closeDay();
    const sum = shiftView().summary!;
    expect(sum.cash).toBeDefined();
    expect(sum.wardLines).toBeUndefined();
    expect(sum.cash!.expenses.map(x => x.key)).not.toContain('ward');
    nextDay();
    expect(shiftView().clock).toBe('08:00');
    // в той же песочнице — палата у нового коридора, медсестра ЭКГ — в неё
    const cells: [number, number][] = [];
    for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
    const st = shiftState()!;
    apply(db, st, { kind: 'closeDay' });
    apply(db, st, { kind: 'build', cmd: { kind: 'corridor', cells } });
    apply(db, st, { kind: 'build', cmd: { kind: 'room', type: 'room.ward', size: 'S', x: 29, y: 0, rot: 0 } });
    apply(db, st, { kind: 'buildEnd' });
    const ward = st.hospital!.rooms[st.hospital!.rooms.length - 1];
    expect(ward.type).toBe('room.ward');
    apply(db, st, { kind: 'assign', id: st.staff!.find(m => m.role === 'role.nurse' && m.room === 'r7')!.id, room: ward.id });
    expect(freeBeds(db, st)).toHaveLength(2);
  });

  test('пороги на измерении (часть 38б): у сохранённых пациентов их нет — досчитаны по их числам, прочие параметры те же', async () => {
    await openSandbox();
    const params = (id: string) => shiftState()!.patients[id].patient.truth.conditions[0].params;
    // COVID-19 с сатурацией 98 и 99 % — кислород не нужен
    expect([params('1-17'), params('2-05')]).toEqual([{ severity: 'mild', spo2_below95: 'no' }, { severity: 'mild', spo2_below95: 'no' }]);
    expect(txRole(db, 'cond.covid19', 'tx.oxygen_mask', params('2-05'))).toBe('notIndicated');
    expect(params('2-03')).toEqual({});
  });
});
