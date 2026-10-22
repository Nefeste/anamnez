// Контуры значков для Skia (0.5.20): строка SVG — в путь один раз; общий запас для Icon.tsx и значков строк карты
// (rowIconArt.ts).
import { Skia, type SkPath } from '@shopify/react-native-skia';

const paths = new Map<string, SkPath>();

/** Контур из строки SVG — один раз на строку: Skia на вебе грузится после модулей, поэтому не при загрузке. */
export function pathOf(d: string): SkPath {
  let p = paths.get(d);
  if (!p) {
    p = Skia.Path.MakeFromSVGString(d) ?? Skia.Path.Make();
    paths.set(d, p);
  }
  return p;
}
