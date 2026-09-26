// bun tools/audio/gen.ts — звуки прототипа, синтезированные кодом (ADR 0013: только CC0
// или свои). Детерминированы: шум — из генератора игры с фиксированным зерном.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Rng } from '../../src/engine/core/rng';

const RATE = 22050;
const OUT = join(import.meta.dir, '../../assets/audio');

function wav(samples: Float32Array): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.max(-1, Math.min(1, s)) * 32767, i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const len = (sec: number) => new Float32Array(Math.round(sec * RATE));
const tone = (out: Float32Array, from: number, sec: number, hz: number, gain: number, decay: number) => {
  const n = Math.round(sec * RATE), s0 = Math.round(from * RATE);
  for (let i = 0; i < n && s0 + i < out.length; i++) {
    const t = i / RATE;
    const attack = Math.min(1, i / (0.004 * RATE));
    out[s0 + i] += gain * attack * Math.exp(-t * decay) * Math.sin(2 * Math.PI * hz * t);
  }
};

// касание: короткий щелчок
const tap = len(0.03);
tone(tap, 0, 0.03, 1800, 0.35, 160);
// готов результат: две мягкие ноты вверх
const ready = len(0.5);
tone(ready, 0, 0.3, 660, 0.35, 9);
tone(ready, 0.14, 0.36, 880, 0.35, 9);
// срочный: три пары тревожных сигналов
const urgent = len(1.1);
for (let k = 0; k < 3; k++) {
  tone(urgent, k * 0.36, 0.14, 988, 0.4, 4);
  tone(urgent, k * 0.36 + 0.16, 0.14, 740, 0.4, 4);
}
// фон больницы: низкий гул вентиляции, зациклен без щелчка на стыке
const ambient = len(4);
{
  const r = Rng.seeded(20260926).fork('ambient');
  let brown = 0;
  for (let i = 0; i < ambient.length; i++) {
    brown = 0.985 * brown + 0.015 * ((r.u32() / 4294967296) * 2 - 1);
    ambient[i] = brown * 1.6 + 0.02 * Math.sin((2 * Math.PI * 100 * i) / RATE);
  }
  const fade = Math.round(0.4 * RATE);
  for (let i = 0; i < fade; i++) {
    const a = i / fade;
    ambient[i] = ambient[i] * a + ambient[ambient.length - fade + i] * (1 - a);
  }
  const cut = ambient.slice(0, ambient.length - fade);
  writeFileSync(join(OUT, 'ambient.wav'), wav(cut));
}
writeFileSync(join(OUT, 'tap.wav'), wav(tap));
writeFileSync(join(OUT, 'ready.wav'), wav(ready));
writeFileSync(join(OUT, 'urgent.wav'), wav(urgent));
console.log('звуки записаны в assets/audio');
