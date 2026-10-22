// Значок кодом (0.5.20): контуры из iconShapes.ts — линией, мелочь — заливкой, в сетке 24 × 24, растянутой до
// `size`. На телефоне рисует Skia; на вебе — картинка SVG из тех же контуров: WebGL у браузера немного, а холст,
// который отдаёт его после рисунка, на скрытом экране стека перерисовывается в нулевой размер с ошибкой в консоли.
import { Canvas, Group, Path } from '@shopify/react-native-skia';
import { Image, Platform } from 'react-native';
import { ICON_GRID, ICON_LINE, type IconShape } from './iconShapes';
import { pathOf } from './skPath';

const WEB = Platform.OS === 'web';

/** Тот же значок картинкой SVG — для веба. */
function svgOf(shape: IconShape, color: string): string {
  const stroke = shape.stroke.map(d => `<path d="${d}"/>`).join('');
  const fill = (shape.fill ?? []).map(d => `<path d="${d}" fill="${color}" stroke="none"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ICON_GRID} ${ICON_GRID}" fill="none" stroke="${color}" `
    + `stroke-width="${ICON_LINE}" stroke-linecap="round" stroke-linejoin="round">${stroke}${fill}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function Icon({ shape, size = 24, color }: { shape: IconShape; size?: number; color: string }) {
  if (WEB) return <Image source={{ uri: svgOf(shape, color) }} style={{ width: size, height: size }} aria-hidden />;
  return (
    <Canvas style={{ width: size, height: size }}>
      <Group transform={[{ scale: size / ICON_GRID }]}>
        {shape.stroke.map(d => (
          <Path key={d} path={pathOf(d)} style="stroke" strokeWidth={ICON_LINE} strokeCap="round" strokeJoin="round" color={color} />
        ))}
        {shape.fill?.map(d => <Path key={d} path={pathOf(d)} color={color} />)}
      </Group>
    </Canvas>
  );
}
