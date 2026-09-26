// Хранилище веб-сборки (стенд для сценариев, ADR 0003): localStorage. На телефоне — файлы.
import type { RawStore } from './saves';

const key = (name: string) => `anamnez:saves/${name}`;
const ls = () => globalThis.localStorage;

export const rawStore: RawStore = {
  async read(name) {
    return ls().getItem(key(name));
  },
  async write(name, text) {
    ls().setItem(key(name), text);
  },
  async move(from, to) {
    const t = ls().getItem(key(from));
    if (t === null) throw new Error(`move: no ${from}`);
    ls().setItem(key(to), t);
    ls().removeItem(key(from));
  },
  async copy(from, to) {
    const t = ls().getItem(key(from));
    if (t === null) throw new Error(`copy: no ${from}`);
    ls().setItem(key(to), t);
  },
  async exists(name) {
    return ls().getItem(key(name)) !== null;
  },
};

export async function corrupt(name: string): Promise<void> {
  if (ls().getItem(key(name)) !== null) ls().setItem(key(name), '{ broken');
}
