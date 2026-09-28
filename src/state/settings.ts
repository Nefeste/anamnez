// Настройки игрока (03-game-design.md §12, spec 2026-09-first-shift): громкость звуков,
// вибрация, автопауза смены, размер текста, тема (spec 2026-09-own-look) и отметка, что
// оговорка первого запуска прочитана
// (11-publishing.md §3). Лежат в слоте `settings` тем же сырым хранилищем, что и смена
// (ADR 0010): запись атомарная, с копиями. Модуль, как session.ts, не знает про платформу —
// хранилище приходит снаружи (setSettingsStore).
import { useSyncExternalStore } from 'react';
import { loadSlot, type RawStore, saveSlot } from './saves';

export const SETTINGS_SLOT = 'settings';
export const SETTINGS_SCHEMA_VERSION = 1;

/** Громкость звуков — четыре ступени: одним касанием, без ползунка. */
export const VOLUMES = [0, 0.35, 0.7, 1] as const;
/** Размер текста — три ступени (03-game-design.md §12); системный размер Android — поверх. */
export const TEXT_SCALES = [1, 1.15, 1.3] as const;
/** Тема: как в телефоне, светлая «Медкарта» или тёмный «Монитор» (spec 2026-09-own-look). */
export const THEME_CHOICES = ['system', 'light', 'dark'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

export interface Settings {
  /** громкость звуков игры, 0–1 */
  sound: number;
  vibration: boolean;
  /** автопауза смены: пришёл срочный пациент */
  pauseOnRed: boolean;
  /** автопауза смены: пациент вернулся с результатами */
  pauseOnResults: boolean;
  /** оговорка первого запуска прочитана и закрыта */
  disclaimerAccepted: boolean;
  /** множитель размера текста — одна из TEXT_SCALES */
  textScale: number;
  /** тема интерфейса; по умолчанию — как в телефоне */
  theme: ThemeChoice;
}

export const DEFAULTS: Settings = { sound: 1, vibration: true, pauseOnRed: true, pauseOnResults: true, disclaimerAccepted: false, textScale: 1, theme: 'system' };

export interface SettingsView extends Settings {
  /** ready — прочитаны с диска (или их там нет и действуют умолчания) */
  status: 'idle' | 'loading' | 'ready';
}

let store: RawStore | null = null;
let current: Settings = { ...DEFAULTS };
let status: SettingsView['status'] = 'idle';
let loading: Promise<void> | null = null;
let saving: Promise<unknown> = Promise.resolve();
let view: SettingsView = { ...current, status };
const listeners = new Set<() => void>();

function changed() {
  view = { ...current, status };
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function setSettingsStore(s: RawStore) {
  store = s;
}

/**
 * Прочитанное с диска — поле за полем: испорченное или незнакомое поле берётся по
 * умолчанию и не ломает остальные (файл могла записать и другая версия игры).
 */
export function sanitize(data: unknown): Settings {
  const d = (data !== null && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const flag = (k: 'vibration' | 'pauseOnRed' | 'pauseOnResults' | 'disclaimerAccepted') => (typeof d[k] === 'boolean' ? (d[k] as boolean) : DEFAULTS[k]);
  const sound = typeof d.sound === 'number' && d.sound >= 0 && d.sound <= 1 ? d.sound : DEFAULTS.sound;
  const textScale = (TEXT_SCALES as readonly number[]).includes(d.textScale as number) ? (d.textScale as number) : DEFAULTS.textScale;
  const theme = (THEME_CHOICES as readonly unknown[]).includes(d.theme) ? (d.theme as ThemeChoice) : DEFAULTS.theme;
  return { sound, vibration: flag('vibration'), pauseOnRed: flag('pauseOnRed'), pauseOnResults: flag('pauseOnResults'), disclaimerAccepted: flag('disclaimerAccepted'), textScale, theme };
}

/** Прочитать настройки, если ещё не читали; файла нет или он испорчен — умолчания. */
export function loadSettings(): Promise<void> {
  if (status === 'ready') return Promise.resolve();
  if (loading) return loading;
  const st = store;
  if (!st) {
    status = 'ready';
    changed();
    return Promise.resolve();
  }
  status = 'loading';
  changed();
  loading = loadSlot<Settings>(st, SETTINGS_SLOT)
    .then(r => {
      if (r) current = sanitize(r.envelope.data);
    })
    .catch(() => undefined)
    .finally(() => {
      status = 'ready';
      loading = null;
      changed();
    });
  return loading;
}

/** Поменять и сразу записать: настройки меняются редко, по касанию. Записи идут по очереди. */
export function updateSettings(patch: Partial<Settings>): Promise<unknown> {
  current = { ...current, ...patch };
  changed();
  const st = store;
  const data = current;
  if (st) {
    saving = saving
      .then(() => saveSlot(st, SETTINGS_SLOT, data, SETTINGS_SCHEMA_VERSION, new Date().toISOString()))
      .catch(() => undefined); // не записалось — настройка действует до перезапуска
  }
  return saving;
}

/** Настройки сейчас — для звука и часов смены; экранам — useSettings. */
export function settings(): Settings {
  return current;
}

export function useSettings(): SettingsView {
  return useSyncExternalStore(subscribe, () => view, () => view);
}

/** Для тестов: забыть настройки в памяти, как после перезапуска приложения. */
export function forgetSettings() {
  current = { ...DEFAULTS };
  status = 'idle';
  loading = null;
  changed();
}

/** Дождаться записи — для тестов. */
export function settingsSaved(): Promise<unknown> {
  return saving;
}
