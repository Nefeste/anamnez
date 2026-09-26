// Слоты сохранений: атомарная запись и две предыдущие копии (ADR 0010, 06-architecture.md §8).
//
// Логика не знает про платформу: ниже — «сырое» хранилище с пятью операциями. На телефоне
// это файлы (storage.ts), в вебе — localStorage (storage.web.ts), в тестах — память.
export interface RawStore {
  read(name: string): Promise<string | null>;
  write(name: string, text: string): Promise<void>;
  /** переименование поверх: заменяет `to`, если он есть */
  move(from: string, to: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  exists(name: string): Promise<boolean>;
}

export interface Envelope<T> {
  schemaVersion: number;
  savedAt: string;
  data: T;
}

/** Откуда прочитано: tmp — запись прервалась между сдвигом копий и заменой, данные целы. */
export type LoadedFrom = 'current' | 'tmp' | 'prev-1' | 'prev-2';

/** Сколько стоила запись: сериализация и файлы отдельно — чтобы на телефоне было видно, что дорого. */
export interface SaveCost {
  bytes: number;
  jsonMs: number;
  writeMs: number;
}

const names = (slot: string) => ({
  current: `${slot}.json`,
  tmp: `${slot}.json.tmp`,
  prev1: `${slot}.prev-1.json`,
  prev2: `${slot}.prev-2.json`,
});

/**
 * Записать: во временный файл, сдвинуть копии, переименовать временный в текущий. Копии
 * сдвигаются переименованием, а не копированием: на телефоне копирование двух прошлых
 * копий стоило дороже самой записи (0.0.7: 180 КБ за 194 мс при пороге 100).
 */
export async function saveSlot<T>(store: RawStore, slot: string, data: T, schemaVersion: number, savedAt: string): Promise<SaveCost> {
  const n = names(slot);
  const t0 = Date.now();
  const text = JSON.stringify({ schemaVersion, savedAt, data } satisfies Envelope<T>);
  const t1 = Date.now();
  await store.write(n.tmp, text);
  if (await store.exists(n.prev1)) await store.move(n.prev1, n.prev2);
  if (await store.exists(n.current)) await store.move(n.current, n.prev1);
  await store.move(n.tmp, n.current);
  return { bytes: text.length, jsonMs: t1 - t0, writeMs: Date.now() - t1 };
}

/**
 * Прочитать: текущий; если его нет — временный (запись прервалась между сдвигом копий и
 * заменой, а временный уже записан целиком); если испорчен — предыдущие копии по очереди.
 * Временный, недописанный на полуслове, не разбирается и пропускается.
 */
export async function loadSlot<T>(store: RawStore, slot: string, valid: (e: Envelope<T>) => boolean = () => true): Promise<{ envelope: Envelope<T>; from: LoadedFrom } | null> {
  const n = names(slot);
  const order: [string, LoadedFrom][] = [[n.current, 'current'], [n.tmp, 'tmp'], [n.prev1, 'prev-1'], [n.prev2, 'prev-2']];
  for (const [name, from] of order) {
    const text = await store.read(name);
    if (text === null) continue;
    try {
      const e = JSON.parse(text) as Envelope<T>;
      if (e && typeof e.schemaVersion === 'number' && 'data' in e && valid(e)) return { envelope: e, from };
    } catch {
      // испорченный файл — пробуем следующую копию
    }
  }
  return null;
}

/** Хранилище в памяти — для тестов. */
export function memoryStore(): RawStore & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    read: async name => files.get(name) ?? null,
    write: async (name, text) => void files.set(name, text),
    move: async (from, to) => {
      const t = files.get(from);
      if (t === undefined) throw new Error(`move: no ${from}`);
      files.set(to, t);
      files.delete(from);
    },
    copy: async (from, to) => {
      const t = files.get(from);
      if (t === undefined) throw new Error(`copy: no ${from}`);
      files.set(to, t);
    },
    exists: async name => files.has(name),
  };
}
