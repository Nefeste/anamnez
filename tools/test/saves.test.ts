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

  test('нет сохранений — null', async () => {
    expect(await loadSlot(memoryStore(), 'shift')).toBeNull();
  });
});
