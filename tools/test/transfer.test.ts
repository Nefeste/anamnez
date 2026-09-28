// Перенос на другой телефон файлом (FR-SYS-7, 07-data-model.md §4): все сохранения — одним
// файлом; открыли его — то, что в файле, заменило здешнее, остальное как было, живая партия не
// перезаписала пришедшее; чужой, испорченный, пустой, из более новой версии — отказ с причиной.
import { beforeEach, describe, expect, test } from 'bun:test';
import { forgetProfile, loadProfile, profile, setDoctor, setProfileStore } from '../../src/state/profile';
import { memoryStore, type RawStore } from '../../src/state/saves';
import { forgetShift, loadShift, savedGames, setStore, shiftState, startCampaign, startSandbox, startShift } from '../../src/state/session';
import { forgetSettings, loadSettings, setSettingsStore, settings, updateSettings } from '../../src/state/settings';
import { openTransfer, parseTransfer, saveTransfer, TRANSFER_FORMAT, transferLines, transferName } from '../../src/state/transfer';

let store = memoryStore();
function use(s: RawStore & { files: Map<string, string> }) {
  store = s;
  setStore(s);
  setProfileStore(s);
  setSettingsStore(s);
  forgetShift();
  forgetProfile();
  forgetSettings();
}
beforeEach(() => use(memoryStore()));

/** Телефон 1: врач, крупный текст, практика и песочница — и файл с него. */
async function phoneOne(): Promise<string> {
  await Promise.all([loadProfile(), loadSettings()]);
  await setDoctor({ first: 'Анна', last: 'Петрова', sex: 'f' });
  await updateSettings({ textScale: 1.3 });
  startShift(5, 'winter', 'student');
  startSandbox({ start: 'clinic', budget: 'normal', difficulty: 'student', seed: 4, season: 'winter' });
  return saveTransfer(store, '0.0.29', new Date(2026, 8, 28, 10));
}

describe('перенос: файл', () => {
  test('в файле — профиль, настройки и партии; что в нём — строками; имя — с датой', async () => {
    const r = parseTransfer(await phoneOne());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.file.slots).sort()).toEqual(['profile', 'sandbox', 'settings', 'shift']);
    expect(transferLines(r.file)).toEqual([
      'Врач: Анна Петрова · приёмов: 0',
      'Практика — день 1',
      'Песочница — до первой смены',
      'Настройки',
      'Файл записан 28.09.2026, версия 0.0.29',
    ]);
    expect(transferName(new Date(2026, 8, 5))).toBe('anamnez-2026-09-05.json');
  });

  test('чужой, испорченный, пустой, из более новой версии — отказ с причиной; незнакомый слот пропущен', async () => {
    const good = JSON.parse(await phoneOne());
    const problem = (x: unknown) => {
      const r = parseTransfer(typeof x === 'string' ? x : JSON.stringify(x));
      return r.ok ? 'ok' : r.problem;
    };
    expect(problem('{ не json')).toBe('broken');
    expect(problem({ ...good, app: 'votchina' })).toBe('notOurs');
    expect(problem({ ...good, format: TRANSFER_FORMAT + 1 })).toBe('newer');
    expect(problem({ ...good, slots: { profile: { ...good.slots.profile, schemaVersion: 99 } } })).toBe('newer');
    // партия ссылается на болезнь, которой в этой базе нет, — файл из более новой версии
    const shift = structuredClone(good.slots.shift);
    Object.values(shift.data.patients as Record<string, { patient: { truth: { conditions: { id: string }[] } } }>)[0].patient.truth.conditions[0].id = 'cond.from_the_future';
    expect(problem({ ...good, slots: { shift } })).toBe('newer');
    expect(problem({ ...good, slots: { profile: 'мусор' } })).toBe('broken');
    expect(problem({ ...good, slots: {} })).toBe('empty');
    expect(problem({ ...good, slots: { ...good.slots, 'из-будущего': { schemaVersion: 1, savedAt: '', data: {} } } })).toBe('ok');
  });
});

describe('перенос: открыть файл на другом телефоне', () => {
  test('пришло то, что в файле; своё, чего в файле нет, — как было; живая партия не перезаписала пришедшее', async () => {
    const text = await phoneOne();
    // телефон 2: свой врач и своя карьера (её в файле нет), практика живая в памяти
    use(memoryStore());
    await Promise.all([loadProfile(), loadSettings()]);
    await setDoctor({ first: 'Иван', last: 'Соколов', sex: 'm' });
    startCampaign({ career: 1, difficulty: 'student', seed: 3, season: 'winter' });
    startShift(77, 'summer', 'doctor');
    const r = parseTransfer(text);
    if (!r.ok) throw new Error(r.problem);
    expect(await openTransfer(store, r.file)).toEqual(['profile', 'settings', 'shift', 'sandbox']);
    expect(profile().doctor).toEqual({ first: 'Анна', last: 'Петрова', sex: 'f' });
    expect(settings().textScale).toBe(1.3);
    expect(shiftState()).toBeUndefined();
    await loadShift('shift');
    expect([shiftState()?.meta.seed, shiftState()?.meta.season]).toEqual([5, 'winter']);
    expect((await savedGames()).map(g => g.mode).sort()).toEqual(['campaign', 'sandbox', 'shift']);
  });
});
