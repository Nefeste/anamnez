// Фигура человека в «Осмотреть» (0.6.0): контур, тонкие линии и пупок из bodyShape.ts, цветом темы. На телефоне рисует
// Skia; на вебе — картинка SVG из тех же контуров, как значки (Icon.tsx): холсту Skia в браузере нужен WebGL.
import { Canvas, Group, Path, Skia, type SkPath } from '@shopify/react-native-skia';
import { Image, Platform } from 'react-native';
import { BODY_DETAIL, BODY_H, BODY_LINE, BODY_SHAPE, BODY_W } from '@/ui/bodyShape';
import { useTheme } from '@/ui/theme';

const WEB = Platform.OS === 'web';
const paths = new Map<string, SkPath>();

/** Контур из строки SVG — один раз на строку: Skia на вебе грузится после модулей, поэтому не при загрузке. */
function pathOf(d: string): SkPath {
  let p = paths.get(d);
  if (!p) {
    p = Skia.Path.MakeFromSVGString(d) ?? Skia.Path.Make();
    paths.set(d, p);
  }
  return p;
}

function svgOf(fill: string, line: string): string {
  const detail = BODY_SHAPE.lines.map(d => `<path d="${d}" fill="none" stroke="${line}" stroke-width="${BODY_DETAIL}" stroke-linecap="round"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BODY_W} ${BODY_H}">`
    + `<path d="${BODY_SHAPE.body}" fill="${fill}" stroke="${line}" stroke-width="${BODY_LINE}" stroke-linejoin="round"/>`
    + `${detail}<path d="${BODY_SHAPE.navel}" fill="${line}"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Фигура шириной `width`; высота — по полю рисунка. */
export function BodyFigure({ width }: { width: number }) {
  const theme = useTheme();
  const { figure, figureLine } = theme.colors;
  const height = (width * BODY_H) / BODY_W;
  if (WEB) return <Image source={{ uri: svgOf(figure, figureLine) }} style={{ width, height }} aria-hidden />;
  return (
    <Canvas style={{ width, height }}>
      <Group transform={[{ scale: width / BODY_W }]}>
        <Path path={pathOf(BODY_SHAPE.body)} color={figure} />
        <Path path={pathOf(BODY_SHAPE.body)} style="stroke" strokeWidth={BODY_LINE} strokeJoin="round" color={figureLine} />
        {BODY_SHAPE.lines.map(d => <Path key={d} path={pathOf(d)} style="stroke" strokeWidth={BODY_DETAIL} strokeCap="round" color={figureLine} />)}
        <Path path={pathOf(BODY_SHAPE.navel)} color={figureLine} />
      </Group>
    </Canvas>
  );
}
