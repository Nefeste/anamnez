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

export type LoadedFrom = 'current' | 'prev-1' | 'prev-2';

const names = (slot: string) => ({
  current: `${slot}.json`,
  tmp: `${slot}.json.tmp`,
  prev1: `${slot}.prev-1.json`,
  prev2: `${slot}.prev-2.json`,
});

/** Записать: во временный файл, сдвинуть копии, переименовать временный в текущий. */
export async function saveSlot<T>(store: RawStore, slot: string, data: T, schemaVersion: number, savedAt: string): Promise<number> {
  const n = names(slot);
  const text = JSON.stringify({ schemaVersion, savedAt, data } satisfies Envelope<T>);
  await store.write(n.tmp, text);
  if (await store.exists(n.prev1)) await store.copy(n.prev1, n.prev2);
  if (await store.exists(n.current)) await store.copy(n.current, n.prev1);
  await store.move(n.tmp, n.current);
  return text.length;
}

/** Прочитать: текущий, а если он испорчен — предыдущие копии по очереди. */
export async function loadSlot<T>(store: RawStore, slot: string, valid: (e: Envelope<T>) => boolean = () => true): Promise<{ envelope: Envelope<T>; from: LoadedFrom } | null> {
  const n = names(slot);
  const order: [string, LoadedFrom][] = [[n.current, 'current'], [n.prev1, 'prev-1'], [n.prev2, 'prev-2']];
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
