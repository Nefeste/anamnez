// Журнал сбоев — для «Сообщить об ошибке» (06-architecture.md §8): последние пять ошибок с
// временем и началом стека. Живёт только на телефоне (слот `errors`) и уходит, только если
// игрок сам отправит отчёт. На телефоне ошибки ловит глобальный обработчик React Native, в
// вебе его нет — там журнал пишут только явные вызовы.
import { loadSlot, type RawStore, saveSlot } from './saves';

export const ERRORS_SLOT = 'errors';
const MAX = 5;

export interface ErrorRecord {
  /** когда — ISO, время телефона */
  at: string;
  message: string;
  fatal: boolean;
}

let store: RawStore | null = null;
let recent: ErrorRecord[] = [];

/** Записать ошибку; сохраняем без ожидания — упавшее приложение может не успеть. */
export function recordError(error: unknown, fatal: boolean, now: Date = new Date()) {
  const e = error instanceof Error ? error : new Error(String(error));
  const stack = (e.stack ?? '').split('\n').slice(1, 4).map(l => l.trim()).join(' | ');
  const message = `${e.name}: ${e.message}`.slice(0, 300) + (stack ? ` — ${stack.slice(0, 300)}` : '');
  recent = [{ at: now.toISOString(), message, fatal }, ...recent].slice(0, MAX);
  const st = store;
  if (st) void saveSlot(st, ERRORS_SLOT, recent, 1, now.toISOString()).catch(() => undefined);
}

export function recentErrors(): readonly ErrorRecord[] {
  return recent;
}

type Handler = (error: unknown, isFatal?: boolean) => void;
type Utils = { setGlobalHandler: (h: Handler) => void; getGlobalHandler: () => Handler };

/** Подключить журнал: прочитать прошлые сбои и ловить новые (до своего обработчика — прежний). */
export async function installErrorLog(s: RawStore): Promise<void> {
  store = s;
  const utils = (globalThis as { ErrorUtils?: Utils }).ErrorUtils;
  if (utils) {
    const prev = utils.getGlobalHandler();
    utils.setGlobalHandler((error, isFatal) => {
      recordError(error, !!isFatal);
      prev(error, isFatal);
    });
  }
  const r = await loadSlot<ErrorRecord[]>(s, ERRORS_SLOT).catch(() => null);
  const old = Array.isArray(r?.envelope.data) ? r.envelope.data.filter(x => typeof x?.message === 'string' && typeof x?.at === 'string') : [];
  recent = [...recent, ...old].slice(0, MAX);
}

/** Для тестов. */
export function forgetErrors() {
  recent = [];
  store = null;
}
