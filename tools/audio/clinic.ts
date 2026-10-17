// bun tools/audio/clinic.ts <папка> — звуки амбулатории (spec 2026-09-first-shift: приход
// пациента и фон; spec 2026-10-clinic-voices: голоса и телефон) из набора CC0 и записей под
// CC BY (ADR 0019): Kenney, RPG Audio — kenney.nl, CC0; голоса — Ed Visoso, телефон — Cloud16
// Films, CC BY. В <папке> — исходники, переведённые в WAV (tools/audio/ogg2wav.mjs и
// mp32wav.mjs; какие — в assets/audio/LICENSES.md).
//
// Приход пациента — открывается дверь. Фон — петля 40 с: свой гул вентиляции (gen.ts), далёкие
// голоса и изредка шаги по коридору, дверь вдали, листы бумаги у регистратуры, скрип стула.
// Телефон регистратуры — отдельный файл: игра звонит им изредка, пока играет фон. Моменты —
// из генератора игры с фиксированным зерном: файлы каждый раз одинаковые.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Rng } from '../../src/engine/core/rng';
import { biquad, fadeOut, makeAmbient, normalize, RATE, wav } from './gen';

const OUT = join(import.meta.dir, '../../assets/audio');
/** Длина петли фона, с: в неё укладывается целое число петель вентиляции (8 с). */
export const LOOP = 40;

/**
 * WAV моно 16 бит (заголовок 44 байта, как пишут ogg2wav.mjs и mp32wav.mjs) → отсчёты с частотой
 * игры: фильтр от наложения, линейная интерполяция, тишина по краям — прочь (`edges = false` —
 * оставить: отрезки записи заданы в её секундах).
 */
export function load(dir: string, name: string, edges = true): Float32Array {
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
  return edges ? trim(out) : out;
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

const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

/** Отрезок записи в её секундах. */
const cut = (x: Float32Array, from: number, to: number) => x.slice(Math.round(from * RATE), Math.round(to * RATE));

/** Приход пациента: дверь открывается — тише, чем «готов результат» и «срочный». */
export function makeArrived(dir: string): Float32Array {
  return fadeOut(normalize(load(dir, 'rpg-audio__doorOpen_1'), 0.4), 0.12);
}

/**
 * Голоса: Ed Visoso, очередь записи к врачу-специалисту в больнице ISSSTE (Леон, Мексика), 660 с, CC BY 3.0. Отрезок —
 * ровный гул разговоров без воды из уборной, громких ударов и сигналов телефонов: выбран по спектрограммам. Секунды
 * сверх петли — на стык.
 */
export const VOICES = { name: 'visoso__issste-leon', from: 452, to: 494 };
/** Голоса чуть тише гула вентиляции: среднеквадратичная — эта доля от гула. */
export const VOICES_LEVEL = 0.8;

/**
 * Щелчки и стуки — вровень с гулом: кадр 20 мс громче медианы соседних трёх секунд больше чем на 3 дБ становится тише до
 * неё; приглушение — с запасом в два кадра и плавное, речь между ними не трогается.
 */
function tame(x: Float32Array): Float32Array {
  const h = Math.round(0.02 * RATE);
  const n = Math.floor(x.length / h);
  const db = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * h; j < (i + 1) * h; j++) s += x[j] * x[j];
    db[i] = 10 * Math.log10(s / h + 1e-18);
  }
  const k = 75;
  const over = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const near = Array.from(db.subarray(Math.max(0, i - k), Math.min(n, i + k))).sort((a, b) => a - b);
    over[i] = Math.min(0, near[near.length >> 1] + 3 - db[i]);
  }
  const frame = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) m = Math.min(m, over[j]);
    frame[i] = 10 ** (m / 20);
  }
  // по отсчётам — от середины кадра к середине, затем сгладить вперёд и назад (около 5 мс)
  const g = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const pos = Math.min(n - 1, Math.max(0, i / h - 0.5));
    const j = Math.floor(pos);
    const f = pos - j;
    g[i] = frame[j] * (1 - f) + frame[Math.min(n - 1, j + 1)] * f;
  }
  const a = Math.exp((-2 * Math.PI * 30) / RATE);
  for (let i = 1; i < g.length; i++) g[i] = a * g[i - 1] + (1 - a) * g[i];
  for (let i = g.length - 2; i >= 0; i--) g[i] = a * g[i + 1] + (1 - a) * g[i];
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] * g[i];
  return out;
}

/**
 * Далёкие голоса — петля 40 с: за стеной ниже 200 Гц (гул — у вентиляции) и выше 1,3 кГц — глуше, слов не разобрать;
 * начало петли — смесь продолжения её конца и своего звука, стык не слышен.
 */
export function makeVoices(dir: string): Float32Array {
  const seg = cut(load(dir, VOICES.name, false), VOICES.from, VOICES.to);
  let y = biquad(seg, 'hp', 200, 0.707);
  y = biquad(biquad(y, 'lp', 1300, 0.707), 'lp', 1300, 0.707);
  y = tame(y);
  const len = LOOP * RATE;
  const tail = y.length - len;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = i < tail
      ? Math.sin((Math.PI / 2) * (i / tail)) * y[i] + Math.cos((Math.PI / 2) * (i / tail)) * y[len + i]
      : y[i];
  }
  return out;
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
 * громче, тише. Голоса — всю петлю, тише гула; у краёв петли — ничего, кроме гула и голосов:
 * стык не слышен.
 */
export function makeClinic(dir: string): Float32Array {
  const vent = makeAmbient();
  const out = new Float32Array(LOOP * RATE);
  // гул с голосами вместе — так же громко, как прежде один гул: шаги и двери слышны над ними, как раньше
  const bed = 0.55 / Math.hypot(1, VOICES_LEVEL);
  for (let i = 0; i < out.length; i++) out[i] = bed * vent[i % vent.length];
  const voices = makeVoices(dir);
  const gain = (VOICES_LEVEL * rms(out)) / rms(voices);
  for (let i = 0; i < out.length; i++) out[i] += voices[i] * gain;
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
        const g = 0.1 + 0.26 * Math.sin((Math.PI * (k + 0.5)) / n);
        mix(out, src(STEPS[rng.int(STEPS.length)], 3000), t + k * step, g);
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

/**
 * Телефон: Cloud16 Films, звонок телефона Automatic Electric 80, 12 с, CC BY 4.0. На записи звонки — по-американски,
 * 2–3 с; звонок собран из начала первого (удар бойка и звон) и его конца со спадом колокола.
 */
export const RING = { name: 'cloud16__yellow-ae80', from: 0.45, head: 0.8, end: 3.05, before: 0.25, after: 0.9 };
/** Звонки — по-нашему: 1 с звона, 4 с паузы (начала через 5 с); после третьего сняли трубку. */
export const RINGS = 3;
export const RING_EVERY = 5;

/** Телефон регистратуры: три звонка вдали — выше 3 кГц глуше, ниже 300 Гц тоже; на пиках тише шагов и дверей фона. */
export function makePhone(dir: string): Float32Array {
  const x = load(dir, RING.name, false);
  const head = cut(x, RING.from, RING.from + RING.head);
  const tail = cut(x, RING.end - RING.before, RING.end + RING.after);
  const xf = Math.round(0.04 * RATE);
  const ring = new Float32Array(head.length + tail.length - xf);
  ring.set(head.subarray(0, head.length - xf));
  for (let i = 0; i < xf; i++) {
    const k = (Math.PI / 2) * (i / xf);
    ring[head.length - xf + i] = Math.cos(k) * head[head.length - xf + i] + Math.sin(k) * tail[i];
  }
  ring.set(tail.subarray(xf), head.length);
  fadeOut(ring, 0.3);
  const out = new Float32Array(Math.round((RING_EVERY * (RINGS - 1)) * RATE) + ring.length);
  for (let r = 0; r < RINGS; r++) mix(out, ring, r * RING_EVERY, 1);
  let y = biquad(out, 'hp', 300, 0.707);
  y = biquad(biquad(y, 'lp', 3000, 0.707), 'lp', 3000, 0.707);
  return normalize(y, 0.35);
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) throw new Error('bun tools/audio/clinic.ts <папка с исходниками в WAV>');
  writeFileSync(join(OUT, 'arrived.wav'), wav(makeArrived(dir)));
  writeFileSync(join(OUT, 'ambient.wav'), wav(makeClinic(dir)));
  writeFileSync(join(OUT, 'phone.wav'), wav(makePhone(dir)));
  console.log('приход пациента, фон амбулатории и телефон регистратуры записаны в assets/audio');
}
