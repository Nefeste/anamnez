// OGG наборов CC0 → WAV для tools/audio/clinic.ts: моно, 16 бит, частота исходника.
// Декодер — не зависимость проекта: его ставят во временную папку и запускают оттуда
// (assets/audio/LICENSES.md):
//   npm i @wasm-audio-decoders/ogg-vorbis@0.1.20
//   node <проект>/tools/audio/ogg2wav.mjs <куда> <набор>/Audio/doorOpen_1.ogg …
// Имя файла — «набор__звук.wav»: rpg-audio/Audio/doorOpen_1.ogg → rpg-audio__doorOpen_1.wav.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// декодер ищется от папки, откуда запущено, а не от проекта
const decoderPath = createRequire(join(process.cwd(), 'noop.js')).resolve('@wasm-audio-decoders/ogg-vorbis');
const { OggVorbisDecoder } = await import(pathToFileURL(decoderPath).href);

const [out, ...files] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const decoder = new OggVorbisDecoder();
await decoder.ready;
for (const file of files) {
  await decoder.reset();
  const r = await decoder.decodeFile(new Uint8Array(readFileSync(file)));
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
  const pack = basename(resolve(file, '../..'));
  writeFileSync(join(out, `${pack}__${basename(file, '.ogg')}.wav`), Buffer.concat([h, data]));
}
decoder.free();
console.log(`WAV: ${files.length} → ${out}`);
