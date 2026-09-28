// Обновление поверх прежней версии (09-testing.md): сохранения 0.0.17 — последней версии, что
// стояла на телефоне владельца до 0.0.28, — открываются и доигрываются. Фикстуру записал код
// 0.0.17 (tools/test/fixtures/saves/0.0.17.json): профиль с тремя приёмами и практика посреди
// первого дня — один пациент на анализе, другой в кабинете с начатым расспросом. Изменится
// формат сохранения или уйдёт из базы то, на что они ссылаются, — этот тест скажет, что прежние
// сохранения нужно переводить.
import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
