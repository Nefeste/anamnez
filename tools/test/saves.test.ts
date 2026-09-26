// Слоты сохранений (ADR 0010): атомарная запись, копии, откат к копии при порче файла.
import { describe, expect, test } from 'bun:test';
import { loadSlot, memoryStore, saveSlot } from '../../src/state/saves';

describe('сохранения', () => {
  test('записали — прочитали то же самое', async () => {
    const s = memoryStore();
    await saveSlot(s, 'shift', { day: 1 }, 1, 't1');
    const r = await loadSlot<{ day: number }>(s, 'shift');
    expect(r?.from).toBe('current');
    expect(r?.envelope.data).toEqual({ day: 1 });
    expect(s.files.has('shift.json.tmp')).toBe(false);
  });

  test('копии сдвигаются: текущий → первая копия → вторая', async () => {
    const s = memoryStore();
    for (const day of [1, 2, 3]) await saveSlot(s, 'shift', { day }, 1, `t${day}`);
    expect(JSON.parse(s.files.get('shift.json')!).data.day).toBe(3);
    expect(JSON.parse(s.files.get('shift.prev-1.json')!).data.day).toBe(2);
    expect(JSON.parse(s.files.get('shift.prev-2.json')!).data.day).toBe(1);
  });

  test('испорченный текущий файл — читается предыдущая копия', async () => {
    const s = memoryStore();
    await saveSlot(s, 'shift', { day: 1 }, 1, 't1');
    await saveSlot(s, 'shift', { day: 2 }, 1, 't2');
    s.files.set('shift.json', '{ испорчено');
    const r = await loadSlot<{ day: number }>(s, 'shift');
    expect(r?.from).toBe('prev-1');
    expect(r?.envelope.data.day).toBe(1);
  });

  test('проверка содержимого тоже может отвергнуть файл', async () => {
    const s = memoryStore();
    await saveSlot(s, 'shift', { day: 1 }, 1, 't1');
    await saveSlot(s, 'shift', { day: -5 }, 1, 't2');
    const r = await loadSlot<{ day: number }>(s, 'shift', e => e.data.day > 0);
    expect(r?.envelope.data.day).toBe(1);
  });

  test('копии сдвигаются переименованием: полных копий файла нет, временного не остаётся', async () => {
    const s = memoryStore();
    const copies: string[] = [];
    const copy = s.copy;
    s.copy = async (from, to) => {
      copies.push(`${from}→${to}`);
      await copy(from, to);
    };
    for (const day of [1, 2, 3, 4]) await saveSlot(s, 'shift', { day }, 1, `t${day}`);
    expect(copies).toEqual([]);
    expect([...s.files.keys()].sort()).toEqual(['shift.json', 'shift.prev-1.json', 'shift.prev-2.json']);
  });

  test('запись прервалась между сдвигом копий и заменой — читается временный, ничего не потеряно', async () => {
    const s = memoryStore();
    await saveSlot(s, 'shift', { day: 1 }, 1, 't1');
    await saveSlot(s, 'shift', { day: 2 }, 1, 't2');
    // третья запись: временный записан, копии сдвинуты, а заменить не успели
    await s.write('shift.json.tmp', JSON.stringify({ schemaVersion: 1, savedAt: 't3', data: { day: 3 } }));
    await s.move('shift.prev-1.json', 'shift.prev-2.json');
    await s.move('shift.json', 'shift.prev-1.json');
    const r = await loadSlot<{ day: number }>(s, 'shift');
    expect(r?.from).toBe('tmp');
    expect(r?.envelope.data.day).toBe(3);
  });

  test('недописанный временный пропускается — читается предыдущая копия', async () => {
    const s = memoryStore();
    await saveSlot(s, 'shift', { day: 1 }, 1, 't1');
    await saveSlot(s, 'shift', { day: 2 }, 1, 't2');
    await s.move('shift.json', 'shift.prev-1.json');
    s.files.set('shift.json.tmp', '{"schemaVersion":1,"savedAt":"t3","da');
    const r = await loadSlot<{ day: number }>(s, 'shift');
    expect(r?.from).toBe('prev-1');
    expect(r?.envelope.data.day).toBe(2);
  });

  test('нет сохранений — null', async () => {
    expect(await loadSlot(memoryStore(), 'shift')).toBeNull();
  });
});
