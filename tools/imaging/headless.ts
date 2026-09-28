// Skia без экрана — для снимков в тестах и `npm run imaging` (06-architecture.md §11): та же
// CanvasKit, что в веб-сборке, и та же обёртка `Skia` из react-native-skia, только без React
// Native. Модуль `@shopify/react-native-skia` подменяется до первого импорта рисовальщиков.
import { plugin } from 'bun';
import { join } from 'node:path';
import type { SkPicture } from '@shopify/react-native-skia';

const ROOT = join(import.meta.dir, '../..');
const SKIA = join(ROOT, 'node_modules/@shopify/react-native-skia/lib/module');
const CANVASKIT = join(ROOT, 'node_modules/canvaskit-wasm/bin/full');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CanvasKit = any;
let ready: Promise<CanvasKit> | undefined;

/** Загрузить CanvasKit и подставить `Skia` вместо react-native-skia. Повторный вызов — та же загрузка. */
export function loadSkia(): Promise<CanvasKit> {
  ready ??= (async () => {
    const { default: init } = await import(join(CANVASKIT, 'canvaskit.js'));
    const ck = await init({ locateFile: (f: string) => join(CANVASKIT, f) });
    const { JsiSkApi } = await import(join(SKIA, 'skia/web/JsiSkia.js'));
    const types = await import(join(SKIA, 'skia/types/index.js'));
    const Skia = JsiSkApi(ck);
    plugin({
      name: 'skia-headless',
      setup(build) {
        build.module('@shopify/react-native-skia', () => ({ exports: { ...types, Skia }, loader: 'object' }));
      },
    });
    return ck;
  })();
  return ready;
}

/** Нарисовать запись в растровую поверхность: байты RGBA по строкам и PNG. */
export async function rasterize(picture: SkPicture, width: number, height: number): Promise<{ rgba: Uint8Array; png: Uint8Array }> {
  const ck = await loadSkia();
  const surface = ck.MakeSurface(width, height);
  const canvas = surface.getCanvas();
  canvas.clear(ck.BLACK);
  // обёртка JsiSkPicture хранит объект CanvasKit в ref
  canvas.drawPicture((picture as unknown as { ref: unknown }).ref);
  const image = surface.makeImageSnapshot();
  const rgba = image.readPixels(0, 0, { width, height, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB }) as Uint8Array;
  const png = image.encodeToBytes() as Uint8Array;
  image.delete();
  surface.delete();
  return { rgba, png };
}

/** Яркость точки (доли кадра) — 0–255, среднее по квадрату 3 × 3. */
export function luma(rgba: Uint8Array, width: number, height: number, x: number, y: number): number {
  const cx = Math.round(x * (width - 1)), cy = Math.round(y * (height - 1));
  let sum = 0, n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const px = Math.min(width - 1, Math.max(0, cx + dx)), py = Math.min(height - 1, Math.max(0, cy + dy));
      const i = (py * width + px) * 4;
      sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      n++;
    }
  }
  return sum / n;
}
