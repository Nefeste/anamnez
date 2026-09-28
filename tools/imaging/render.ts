// npm run imaging — снимки, нарисованные кодом, в PNG без экрана (tools/imaging/out/): смотреть
// рисунок, не собирая веб-версию. Те же варианты, что в «Проверках» (src/state/imagingCases.ts).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadSkia, rasterize } from './headless';

const OUT = join(import.meta.dir, 'out');
mkdirSync(OUT, { recursive: true });
await loadSkia();
const { recordHeadSlice } = await import('../../src/render/ct/head');
const { recordUsSector } = await import('../../src/render/us/sector');
const { HEAD_CASES, US_CASES } = await import('../../src/state/imagingCases');

const SIZE = 480;
for (const k of HEAD_CASES) {
  const t0 = performance.now();
  const picture = recordHeadSlice(SIZE, k.findings, k.seed, k.mode);
  const ms = performance.now() - t0;
  const { png } = await rasterize(picture, SIZE, SIZE);
  await Bun.write(join(OUT, `head-${k.key}.png`), png);
  console.log(`head-${k.key}.png — ${k.label}, запись ${ms.toFixed(1)} мс`);
}
for (const k of US_CASES) {
  const t0 = performance.now();
  const picture = recordUsSector(SIZE, k.findings, k.seed);
  const ms = performance.now() - t0;
  const { png } = await rasterize(picture, SIZE, SIZE);
  await Bun.write(join(OUT, `${k.key}.png`), png);
  console.log(`${k.key}.png — ${k.label}, запись ${ms.toFixed(1)} мс`);
}

// План амбулатории практики (spec 2026-09-living-map): пол, стены, мебель с поворотом, персонал на
// местах и пациенты на стульях — как на карте смены, только без экрана; и атлас целиком.
const { Skia } = await import('@shopify/react-native-skia');
const { recordFloor, CELL_PX } = await import('../../src/render/map/floor');
const { buildAtlas } = await import('../../src/render/map/sprites');
const { angleOf, objectTurns, restHeading } = await import('../../src/render/map/orient');
const { cellXform } = await import('../../src/render/map/xform');
const { bodyIndex, staffFigure } = await import('../../src/render/map/figures');
const { clinicLayout } = await import('../../src/engine/hospital/clinic');
const { db } = await import('../../src/content');
{
  const layout = clinicLayout(db);
  const PX = 96;
  const K = 3;
  const t0 = performance.now();
  const atlas = buildAtlas(PX);
  const atlasMs = performance.now() - t0;
  const W = layout.grid.w * CELL_PX * K;
  const H = layout.grid.h * CELL_PX * K;
  const rec = Skia.PictureRecorder();
  const c = rec.beginRecording(Skia.XYWHRect(0, 0, W, H));
  c.scale(K, K);
  c.drawPicture(recordFloor(layout));
  const turns = objectTurns(layout.grid, layout.objects, layout.staff.map(s => s.cell));
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  const xf = (a: number, x: number, y: number, size = 1) => Skia.RSXform(...cellXform(a, x, y, PX, size));
  c.drawAtlas(atlas.image, layout.objects.map(o => atlas.objectRect(o.kind)), layout.objects.map((o, i) => xf(angleOf(turns[i]), o.x, o.y)), paint);
  const people = [
    ...layout.staff.map(s => ({ fig: staffFigure(s.role === 'doctor' || s.role === 'therapist' ? 'doctor' : /nurse/i.test(s.role) ? 'nurse' : 'staff', s.role), cell: s.cell })),
    ...layout.seats.slice(0, 6).map((cell, i) => ({ fig: { body: bodyIndex({ clothes: i, urgency: (i % 3) as 0 | 1 | 2 }), head: (i * 23) % 105 }, cell })),
  ];
  const at = people.map(p => xf(restHeading(layout.objects, turns, p.cell) ?? 0, p.cell[0], p.cell[1], 1.15));
  c.drawAtlas(atlas.image, people.map(p => atlas.bodyRect(p.fig.body)), at, paint);
  c.drawAtlas(atlas.image, people.map(p => atlas.headRect(p.fig.head)), at, paint);
  const { png } = await rasterize(rec.finishRecordingAsPicture(), W, H);
  await Bun.write(join(OUT, 'map-clinic.png'), png);
  console.log(`map-clinic.png — амбулатория практики, атлас ${atlasMs.toFixed(1)} мс`);

  const aw = atlas.image.width();
  const ah = atlas.image.height();
  const ar = Skia.PictureRecorder();
  const ac = ar.beginRecording(Skia.XYWHRect(0, 0, aw, ah));
  const bg = Skia.Paint();
  bg.setColor(Skia.Color('#F6F3ED'));
  ac.drawRect(Skia.XYWHRect(0, 0, aw, ah), bg);
  ac.drawImage(atlas.image, 0, 0);
  await Bun.write(join(OUT, 'map-atlas.png'), (await rasterize(ar.finishRecordingAsPicture(), aw, ah)).png);
  console.log('map-atlas.png — предметы, тела и головы');
}
