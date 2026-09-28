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

// --- перенос файлом (transfer.ts): в браузере — скачивание и выбор файла ---------------------

export async function writePickedFile(name: string, text: string): Promise<string | null> {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return name;
}

export function readPickedFile(): Promise<string | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';
    const done = (text: string | null) => {
      input.remove();
      resolve(text);
    };
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (f) f.text().then(done, () => done(null));
      else done(null);
    });
    input.addEventListener('cancel', () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}
