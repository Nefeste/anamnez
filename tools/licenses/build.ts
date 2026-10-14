// npm run licenses — список лицензий для экрана «Лицензии» (spec 2026-10-licenses, 0.5.6): код JS, который попал в
// сборку для Android, нативные библиотеки и шрифты. Пакеты JS — по карте кода сборки: `expo export --platform android
// --source-maps` во временный каталог (около полутора минут) или готовая карта `--map путь.hbc.map`. Запускать после
// обновления зависимостей; `licenses.test.ts` сверяет готовый файл с node_modules и `native.yaml`.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assemble, packageRoots, ROOT } from './assemble';

const OUT = join(ROOT, 'src/licenses/licenses.json');

function findMap(dir: string): string {
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.hbc.map')) return join(entry.parentPath, entry.name);
  }
  throw new Error(`лицензии: в ${dir} нет карты кода .hbc.map`);
}

const i = process.argv.indexOf('--map');
let map = i >= 0 ? process.argv[i + 1] : '';
let temp = '';
if (!map) {
  temp = mkdtempSync(join(tmpdir(), 'anamnez-licenses-'));
  const run = Bun.spawnSync(['npx', 'expo', 'export', '--platform', 'android', '--source-maps', '--output-dir', temp, '--clear'], { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' });
  if (run.exitCode !== 0) throw new Error('лицензии: expo export не собрал сборку');
  map = findMap(temp);
}
const sources: string[] = JSON.parse(readFileSync(map, 'utf8')).sources;
const licenses = assemble(packageRoots(sources));
writeFileSync(OUT, `${JSON.stringify(licenses, null, 1)}\n`);
if (temp) rmSync(temp, { recursive: true, force: true });
const counts = licenses.groups.map(g => `${g.key} ${g.items.length}`).join(', ');
console.log(`Лицензии: ${counts}; текстов ${Object.keys(licenses.texts).length} → src/licenses/licenses.json`);
