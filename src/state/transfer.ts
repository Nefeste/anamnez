// Перенос прогресса на другой телефон файлом (FR-SYS-7, 07-data-model.md §4). Android сам
// кладёт файлы игры в резервную копию аккаунта Google; без неё — файл: профиль, настройки и
// все партии одним JSON. Открыли файл — то, что в нём есть, заменяет здешнее, а прежнее
// уходит в копию (saveSlot сдвигает копии, откат — как после испорченного файла); чего в
// файле нет — остаётся как было. Сеть не нужна: файл пишет и читает системное окно выбора
// (storage.ts), в веб-сборке — скачивание и выбор файла.
import type { ShiftState } from '@/engine/shift/types';
import { SHIFT_SCHEMA_VERSION } from '@/engine/shift/types';
import { T } from '@/i18n';
import { forgetProfile, loadProfile, PROFILE_SCHEMA_VERSION, PROFILE_SLOT, profileSaved, sanitizeProfile } from './profile';
import { dateText, doctorName } from './profileView';
import { type Envelope, loadSlot, type RawStore, saveSlot } from './saves';
import { CAREERS, compatible, forgetShift, SANDBOX_SLOT, saved, SINGLE_SLOT, SLOT } from './session';
import { forgetSettings, loadSettings, SETTINGS_SCHEMA_VERSION, SETTINGS_SLOT, settingsSaved } from './settings';

export const TRANSFER_FORMAT = 1;
const APP = 'anamnez';

const CAMPAIGN_SLOTS = CAREERS.map(c => `campaign-${c}`);
const GAME_SLOTS = [SLOT, SANDBOX_SLOT, SINGLE_SLOT, ...CAMPAIGN_SLOTS];

/** Что переносится — слот и версия формата его сохранения в этой версии игры. */
export const TRANSFER_SLOTS: Readonly<Record<string, number>> = {
  [PROFILE_SLOT]: PROFILE_SCHEMA_VERSION,
  [SETTINGS_SLOT]: SETTINGS_SCHEMA_VERSION,
  ...Object.fromEntries(GAME_SLOTS.map(s => [s, SHIFT_SCHEMA_VERSION])),
};

export interface TransferFile {
  app: typeof APP;
  format: number;
  /** версия игры, записавшей файл */
  version: string;
  savedAt: string;
  slots: Record<string, Envelope<unknown>>;
}

export type TransferProblem = 'broken' | 'notOurs' | 'newer' | 'empty';
export type Parsed = { ok: true; file: TransferFile } | { ok: false; problem: TransferProblem };

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const two = (n: number) => String(n).padStart(2, '0');

/** Имя файла — с датой по часам телефона: anamnez-2026-09-28.json. */
export const transferName = (d: Date) => `anamnez-${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}.json`;

/** Все сохранения — одним файлом; испорченный текущий — его предыдущая копия, как при загрузке. */
export async function packSaves(store: RawStore, version: string, savedAt: string): Promise<string> {
  const slots: Record<string, Envelope<unknown>> = {};
  for (const slot of Object.keys(TRANSFER_SLOTS)) {
    const r = await loadSlot<unknown>(store, slot).catch(() => null);
    if (r) slots[slot] = r.envelope;
  }
  return JSON.stringify({ app: APP, format: TRANSFER_FORMAT, version, savedAt, slots } satisfies TransferFile);
}

/**
 * Прочитать файл переноса. Чужой, испорченный, пустой — отказ с причиной. Из более новой
 * версии игры — формат файла или сохранения новее здешнего, или партия ссылается на то, чего
 * в этой базе нет, — тоже отказ: сначала обновить игру. Незнакомые слоты пропускаются.
 */
export function parseTransfer(text: string): Parsed {
  let d: unknown;
  try {
    d = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'broken' };
  }
  if (!isObject(d) || d.app !== APP || !isObject(d.slots)) return { ok: false, problem: 'notOurs' };
  if (typeof d.format !== 'number' || d.format > TRANSFER_FORMAT) return { ok: false, problem: 'newer' };
  const slots: Record<string, Envelope<unknown>> = {};
  for (const [slot, e] of Object.entries(d.slots)) {
    const max = TRANSFER_SLOTS[slot];
    if (max === undefined) continue;
    if (!isObject(e) || typeof e.schemaVersion !== 'number' || !('data' in e)) return { ok: false, problem: 'broken' };
    if (e.schemaVersion > max) return { ok: false, problem: 'newer' };
    if (GAME_SLOTS.includes(slot) && !compatible(e.data as ShiftState)) return { ok: false, problem: 'newer' };
    slots[slot] = { schemaVersion: e.schemaVersion, savedAt: typeof e.savedAt === 'string' ? e.savedAt : '', data: e.data };
  }
  if (Object.keys(slots).length === 0) return { ok: false, problem: 'empty' };
  return { ok: true, file: { app: APP, format: d.format, version: typeof d.version === 'string' ? d.version : '', savedAt: typeof d.savedAt === 'string' ? d.savedAt : '', slots } };
}

/** Что в файле — строками для подтверждения: врач и приёмы, партии с днём, настройки. */
export function transferLines(file: TransferFile): string[] {
  const t = T.transfer;
  const lines: string[] = [];
  const profile = file.slots[PROFILE_SLOT];
  if (profile) {
    const p = sanitizeProfile(profile.data);
    lines.push(t.profile(p.doctor ? doctorName(p.doctor) : t.noDoctor, p.stats.cases));
  }
  for (const slot of GAME_SLOTS) {
    const e = file.slots[slot];
    if (!e) continue;
    const s = e.data as ShiftState;
    const name = slot === SLOT ? t.games.shift : slot === SANDBOX_SLOT ? t.games.sandbox : slot === SINGLE_SLOT ? t.games.single : T.campaign.career(CAMPAIGN_SLOTS.indexOf(slot) + 1);
    lines.push(t.game(name, s.day));
  }
  if (file.slots[SETTINGS_SLOT]) lines.push(t.settings);
  const when = dateText(file.savedAt);
  if (when) lines.push(t.written(when, file.version));
  return lines;
}

/** Записать всё свежее — и собрать файл. */
export async function saveTransfer(store: RawStore, version: string, now: Date = new Date()): Promise<string> {
  await Promise.all([saved(), profileSaved(), settingsSaved()]);
  return packSaves(store, version, now.toISOString());
}

/**
 * Открыть файл: дождаться записей, забыть живое (иначе отложенная запись вернула бы старое
 * поверх), записать слоты из файла и прочитать заново. Возвращает, какие слоты пришли.
 */
export async function openTransfer(store: RawStore, file: TransferFile): Promise<string[]> {
  await Promise.all([saved(), profileSaved(), settingsSaved()]);
  forgetShift();
  forgetProfile();
  forgetSettings();
  const written: string[] = [];
  for (const [slot, e] of Object.entries(file.slots)) {
    await saveSlot(store, slot, e.data, e.schemaVersion, e.savedAt || new Date().toISOString());
    written.push(slot);
  }
  await Promise.all([loadProfile(), loadSettings()]);
  return written;
}
