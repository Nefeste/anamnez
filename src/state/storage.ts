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

// --- перенос файлом (transfer.ts): системное окно выбора, без сети и без новых модулей -------

/**
 * Записать файл в папку, которую игрок выберет в системном окне, — имя, под которым он лёг
 * (файл с таким именем уже есть — система добавит номер); отказался — null. Отказ приходит
 * исключением PickerCancelledException («…cancelled by the user»).
 */
export async function writePickedFile(name: string, text: string): Promise<string | null> {
  let folder: Directory;
  try {
    folder = await Directory.pickDirectoryAsync();
  } catch (e) {
    if (/cancel/i.test(String(e))) return null;
    throw e;
  }
  const file = folder.createFile(name, 'application/json');
  file.write(text);
  return file.name || name;
}

/** Прочитать файл, который игрок выберет в системном окне; отказался — null. */
export async function readPickedFile(): Promise<string | null> {
  const r = await File.pickFileAsync();
  return r.canceled ? null : r.result.text();
}
