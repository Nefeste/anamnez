// Звуки игры (assets/audio, ADR 0013): каждый файл — WAV моно 16 бит 22 050 Гц, как пишут
// tools/audio/gen.ts и clinic.ts; у каждого — строка в LICENSES.md; фон амбулатории — петля 40 с
// без щелчка на стыке, приход пациента — короткий и тише сигналов; тревога монитора (0.5.7) — мелодия
// «сердечной» тревоги, а не одна нота «срочного».
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALARM_MELODY, ALARM_NOTES, ALARM_PULSE, ALARM_STARTS } from '../audio/gen';

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

/** Мощность тона частоты `hz` в отрезке — алгоритм Гёрцеля. */
function tone(x: Float32Array, hz: number): number {
  const c = 2 * Math.cos((2 * Math.PI * hz) / RATE);
  let s1 = 0, s2 = 0;
  for (const v of x) {
    const s0 = v + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

describe('звуки', () => {
  const files = readdirSync(DIR).filter(f => f.endsWith('.wav')).sort();
  const licenses = readFileSync(join(DIR, 'LICENSES.md'), 'utf8');

  test('каждый файл — WAV моно 16 бит 22 050 Гц, без перегрузки, со строкой в LICENSES.md', () => {
    expect(files).toEqual(['alarm.wav', 'ambient.wav', 'arrived.wav', 'ready.wav', 'tap.wav', 'urgent.wav']);
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

  test('тревога монитора — «до ми соль — соль до» дважды, десять импульсов; длиннее «срочного» и не тише его', () => {
    const { x } = read('alarm.wav');
    // какая нота громче всех в середине каждого импульса
    const heard = ALARM_STARTS.map(at => {
      const s0 = Math.round((at + 0.02) * RATE);
      const power = ALARM_NOTES.map(hz => tone(x.subarray(s0, s0 + Math.round((ALARM_PULSE - 0.04) * RATE)), hz));
      return power.indexOf(Math.max(...power));
    });
    expect(heard).toEqual(ALARM_MELODY);
    // между половинами пачки — тишина
    const gap = Math.round((ALARM_STARTS[4] + ALARM_PULSE + 0.05) * RATE);
    expect(peak(x.subarray(gap, gap + Math.round(0.3 * RATE)))).toBeLessThan(0.001);
    const urgent = read('urgent.wav').x;
    expect(x.length).toBeGreaterThan(urgent.length * 2);
    expect(peak(x)).toBeGreaterThanOrEqual(peak(urgent) - 0.01);
  });
});
