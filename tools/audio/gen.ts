// bun tools/audio/gen.ts — звуки прототипа, синтезированные кодом (ADR 0013: только CC0
// или свои). Детерминированы: шум — из генератора игры с фиксированным зерном.
//
// Звучат они из динамика телефона, а он почти не воспроизводит частоты ниже ~250 Гц.
// Поэтому у звуков есть обертоны в полосе 300 Гц – 5 кГц, и фон лежит в этой полосе:
// прежний фон был гулом ниже 60 Гц, и из телефона от него оставалось одно шипение.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Rng } from '../../src/engine/core/rng';

export const RATE = 22050;
const OUT = join(import.meta.dir, '../../assets/audio');

function wav(samples: Float32Array): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const len = (sec: number) => new Float32Array(Math.round(sec * RATE));

/** Двухполюсный фильтр по «поваренной книге» RBJ. */
function biquad(input: Float32Array, kind: 'lp' | 'hp' | 'bp', hz: number, q: number): Float32Array {
  const w = (2 * Math.PI * hz) / RATE;
  const alpha = Math.sin(w) / (2 * q);
  const cos = Math.cos(w);
  const [b0, b1, b2] = kind === 'lp' ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2]
    : kind === 'hp' ? [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2]
      : [alpha, 0, -alpha];
  const a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
  const out = new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    out[i] = y;
  }
  return out;
}

function noise(n: number, name: string): Float32Array {
  const r = Rng.seeded(20260926).fork(name);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (r.u32() / 4294967296) * 2 - 1;
  return out;
}

/** Нота с обертонами: [множитель частоты, громкость, время затухания в секундах]. */
function note(out: Float32Array, at: number, hz: number, gain: number, partials: [number, number, number][], attack = 0.003) {
  const s0 = Math.round(at * RATE);
  for (let i = 0; s0 + i < out.length; i++) {
    const t = i / RATE;
    const a = t < attack ? 0.5 - 0.5 * Math.cos((Math.PI * t) / attack) : 1;
    let v = 0;
    for (const [mul, amp, tau] of partials) v += amp * Math.exp(-t / tau) * Math.sin(2 * Math.PI * hz * mul * t);
    out[s0 + i] += gain * a * v;
  }
}

function normalize(x: Float32Array, peak: number): Float32Array {
  let m = 0;
  for (const v of x) {
    if (!Number.isFinite(v)) throw new Error('gen: NaN or Infinity in a sound');
    m = Math.max(m, Math.abs(v));
  }
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / m;
  return x;
}

/** Мягкое затухание в конце — без щелчка при обрыве. */
function fadeOut(x: Float32Array, sec: number): Float32Array {
  const n = Math.min(x.length, Math.round(sec * RATE));
  for (let i = 0; i < n; i++) x[x.length - 1 - i] *= i / n;
  return x;
}

/**
 * Касание: короткий «тик» 1800 Гц — как в 0.0.1. «Тук» из 0.0.2 владелец счёл хуже; в игре
 * касание теперь — вибрацией, а этот звук остаётся на экране проверки до эталона.
 */
export function makeTap(): Float32Array {
  const out = len(0.03);
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const attack = Math.min(1, i / (0.004 * RATE));
    out[i] = 0.35 * attack * Math.exp(-t * 160) * Math.sin(2 * Math.PI * 1800 * t);
  }
  return out;
}

/** Обертоны деревянной пластины маримбы: основной тон держится, верхние гаснут быстро. */
const MARIMBA: [number, number, number][] = [[1, 1, 0.42], [2, 0.12, 0.18], [3.9, 0.28, 0.05], [9.2, 0.06, 0.015]];

/** Готов результат: две ноты маримбы вверх на кварту — соль и до второй октавы. */
export function makeReady(): Float32Array {
  const out = len(0.9);
  note(out, 0, 783.99, 0.8, MARIMBA);
  note(out, 0.12, 1046.5, 0.8, MARIMBA);
  return fadeOut(normalize(out, 0.5), 0.15);
}

/**
 * Срочный: как тревога монитора высокого приоритета — три и два импульса тона с
 * обертонами (у медицинских тревог их не меньше четырёх, чтобы сигнал не терялся в шуме).
 */
export function makeUrgent(): Float32Array {
  const out = len(1.1);
  const f0 = 880;
  const harmonics = [1, 0.7, 0.5, 0.35, 0.22];
  for (const at of [0, 0.18, 0.36, 0.7, 0.88]) {
    const s0 = Math.round(at * RATE), n = Math.round(0.13 * RATE);
    for (let i = 0; i < n && s0 + i < out.length; i++) {
      const t = i / RATE;
      const env = Math.max(0, Math.min(1, t / 0.012, (0.13 - t) / 0.02));
      let v = 0;
      harmonics.forEach((amp, k) => (v += amp * Math.sin(2 * Math.PI * f0 * (k + 1) * t)));
      out[s0 + i] += env * v;
    }
  }
  return normalize(out, 0.55);
}

/**
 * Фон: вентиляция и далёкий гул приборов в полосе, которую слышно из телефона. Петля 8 с:
 * модуляция и гул укладываются в неё целым числом периодов, шум сводится перекрёстным
 * затуханием равной мощности — стык не щёлкает.
 */
export function makeAmbient(): Float32Array {
  const loop = Math.round(8 * RATE), tail = Math.round(0.6 * RATE);
  let air = noise(loop + tail, 'ambient');
  air = biquad(biquad(air, 'hp', 180, 0.7), 'lp', 900, 0.7);
  air = biquad(air, 'lp', 1400, 0.7);
  const out = new Float32Array(loop);
  for (let i = 0; i < loop; i++) {
    // начало петли — смесь её хвоста (продолжения конца) и собственного звука
    const mixed = i < tail
      ? Math.sin((Math.PI / 2) * (i / tail)) * air[i] + Math.cos((Math.PI / 2) * (i / tail)) * air[loop + i]
      : air[i];
    const t = i / RATE;
    const swell = 1 + 0.18 * Math.sin((2 * Math.PI * t) / 8) + 0.08 * Math.sin((2 * Math.PI * 3 * t) / 8);
    const hum = 0.05 * Math.sin(2 * Math.PI * 100 * t) + 0.04 * Math.sin(2 * Math.PI * 300 * t) + 0.02 * Math.sin(2 * Math.PI * 500 * t);
    out[i] = mixed * swell * 3 + hum * 0.4;
  }
  return normalize(out, 0.35);
}

if (import.meta.main) {
  writeFileSync(join(OUT, 'tap.wav'), wav(makeTap()));
  writeFileSync(join(OUT, 'ready.wav'), wav(makeReady()));
  writeFileSync(join(OUT, 'urgent.wav'), wav(makeUrgent()));
  writeFileSync(join(OUT, 'ambient.wav'), wav(makeAmbient()));
  console.log('звуки записаны в assets/audio');
}
