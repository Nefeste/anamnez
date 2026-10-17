// MP3 записей под CC BY (ADR 0019) → WAV для tools/audio/clinic.ts: моно, 16 бит, частота исходника.
// Декодер — не зависимость проекта: его ставят во временную папку и запускают оттуда
// (assets/audio/LICENSES.md):
//   npm i mpg123-decoder@1.0.3
//   node <проект>/tools/audio/mp32wav.mjs <куда> <запись.mp3>=<имя> …
// Файл — «<имя>.wav»: имя задаёт, под каким его ищет clinic.ts.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// декодер ищется от папки, откуда запущено, а не от проекта
const decoderPath = createRequire(join(process.cwd(), 'noop.js')).resolve('mpg123-decoder');
const { MPEGDecoder } = await import(pathToFileURL(decoderPath).href);

const [out, ...pairs] = process.argv.slice(2);
if (!out || pairs.length === 0 || pairs.some(p => !p.includes('='))) {
  console.error('node tools/audio/mp32wav.mjs <куда> <запись.mp3>=<имя> …');
  process.exit(1);
}
mkdirSync(out, { recursive: true });
const decoder = new MPEGDecoder();
await decoder.ready;
for (const pair of pairs) {
  const at = pair.lastIndexOf('=');
  const file = pair.slice(0, at);
  const name = pair.slice(at + 1);
  await decoder.reset();
  const r = decoder.decode(new Uint8Array(readFileSync(file)));
  const n = r.channelData[0].length;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const c of r.channelData) s += c[i];
    s /= r.channelData.length;
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(r.sampleRate, 24);
  h.writeUInt32LE(r.sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  writeFileSync(join(out, `${name}.wav`), Buffer.concat([h, data]));
}
decoder.free();
console.log(`WAV: ${pairs.length} → ${out}`);
