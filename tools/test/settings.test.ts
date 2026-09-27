// Настройки игрока (src/state/settings.ts): умолчания, запись и чтение после «перезапуска»,
// испорченный файл — предыдущая копия, испорченные и чужие поля — по умолчанию.
import { beforeEach, describe, expect, test } from 'bun:test';
import { memoryStore } from '../../src/state/saves';
import { DEFAULTS, forgetSettings, loadSettings, sanitize, setSettingsStore, settings, settingsSaved, updateSettings } from '../../src/state/settings';

let store = memoryStore();

beforeEach(() => {
  store = memoryStore();
  setSettingsStore(store);
  forgetSettings();
});

describe('настройки', () => {
  test('файла нет — умолчания: звук полный, вибрация и автопауза включены, оговорка не прочитана', async () => {
    await loadSettings();
    expect(settings()).toEqual({ sound: 1, vibration: true, pauseOnRed: true, pauseOnResults: true, disclaimerAccepted: false });
  });

  test('поменяли — записано; после «перезапуска» — те же', async () => {
    await loadSettings();
    updateSettings({ sound: 0.35, vibration: false });
    updateSettings({ disclaimerAccepted: true });
    await settingsSaved();
    forgetSettings();
    expect(settings()).toEqual(DEFAULTS);
    await loadSettings();
    expect(settings()).toEqual({ ...DEFAULTS, sound: 0.35, vibration: false, disclaimerAccepted: true });
  });

  test('текущий файл испорчен — читается предыдущая копия', async () => {
    await loadSettings();
    updateSettings({ disclaimerAccepted: true });
    updateSettings({ vibration: false });
    await settingsSaved();
    store.files.set('settings.json', '{ broken');
    forgetSettings();
    await loadSettings();
    expect(settings()).toEqual({ ...DEFAULTS, disclaimerAccepted: true });
  });

  test('испорченные и чужие поля — по умолчанию, остальные на месте', () => {
    expect(sanitize({ sound: 7, vibration: 'yes', pauseOnRed: false, extra: 1 })).toEqual({ ...DEFAULTS, pauseOnRed: false });
    expect(sanitize(null)).toEqual(DEFAULTS);
    expect(sanitize([1, 2])).toEqual(DEFAULTS);
  });
});
