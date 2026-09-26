// Хранилище на телефоне: файлы в каталоге документов приложения (07-data-model.md §4).
// API expo-file-system SDK 57: File, Directory, Paths (сверено с типами пакета).
import { Directory, File, Paths } from 'expo-file-system';
import type { RawStore } from './saves';

const dir = new Directory(Paths.document, 'saves');
const file = (name: string) => new File(dir, name);
const ensureDir = () => dir.create({ intermediates: true, idempotent: true });

export const rawStore: RawStore = {
  async read(name) {
    const f = file(name);
    return f.exists ? f.text() : null;
  },
  async write(name, text) {
    ensureDir();
    const f = file(name);
    if (!f.exists) f.create();
    f.write(text);
  },
  // синхронно: переименование — дело метаданных, а асинхронная версия каждый раз ходит в
  // фоновый поток и обратно
  async move(from, to) {
    file(from).moveSync(file(to), { overwrite: true });
  },
  async copy(from, to) {
    file(from).copySync(file(to), { overwrite: true });
  },
  async exists(name) {
    return file(name).exists;
  },
};

/** Испортить файл — только для проверки отката в прототипе П6. */
export async function corrupt(name: string): Promise<void> {
  const f = file(name);
  if (f.exists) f.write('{ broken');
}
