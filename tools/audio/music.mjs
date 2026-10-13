// Музыка из наборов CC0 (assets/audio/LICENSES.md, часть 62): MP3 → тишина по краям срезана, громкость выровнена, края
// плавные, чтобы петля не щёлкала, → MP3 128 кбит/с, стерео, частота исходника. Декодер и кодировщик — не зависимости
// проекта: их ставят во временную папку и запускают оттуда:
//   npm i mpg123-decoder@1.0.3 @breezystack/lamejs@1.2.7
//   node <проект>/tools/audio/music.mjs <исходник.mp3> <куда.mp3> [громкость, дБ RMS; по умолчанию −20]
// При тех же исходниках файл получается тот же.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// декодер и кодировщик ищутся от папки, откуда запущено, а не от проекта
const need = createRequire(join(process.cwd(), 'noop.js'));
const { MPEGDecoder } = await import(pathToFileURL(need.resolve('mpg123-decoder')).href);
// ветка lamejs с исправленным запуском в Node (у lamejs 1.2.1 — «MPEGMode is not defined»); её сборка-модуль — по пути:
// поиск пакета через require отдаёт сборку для <script>, без экспорта
const { Mp3Encoder } = await import(pathToFileURL(join(process.cwd(), 'node_modules/@breezystack/lamejs/dist/lamejs.js')).href);

const [src, out, level = '-20'] = process.argv.slice(2);
if (!src || !out) {
  console.error('node tools/audio/music.mjs <исходник.mp3> <куда.mp3> [дБ RMS]');
  process.exit(1);
}

const decoder = new MPEGDecoder();
await decoder.ready;
const { channelData, sampleRate } = decoder.decode(new Uint8Array(readFileSync(src)));
decoder.free();
const [left, right = left] = channelData;

// тишина по краям — тише −50 дБ в обоих каналах
const QUIET = 10 ** (-50 / 20);
const loud = i => Math.abs(left[i]) > QUIET || Math.abs(right[i]) > QUIET;
let from = 0;
while (from < left.length && !loud(from)) from++;
let to = left.length;
while (to > from && !loud(to - 1)) to--;
const n = to - from;

// громкость — по среднеквадратичной, но без перегруза: пик не выше −1 дБ
let sum = 0;
let peak = 0;
for (let i = from; i < to; i++) {
  sum += left[i] * left[i] + right[i] * right[i];
  peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
}
const rms = Math.sqrt(sum / (2 * n));
const gain = Math.min(10 ** (Number(level) / 20) / rms, 10 ** (-1 / 20) / peak);

// края — две секунды нарастания и затухания: петля дышит, а не щёлкает
const FADE = 2 * sampleRate;
const pcm = (ch, i) => {
  const k = Math.min(1, i / FADE, (n - 1 - i) / FADE);
  return Math.round(Math.max(-1, Math.min(1, ch[from + i] * gain * k)) * 32767);
};
const l = new Int16Array(n);
const r = new Int16Array(n);
for (let i = 0; i < n; i++) {
  l[i] = pcm(left, i);
  r[i] = pcm(right, i);
}

const encoder = new Mp3Encoder(2, sampleRate, 128);
const parts = [];
for (let i = 0; i < n; i += 1152) {
  const chunk = encoder.encodeBuffer(l.subarray(i, i + 1152), r.subarray(i, i + 1152));
  if (chunk.length) parts.push(Buffer.from(chunk));
}
const last = encoder.flush();
if (last.length) parts.push(Buffer.from(last));
writeFileSync(out, Buffer.concat(parts));
const db = x => (20 * Math.log10(x)).toFixed(1);
console.log(`${out}: ${(n / sampleRate).toFixed(1)} с, срезано ${((left.length - n) / sampleRate).toFixed(2)} с тишины, усиление ${db(gain)} дБ (RMS было ${db(rms)} дБ, пик ${db(peak)} дБ)`);
