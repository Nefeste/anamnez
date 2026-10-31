// bun tools/audio/gen.ts — звуки, синтезированные кодом (ADR 0013: только CC0 или свои):
// касание, «готов результат», «срочный», тревога монитора. Гул вентиляции (makeAmbient) — основа фона
// амбулатории: сам фон с шагами и дверями из наборов CC0 собирает tools/audio/clinic.ts.
// Детерминированы: шум — из генератора игры с фиксированным зерном.
//
// Звучат они из динамика телефона, а он почти не воспроизводит частоты ниже ~250 Гц.
// Поэтому у звуков есть обертоны в полосе 300 Гц – 5 кГц, и фон лежит в этой полосе:
// прежний фон был гулом ниже 60 Гц, и из телефона от него оставалось одно шипение.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Rng } from '../../src/engine/core/rng';

export const RATE = 22050;
const OUT = join(import.meta.dir, '../../assets/audio');

export function wav(samples: Float32Array): Buffer {
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
export function biquad(input: Float32Array, kind: 'lp' | 'hp' | 'bp', hz: number, q: number): Float32Array {
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

export function noise(n: number, name: string): Float32Array {
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

export function normalize(x: Float32Array, peak: number): Float32Array {
  let m = 0;
  for (const v of x) {
    if (!Number.isFinite(v)) throw new Error('gen: NaN or Infinity in a sound');
    m = Math.max(m, Math.abs(v));
  }
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / m;
  return x;
}

/** Мягкое затухание в конце — без щелчка при обрыве. */
export function fadeOut(x: Float32Array, sec: number): Float32Array {
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

/** Ноты тревоги монитора, Гц: до, ми, соль второй октавы и до третьей. */
export const ALARM_NOTES = [523.25, 659.26, 783.99, 1046.5];
/** Номер ноты на каждый из десяти импульсов: «до ми соль — соль до», пауза, ещё раз. */
export const ALARM_MELODY = [0, 1, 2, 2, 3, 0, 1, 2, 2, 3];
/** Импульс — 0,13 с, промежуток — 0,05 с; между третьим и четвёртым — два промежутка и импульс тишины, между половинами — 0,45 с. */
export const ALARM_PULSE = 0.13;
export const ALARM_STARTS = (() => {
  const step = ALARM_PULSE + 0.05;
  const half = [0, step, 2 * step, 4 * step, 5 * step];
  return [...half, ...half.map(at => at + 5 * step + ALARM_PULSE + 0.45)];
})();

/**
 * Тревога монитора при остановке сердца (FR-AV-1): мелодия «сердечной» тревоги высокого приоритета из приложения F
 * стандарта IEC 60601-1-8 (издание 2006 года с поправкой 2012-го) — до, ми, соль, пауза, соль и до октавой выше;
 * пачка из десяти импульсов, тембр — как у «срочного». Поправка 2020 года советует вместо мелодий звуковые образы,
 * но мелодию узнают, и от «срочного» — одной ноты — она отличается с первого импульса.
 */
export function makeAlarm(): Float32Array {
  const out = len(ALARM_STARTS[ALARM_STARTS.length - 1] + ALARM_PULSE + 0.05);
  const harmonics = [1, 0.7, 0.5, 0.35, 0.22];
  ALARM_STARTS.forEach((at, k) => {
    const f0 = ALARM_NOTES[ALARM_MELODY[k]];
    const s0 = Math.round(at * RATE), n = Math.round(ALARM_PULSE * RATE);
    for (let i = 0; i < n && s0 + i < out.length; i++) {
      const t = i / RATE;
      const env = Math.max(0, Math.min(1, t / 0.012, (ALARM_PULSE - t) / 0.02));
      let v = 0;
      harmonics.forEach((amp, h) => (v += amp * Math.sin(2 * Math.PI * f0 * (h + 1) * t)));
      out[s0 + i] += env * v;
    }
  });
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

/** Отрезок шума с огибающей: `attack` и `release` — секунды; полоса — фильтром снаружи. */
function burst(out: Float32Array, at: number, sec: number, src: Float32Array, gain: number, attack: number, release: number) {
  const s0 = Math.round(at * RATE);
  const n = Math.round(sec * RATE);
  for (let i = 0; i < n && s0 + i < out.length; i++) {
    const t = i / RATE;
    const env = Math.min(1, t / attack, (sec - t) / release);
    out[s0 + i] += gain * Math.max(0, env) * src[(s0 + i) % src.length];
  }
}

/**
 * Манжета тонометра (spec 2026-10-premium-polish, осмотр у постели): пять качков груши — шипящие толчки воздуха, каждый
 * чуть выше тоном, — и спуск воздуха шипением, которое затихает. Шум — из генератора игры, в полосе телефона.
 */
export function makeCuff(): Float32Array {
  const out = len(1.7);
  const air = biquad(biquad(noise(out.length, 'cuff'), 'hp', 700, 0.8), 'lp', 2600, 0.8);
  for (let k = 0; k < 5; k++) burst(out, 0.05 + k * 0.2, 0.11, air, 0.9 + k * 0.05, 0.015, 0.05);
  // спуск — длинный, тише, к концу глуше
  const s0 = Math.round(1.08 * RATE);
  const hiss = biquad(air, 'lp', 1500, 0.7);
  for (let i = 0; s0 + i < out.length; i++) {
    const t = i / RATE;
    out[s0 + i] += 0.5 * Math.min(1, t / 0.03) * Math.exp(-t / 0.28) * hiss[s0 + i];
  }
  return fadeOut(normalize(out, 0.42), 0.05);
}

/** Писк монитора (ЭКГ, приборы у постели): три коротких мягких тона пульсоксиметра — до третьей октавы, с обертоном. */
export function makeMonitor(): Float32Array {
  const out = len(1.15);
  for (const at of [0, 0.42, 0.84]) {
    const s0 = Math.round(at * RATE), n = Math.round(0.09 * RATE);
    for (let i = 0; i < n && s0 + i < out.length; i++) {
      const t = i / RATE;
      const env = Math.max(0, Math.min(1, t / 0.008, (0.09 - t) / 0.03));
      out[s0 + i] += env * (Math.sin(2 * Math.PI * 1046.5 * t) + 0.25 * Math.sin(2 * Math.PI * 2093 * t));
    }
  }
  return normalize(out, 0.36);
}

/**
 * Экспозиция рентгена (снимок, КТ, МРТ): гул трубки — тон 400 Гц с обертонами и дрожью 100 Гц, полсекунды, — и щелчок
 * реле в конце.
 */
export function makeXray(): Float32Array {
  const out = len(0.75);
  const n = Math.round(0.52 * RATE);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const env = Math.max(0, Math.min(1, t / 0.03, (0.52 - t) / 0.06));
    const am = 1 - 0.35 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 100 * t));
    let v = 0;
    [1, 0.5, 0.3, 0.18].forEach((amp, k) => (v += amp * Math.sin(2 * Math.PI * 400 * (k + 1) * t)));
    out[i] += env * am * v;
  }
  const click = biquad(noise(Math.round(0.03 * RATE), 'xray'), 'hp', 1800, 0.7);
  burst(out, 0.56, 0.025, click, 2.2, 0.001, 0.015);
  return normalize(out, 0.4);
}

/** Пробирки (анализы в лабораторию, экспресс-тесты): два стеклянных «тинь» разной высоты, затухают быстро. */
export function makeTubes(): Float32Array {
  const out = len(0.6);
  const GLASS: [number, number, number][] = [[1, 1, 0.05], [2.7, 0.35, 0.025], [5.1, 0.15, 0.012]];
  note(out, 0.02, 2400, 0.8, GLASS, 0.001);
  note(out, 0.17, 3050, 0.65, GLASS, 0.001);
  return fadeOut(normalize(out, 0.34), 0.05);
}

if (import.meta.main) {
  writeFileSync(join(OUT, 'tap.wav'), wav(makeTap()));
  writeFileSync(join(OUT, 'ready.wav'), wav(makeReady()));
  writeFileSync(join(OUT, 'urgent.wav'), wav(makeUrgent()));
  writeFileSync(join(OUT, 'alarm.wav'), wav(makeAlarm()));
  writeFileSync(join(OUT, 'cuff.wav'), wav(makeCuff()));
  writeFileSync(join(OUT, 'monitor.wav'), wav(makeMonitor()));
  writeFileSync(join(OUT, 'xray.wav'), wav(makeXray()));
  writeFileSync(join(OUT, 'tubes.wav'), wav(makeTubes()));
  console.log('звуки записаны в assets/audio; фон амбулатории — tools/audio/clinic.ts');
}
