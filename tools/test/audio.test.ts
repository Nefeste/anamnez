// Звуки игры (assets/audio, ADR 0013): каждый файл — WAV моно 16 бит 22 050 Гц, как пишут
// tools/audio/gen.ts и clinic.ts; у каждого — строка в LICENSES.md; фон амбулатории — петля 40 с
// без щелчка на стыке, приход пациента — короткий и тише сигналов.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dir, '..', '..', 'assets', 'audio');
const RATE = 22050;

function read(name: string) {
  const b = readFileSync(join(DIR, name));
  const header = {
    riff: b.toString('ascii', 0, 4), wave: b.toString('ascii', 8, 12), pcm: b.readUInt16LE(20),
    channels: b.readUInt16LE(22), rate: b.readUInt32LE(24), bits: b.readUInt16LE(34), data: b.toString('ascii', 36, 40),
  };
  const n = (b.length - 44) >> 1;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = b.readInt16LE(44 + i * 2) / 32768;
  return { header, x };
}

const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

describe('звуки', () => {
  const files = readdirSync(DIR).filter(f => f.endsWith('.wav')).sort();
  const licenses = readFileSync(join(DIR, 'LICENSES.md'), 'utf8');

  test('каждый файл — WAV моно 16 бит 22 050 Гц, без перегрузки, со строкой в LICENSES.md', () => {
    expect(files).toEqual(['ambient.wav', 'arrived.wav', 'ready.wav', 'tap.wav', 'urgent.wav']);
    for (const f of files) {
      const { header, x } = read(f);
      expect({ f, ...header }).toEqual({ f, riff: 'RIFF', wave: 'WAVE', pcm: 1, channels: 1, rate: RATE, bits: 16, data: 'data' });
      expect(peak(x)).toBeLessThan(0.99);
      expect(licenses).toContain('| `' + f + '` |');
    }
  });

  test('игра берёт все звуки из assets/audio', () => {
    const code = readFileSync(join(import.meta.dir, '..', '..', 'src', 'audio', 'sounds.ts'), 'utf8');
    for (const f of files) expect(code).toContain(`assets/audio/${f}`);
  });

  test('фон амбулатории — петля 40 с: стык без скачка, шаги и двери слышны над гулом', () => {
    const { x } = read('ambient.wav');
    expect(x.length).toBe(40 * RATE);
    // соседние отсчёты шума вентиляции отличаются на сотые — стык не больше
    expect(Math.abs(x[x.length - 1] - x[0])).toBeLessThan(0.05);
    // пики событий выше среднего гула хотя бы в 8 раз (18 дБ)
    expect(peak(x) / rms(x)).toBeGreaterThan(8);
  });

  test('приход пациента — короче секунды с половиной и тише сигналов «готов» и «срочный»', () => {
    const arrived = read('arrived.wav').x;
    expect(arrived.length / RATE).toBeLessThan(1.5);
    expect(rms(arrived)).toBeLessThan(rms(read('ready.wav').x));
    expect(rms(arrived)).toBeLessThan(rms(read('urgent.wav').x));
  });
});
