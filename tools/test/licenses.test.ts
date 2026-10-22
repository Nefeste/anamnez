// Лицензии открытых компонентов (spec 2026-10-licenses, 0.5.6; 12-publishing.md §8): готовый список совпадает с тем,
// что стоит в node_modules и записано в `tools/licenses/native.yaml`; лицензии — разрешающие, у каждого компонента —
// правообладатель и текст; нативные библиотеки сборки — React Native, Skia, модули Expo — и шрифты все в списке; записи
// звуков под CC BY (0.6.6, ADR 0019) — те же, что в реестре звуков, с источником и тем, что изменено.
import { describe, expect, test } from 'bun:test';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { assemble, readNative, ROOT } from '../licenses/assemble';
import { T } from '../../src/i18n';
import { LICENSES, licenseCount } from '../../src/licenses';

const items = (key: string) => LICENSES.groups.find(g => g.key === key)!.items;
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/**
 * Разрешающие лицензии: условия — назвать авторов и приложить текст; копилефта нет. Записи звуков — CC BY (ADR 0019):
 * без «на тех же условиях» (SA) и «некоммерческого» (NC).
 */
const ALLOWED = new Set([
  'MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'LLVM-exception', 'BSL-1.0', 'Zlib', 'Libpng-2.0', 'FTL', 'IJG',
  'OFL-1.1', 'MIT-Modern-Variant', 'Adobe-DNG-SDK', 'CC-BY-3.0', 'CC-BY-4.0',
]);
const tokens = (license: string) => license.split(/\s+(?:AND|OR|WITH)\s+|[()]/).map(x => x.trim()).filter(Boolean);

/** Имена объектов в архиве ar (GNU): длинные имена — в таблице «//», ссылка «/N» — смещение в ней. */
function archiveMembers(path: string): string[] {
  const fd = openSync(path, 'r');
  const header = Buffer.alloc(60);
  const out: string[] = [];
  let names = '';
  try {
    let off = 8;
    for (;;) {
      if (readSync(fd, header, 0, 60, off) < 60) break;
      const raw = header.toString('latin1', 0, 16).trim();
      const size = Number(header.toString('latin1', 48, 58).trim());
      if (raw === '//') {
        const buf = Buffer.alloc(size);
        readSync(fd, buf, 0, size, off + 60);
        names = buf.toString('latin1');
      } else if (raw !== '/') {
        const name = /^\/\d+$/.test(raw) ? names.slice(Number(raw.slice(1))).split('/\n')[0] : raw.replace(/\/$/, '');
        out.push(name);
      }
      off += 60 + size + (size & 1);
    }
  } finally {
    closeSync(fd);
  }
  return out;
}

describe('список лицензий', () => {
  test('готовый файл совпадает с node_modules и native.yaml: версии, тексты и правообладатели — нынешние', () => {
    const paths = items('js').map(i => i.path!);
    expect(paths.every(Boolean)).toBe(true);
    // если не совпало — npm run licenses (после обновления зависимостей или правки native.yaml)
    expect(assemble(paths)).toEqual(LICENSES);
  });

  test('зависимости игры — в списке; веб-сборка (react-dom, react-native-web) в приложение не попадает', () => {
    const pkg = JSON.parse(read('package.json'));
    const js = new Set(items('js').map(i => i.name));
    const missing = Object.keys(pkg.dependencies).filter(d => !js.has(d) && !['react-dom', 'react-native-web'].includes(d));
    expect(missing).toEqual([]);
    expect(js.has('react-native-web')).toBe(false);
  });

  test('лицензии — разрешающие; у каждого компонента — правообладатель и текст лицензии', () => {
    expect(licenseCount).toBe(LICENSES.groups.reduce((n, g) => n + g.items.length, 0));
    for (const g of LICENSES.groups) {
      expect(g.items.length).toBeGreaterThan(0);
      expect(T.about.licenseGroups[g.key]).toBeDefined();
      for (const item of g.items) {
        expect({ name: item.name, bad: tokens(item.license).filter(x => !ALLOWED.has(x)) }).toEqual({ name: item.name, bad: [] });
        expect({ name: item.name, holder: item.holder.length > 3 }).toEqual({ name: item.name, holder: true });
        expect(item.texts.length).toBeGreaterThan(0);
        for (const key of item.texts) expect({ name: item.name, text: (LICENSES.texts[key] ?? '').length > 150 }).toEqual({ name: item.name, text: true });
      }
    }
    // текст без ссылок на него не хранится
    const used = new Set(LICENSES.groups.flatMap(g => g.items.flatMap(i => i.texts)));
    expect(Object.keys(LICENSES.texts).filter(k => !used.has(k))).toEqual([]);
  });

  test('FreeType, IJG и DNG SDK — с обязательной строкой: их лицензии требуют назвать проект в документации', () => {
    const android = new Map(items('android').map(i => [i.name, i]));
    expect(android.get('FreeType')!.holder).toContain('The FreeType Project');
    expect(android.get('libjpeg-turbo')!.holder).toBe('This software is based in part on the work of the Independent JPEG Group.');
    expect(android.get('DNG SDK')!.holder).toContain('DNG technology under license by Adobe');
  });
});

describe('нативные библиотеки сборки — все в списке', () => {
  const native = readNative();

  test('версии — как в сборке: React Native, Hermes, его библиотеки C++, Skia', () => {
    const toml = read('node_modules/react-native/gradle/libs.versions.toml');
    const versions = Object.fromEntries([...toml.split('[libraries]')[0].matchAll(/^([\w-]+)\s*=\s*"([^"]+)"/gm)].map(m => [m[1], m[2]]));
    const actual = (from: string): string => {
      if (from === 'hermes') return read('node_modules/react-native/sdks/.hermesversion').trim().replace(/^hermes-v/, '');
      if (from === 'skia') return JSON.parse(read('node_modules/react-native-skia-android/package.json')).skia.version.replace(/a$/, '');
      if (from === 'react-native') return JSON.parse(read('node_modules/react-native/package.json')).version;
      // boost — «1_83_0» в Gradle, «1.83.0» в списке
      return versions[from.replace(/^toml:/, '')]?.replace(/_/g, '.');
    };
    const checked = native.android.filter(n => n.versionFrom);
    expect(checked.length).toBeGreaterThanOrEqual(15);
    // у Okio в списке две версии: от React Native и от Expo
    for (const n of checked) expect({ name: n.name, ok: n.version.split(', ').includes(actual(n.versionFrom!)) }).toEqual({ name: n.name, ok: true });
  });

  test('библиотеки C++ React Native (third-party) — все в списке', () => {
    const dirs = readdirSync(join(ROOT, 'node_modules/react-native/ReactAndroid/src/main/jni/third-party'));
    const byDir: Record<string, string> = { boost: 'Boost', 'double-conversion': 'double-conversion', fast_float: 'fast_float', fmt: '{fmt}', folly: 'Folly', glog: 'glog' };
    const names = new Set(native.android.map(n => n.name));
    for (const d of dirs) expect({ dir: d, listed: names.has(byDir[d]) }).toEqual({ dir: d, listed: true });
  });

  test('зависимости Gradle модулей из сборки (android/build.gradle) — каждая группа покрыта записью', () => {
    const groups = native.android.flatMap(n => n.maven ?? []);
    const covered = (group: string) => groups.some(g => group === g || group.startsWith(`${g}.`));
    const missing: string[] = [];
    for (const item of items('js')) {
      const gradle = ['build.gradle', 'build.gradle.kts'].map(f => join(ROOT, item.path!, 'android', f)).find(existsSync);
      if (!gradle) continue;
      for (const m of readFileSync(gradle, 'utf8').matchAll(/^\s*(?:implementation|api)\s*\(?\s*["']([\w.-]+):([\w.-]+)(?::[^"']*)?["']/gm)) {
        if (!covered(m[1])) missing.push(`${item.name}: ${m[1]}:${m[2]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('Skia: сторонний код в готовых библиотеках (react-native-skia-android, все ABI) — в списке', () => {
    const libs = join(ROOT, 'node_modules/react-native-skia-android/libs');
    const listed = new Set(native.android.flatMap(n => n.archive ?? []));
    const prefixes = new Set<string>();
    for (const abi of readdirSync(libs)) {
      for (const a of readdirSync(join(libs, abi)).filter(f => f.endsWith('.a'))) {
        for (const member of archiveMembers(join(libs, abi, a))) prefixes.add(member.split('.')[0]);
      }
    }
    expect(prefixes.size).toBeGreaterThan(30);
    // FreeType, libpng, libjpeg-turbo, HarfBuzz и другие — там, где их ждём
    for (const lib of ['libfreetype2', 'libpng', 'libjpeg', 'libharfbuzz', 'libexpat', 'libwebp', 'libdng_sdk']) expect(prefixes.has(lib)).toBe(true);
    expect([...prefixes].filter(p => !listed.has(p)).sort()).toEqual([]);
    // заголовки 218 МБ архивов: с диска без кэша — до 12 с (полный прогон 0.6.8), из кэша — доли секунды
  }, 30_000);

  test('записи звуков под CC BY — те же, что в реестре assets/audio/LICENSES.md: автор, источник, что изменено, текст CC BY', () => {
    const registry = read('assets/audio/LICENSES.md');
    const sounds = items('sounds');
    expect(sounds.length).toBe(native.sounds.length);
    for (const s of sounds) {
      expect({ name: s.name, license: /^CC-BY-[34]\.0$/.test(s.license) }).toEqual({ name: s.name, license: true });
      expect({ name: s.name, source: registry.includes(s.source ?? '—'), holder: registry.includes(s.holder) }).toEqual({ name: s.name, source: true, holder: true });
      expect((s.via ?? '').length).toBeGreaterThan(20);
      expect(LICENSES.texts[s.texts[0]]).toContain(s.license === 'CC-BY-3.0' ? 'Attribution 3.0 Unported' : 'Attribution 4.0 International');
    }
    // в реестре нет записей под CC BY, которых нет на экране
    const cited = [...new Set([...registry.matchAll(/<(https:\/\/archive\.org\/details\/[^>]+)>[^|\n]*\|[^|\n]*CC BY/g)].map(m => m[1]))];
    expect(cited.sort()).toEqual(sounds.map(s => s.source!).sort());
  });

  test('шрифты из сборки (app.json, expo-font) — с текстом OFL рядом со шрифтом', () => {
    const app = JSON.parse(read('app.json'));
    const plugin = app.expo.plugins.find((p: unknown) => Array.isArray(p) && p[0] === 'expo-font')[1];
    const files = JSON.stringify(plugin).match(/[\w-]+\.ttf/g)!;
    const fonts = new Map(native.fonts.flatMap(f => f.files.map(file => [file, f])));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) expect({ file, listed: fonts.has(file) }).toEqual({ file, listed: true });
    for (const f of native.fonts) expect(read(`assets/fonts/${f.text}`)).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });
});
