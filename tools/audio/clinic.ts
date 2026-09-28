// bun tools/audio/clinic.ts <папка> — звуки амбулатории (spec 2026-09-first-shift: приход
// пациента и фон) из наборов CC0 (ADR 0013): Kenney, RPG Audio — kenney.nl, CC0. В <папке> —
// исходники, переведённые из OGG наборов в WAV (tools/audio/ogg2wav.mjs; какие — в
// assets/audio/LICENSES.md).
//
// Приход пациента — открывается дверь. Фон — петля 40 с: свой гул вентиляции (gen.ts) и
// изредка шаги по коридору, дверь вдали, листы бумаги у регистратуры, скрип стула. Моменты —
// из генератора игры с фиксированным зерном: файлы каждый раз одинаковые.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Rng } from '../../src/engine/core/rng';
import { biquad, fadeOut, makeAmbient, normalize, RATE, wav } from './gen';

const OUT = join(import.meta.dir, '../../assets/audio');
/** Длина петли фона, с: в неё укладывается целое число петель вентиляции (8 с). */
export const LOOP = 40;

/**
 * WAV моно 16 бит (заголовок 44 байта, как пишет ogg2wav.mjs) → отсчёты с частотой игры:
 * фильтр от наложения, линейная интерполяция, тишина по краям — прочь.
 */
export function load(dir: string, name: string): Float32Array {
  const b = readFileSync(join(dir, `${name}.wav`));
  const rate = b.readUInt32LE(24);
  const n = (b.length - 44) >> 1;
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) raw[i] = b.readInt16LE(44 + i * 2) / 32768;
  // biquad считает частоту от RATE: частоту среза пересчитываем на частоту исходника
  const cut = (9500 * RATE) / rate;
  const x = biquad(biquad(raw, 'lp', cut, 0.707), 'lp', cut, 0.707);
  const m = Math.floor(((n - 1) * RATE) / rate);
  const out = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    const pos = (i * rate) / RATE;
    const j = Math.floor(pos);
    const f = pos - j;
    out[i] = x[j] * (1 - f) + x[j + 1] * f;
  }
  return trim(out);
}

function trim(x: Float32Array): Float32Array {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const thr = peak * 0.005;
  let a = 0;
  let b = x.length - 1;
  while (a < b && Math.abs(x[a]) < thr) a++;
  while (b > a && Math.abs(x[b]) < thr) b--;
  return x.slice(Math.max(0, a - 32), Math.min(x.length, b + 32));
}

function mix(into: Float32Array, src: Float32Array, at: number, gain: number) {
  const s0 = Math.round(at * RATE);
  for (let i = 0; i < src.length && s0 + i < into.length; i++) into[s0 + i] += src[i] * gain;
}

/** Приход пациента: дверь открывается — тише, чем «готов результат» и «срочный». */
export function makeArrived(dir: string): Float32Array {
  return fadeOut(normalize(load(dir, 'rpg-audio__doorOpen_1'), 0.4), 0.12);
}

const STEPS = Array.from({ length: 10 }, (_, i) => `rpg-audio__footstep0${i}`);
const DOORS = [1, 2, 3, 4].map(i => `rpg-audio__doorClose_${i}`);
const PAGES = [1, 2, 3].map(i => `rpg-audio__bookFlip${i}`);
const CREAK = 'rpg-audio__creak3';

type Kind = { kind: 'steps' | 'door' | 'pages' | 'creak'; weight: number };
const KINDS: Kind[] = [
  { kind: 'steps', weight: 45 },
  { kind: 'door', weight: 20 },
  { kind: 'pages', weight: 20 },
  { kind: 'creak', weight: 15 },
];

/**
 * Фон амбулатории. Звуки за стеной — глуше (фильтр ниже 2–3 кГц), шаги проходят мимо — тише,
 * громче, тише. У краёв петли — ничего, кроме вентиляции: стык не слышен.
 */
export function makeClinic(dir: string): Float32Array {
  const vent = makeAmbient();
  const out = new Float32Array(LOOP * RATE);
  for (let i = 0; i < out.length; i++) out[i] = 0.55 * vent[i % vent.length];
  const src = (name: string, lp?: number) => {
    const x = normalize(load(dir, name), 1);
    return lp ? biquad(x, 'lp', lp, 0.707) : x;
  };
  const rng = Rng.seeded(20260928).fork('clinic');
  let t = 2;
  for (;;) {
    const { kind } = rng.weighted(KINDS, k => k.weight);
    if (kind === 'steps') {
      const n = rng.range(6, 9);
      const step = rng.range(470, 560) / 1000;
      if (t + n * step + 1 > LOOP - 2) break;
      for (let k = 0; k < n; k++) {
        const gain = 0.1 + 0.26 * Math.sin((Math.PI * (k + 0.5)) / n);
        mix(out, src(STEPS[rng.int(STEPS.length)], 3000), t + k * step, gain);
      }
      t += n * step;
    } else if (kind === 'door') {
      if (t + 1.5 > LOOP - 2) break;
      mix(out, src(DOORS[rng.int(DOORS.length)], 2200), t, 0.3);
      t += 1;
    } else if (kind === 'pages') {
      const flips = rng.range(1, 3);
      if (t + flips * 0.45 + 1 > LOOP - 2) break;
      for (let k = 0; k < flips; k++) mix(out, src(PAGES[rng.int(PAGES.length)], 5000), t + k * 0.45, 0.28);
      t += flips * 0.45;
    } else {
      if (t + 1 > LOOP - 2) break;
      mix(out, src(CREAK, 4000), t, 0.2);
      t += 0.5;
    }
    t += rng.range(3500, 7500) / 1000;
  }
  return normalize(out, 0.5);
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) throw new Error('bun tools/audio/clinic.ts <папка с исходниками в WAV>');
  writeFileSync(join(OUT, 'arrived.wav'), wav(makeArrived(dir)));
  writeFileSync(join(OUT, 'ambient.wav'), wav(makeClinic(dir)));
  console.log('приход пациента и фон амбулатории записаны в assets/audio');
}
