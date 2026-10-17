// Список лицензий для экрана «Лицензии» (spec 2026-10-licenses, 0.5.6): код JS из сборки — по каталогам пакетов в
// node_modules, нативные библиотеки и шрифты — по `native.yaml`. Один и тот же текст хранится один раз. Собирают его
// `build.ts` (по карте кода сборки) и `licenses.test.ts` (по каталогам из готового файла: файл должен совпасть).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { fnv1a } from '../../src/engine/core/hash';
import type { LicenseGroup, LicenseItem, Licenses } from '../../src/licenses/types';

export const ROOT = join(import.meta.dir, '../..');
const TEXTS = join(import.meta.dir, 'texts');

export interface NativeEntry {
  name: string;
  version: string;
  versionFrom?: string;
  via: string;
  license: string;
  holder: string;
  texts: string[];
  source: string;
  maven?: string[];
  archive?: string[];
}

export interface FontEntry {
  name: string;
  files: string[];
  holder: string;
  text: string;
}

/** Запись под CC BY в звуках игры (ADR 0019): название, автор, что с ней сделано и откуда взята. */
export interface SoundEntry {
  name: string;
  holder: string;
  license: string;
  via: string;
  source: string;
  texts: string[];
}

export function readNative(): { android: NativeEntry[]; fonts: FontEntry[]; sounds: SoundEntry[] } {
  return parse(readFileSync(join(import.meta.dir, 'native.yaml'), 'utf8'));
}

/** Файлы с текстом лицензии в каталоге пакета: LICENSE, LICENCE, COPYING, NOTICE — в любом регистре и с расширением. */
const LICENSE_FILE = /^(licen[cs]e|copying|notice)/i;

/**
 * Пакеты монорепозиториев без своего файла лицензии: текст — у пакета-хозяина с той же лицензией и тем же
 * правообладателем (react-native и metro — MIT, Meta; expo-router и @expo/ui — MIT, 650 Industries).
 */
const BORROWED: Record<string, string> = {
  '@react-native/assets-registry': 'node_modules/react-native',
  '@react-native/js-polyfills': 'node_modules/react-native',
  '@react-native/normalize-colors': 'node_modules/react-native',
  '@react-native/virtualized-lists': 'node_modules/react-native',
  'metro-runtime': 'node_modules/react-native',
  'expo-router': 'node_modules/expo',
  '@expo/ui': 'node_modules/expo',
};

/** Лицензия MIT без своего файла (`standard-navigation`): текст MIT с автором из package.json. */
const MIT = (holder: string) => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const authorOf = (pkg: { author?: string | { name?: string } }) => (typeof pkg.author === 'string' ? pkg.author.replace(/\s*[<(].*$/, '') : (pkg.author?.name ?? ''));

function licenseFiles(dir: string): string[] {
  return readdirSync(dir).filter(f => LICENSE_FILE.test(f)).sort().map(f => readFileSync(join(dir, f), 'utf8'));
}

/** Строка правообладателя для списка — первая строка с «Copyright» в тексте лицензии. */
function holderOf(texts: readonly string[], fallback: string): string {
  for (const t of texts) {
    const line = t.split('\n').map(l => l.trim()).find(l => /^copyright\b/i.test(l) && !/notice|holders/i.test(l));
    if (line) return line;
  }
  return fallback;
}

/** Пакет JS из сборки: `path` — каталог от корня репозитория (node_modules/…/имя). */
export function jsItem(path: string, store: (text: string) => string): LicenseItem {
  const dir = join(ROOT, path);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  let texts = licenseFiles(dir);
  if (texts.length === 0 && BORROWED[pkg.name]) texts = licenseFiles(join(ROOT, BORROWED[pkg.name]));
  if (texts.length === 0 && pkg.license === 'MIT' && authorOf(pkg)) texts = [MIT(authorOf(pkg))];
  if (texts.length === 0) throw new Error(`лицензии: у ${pkg.name} нет текста лицензии`);
  return { name: pkg.name, version: pkg.version, license: String(pkg.license), holder: holderOf(texts, authorOf(pkg)), texts: texts.map(store), path };
}

function nativeText(file: string): string {
  return readFileSync(join(TEXTS, file), 'utf8');
}

/** Всё вместе: шрифты, код JS, библиотеки Android, записи звуков; тексты — по отпечатку, без повторов. */
export function assemble(jsPaths: readonly string[]): Licenses {
  const texts: Record<string, string> = {};
  const store = (text: string) => {
    const key = fnv1a(text).toString(16).padStart(8, '0');
    if (texts[key] !== undefined && texts[key] !== text) throw new Error(`лицензии: совпали отпечатки разных текстов ${key}`);
    texts[key] = text;
    return key;
  };
  const native = readNative();
  const fonts: LicenseItem[] = native.fonts.map(f => ({
    name: f.name, license: 'OFL-1.1', holder: f.holder, texts: [store(readFileSync(join(ROOT, 'assets/fonts', f.text), 'utf8'))],
  }));
  const js = [...new Set(jsPaths)]
    .map(p => jsItem(p, store))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version! < b.version! ? -1 : 1));
  const android: LicenseItem[] = native.android.map(n => ({
    name: n.name, version: n.version, license: n.license, holder: n.holder, via: n.via, texts: n.texts.map(t => store(nativeText(t))),
  }));
  const sounds: LicenseItem[] = native.sounds.map(n => ({
    name: n.name, license: n.license, holder: n.holder, via: n.via, source: n.source, texts: n.texts.map(t => store(nativeText(t))),
  }));
  const groups: LicenseGroup[] = [
    { key: 'fonts', items: fonts }, { key: 'js', items: js }, { key: 'android', items: android }, { key: 'sounds', items: sounds },
  ];
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(texts).sort()) sorted[k] = texts[k];
  return { groups, texts: sorted };
}

/** Каталоги пакетов по путям исходников из карты кода сборки (`sources` в .map). */
export function packageRoots(sources: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const s of sources) {
    const i = s.lastIndexOf('node_modules/');
    if (i < 0) continue;
    const rest = s.slice(i + 'node_modules/'.length).split('/');
    const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
    const abs = s.slice(0, i) + 'node_modules/' + name;
    // пути в карте — относительно корня проекта или абсолютные: приводим к пути от корня репозитория
    const rel = abs.includes('/node_modules/') || abs.startsWith('node_modules/') ? abs.slice(abs.indexOf('node_modules/')) : abs;
    if (existsSync(join(ROOT, rel, 'package.json'))) roots.add(rel);
  }
  return [...roots].sort();
}
