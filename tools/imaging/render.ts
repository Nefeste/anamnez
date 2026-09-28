// npm run imaging — снимки, нарисованные кодом, в PNG без экрана (tools/imaging/out/): смотреть
// рисунок, не собирая веб-версию. Те же варианты, что в «Проверках» (src/state/imagingCases.ts).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadSkia, rasterize } from './headless';

const OUT = join(import.meta.dir, 'out');
mkdirSync(OUT, { recursive: true });
await loadSkia();
const { recordHeadSlice } = await import('../../src/render/ct/head');
const { HEAD_CASES } = await import('../../src/state/imagingCases');

const SIZE = 480;
for (const k of HEAD_CASES) {
  const t0 = performance.now();
  const picture = recordHeadSlice(SIZE, k.findings, k.seed, k.mode);
  const ms = performance.now() - t0;
  const { png } = await rasterize(picture, SIZE, SIZE);
  await Bun.write(join(OUT, `head-${k.key}.png`), png);
  console.log(`head-${k.key}.png — ${k.label}, запись ${ms.toFixed(1)} мс`);
}
