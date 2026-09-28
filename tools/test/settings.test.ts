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
  test('файла нет — умолчания: звук полный, фон и вибрация включены, автопауза тоже, оговорка не прочитана, текст обычный, тема как в телефоне', async () => {
    await loadSettings();
    expect(settings()).toEqual({ sound: 1, ambience: true, vibration: true, pauseOnRed: true, pauseOnResults: true, disclaimerAccepted: false, textScale: 1, theme: 'system' });
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
    // размер текста — только одна из ступеней
    expect(sanitize({ textScale: 1.3 }).textScale).toBe(1.3);
    expect(sanitize({ textScale: 5 }).textScale).toBe(1);
    // тема — одна из трёх; в файле прежней версии её нет — как в телефоне
    expect(sanitize({ theme: 'dark' }).theme).toBe('dark');
    expect(sanitize({ theme: 'blue' }).theme).toBe('system');
    expect(sanitize({ sound: 0.7, textScale: 1.15 }).theme).toBe('system');
    // фон амбулатории — в файле прежней версии его нет: включён
    expect(sanitize({ sound: 0.35 }).ambience).toBe(true);
    expect(sanitize({ ambience: false }).ambience).toBe(false);
    expect(sanitize(null)).toEqual(DEFAULTS);
    expect(sanitize([1, 2])).toEqual(DEFAULTS);
  });
});
