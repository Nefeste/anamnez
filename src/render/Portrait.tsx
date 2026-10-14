// Портрет человека кодом из зерна (ADR 0013): лицо, возраст, волосы, очки, одежда. `still` —
// как у рентгена (Xray.tsx). `uniform` — сотрудник больницы (FR-AV-4, 0.5.7): та же внешность, но в форме, цвета —
// как у его фигурки на карте (map/sprites.ts): врач — в белом халате со стетоскопом, медсестра — в голубом костюме и
// шапочке, остальные — в сиреневой блузе с бейджем.
import { Canvas, Circle, Group, Oval, Path, Rect, RoundedRect, Skia } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { lookOf } from './look';
import type { Uniform } from './map/figures';

const COAT = { doctor: ['#FFFFFF', '#8FA3A8'], nurse: ['#6FA8DC', '#3D6E99'], staff: ['#E6E0F0', '#6E5E96'] } as const;
const CAP_EDGE = '#AFC4D2';

export function Portrait({ seed, sex, age, size = 72, still = false, uniform }: { seed: number; sex: 'm' | 'f'; age: number; size?: number; still?: boolean; uniform?: Uniform }) {
  const look = useMemo(() => lookOf(seed, sex, age), [seed, sex, age]);

  const s = size;
  const smile = useMemo(() => {
    const p = Skia.PathBuilder.Make();
    p.moveTo(s * 0.42, s * 0.62).quadTo(s * 0.5, s * 0.66, s * 0.58, s * 0.62);
    return p.detach();
  }, [s]);
  const wrinkle = useMemo(() => {
    const p = Skia.PathBuilder.Make();
    p.moveTo(s * 0.4, s * 0.36).lineTo(s * 0.6, s * 0.36);
    return p.detach();
  }, [s]);
  // вырез халата — треугольник рубашки; вырез костюма медсестры — линия; стетоскоп — трубка на шее
  const vee = useMemo(() => {
    const p = Skia.PathBuilder.Make();
    p.moveTo(s * 0.4, s * 0.74).lineTo(s * 0.5, s * 0.92).lineTo(s * 0.6, s * 0.74).close();
    return p.detach();
  }, [s]);
  const neckline = useMemo(() => {
    const p = Skia.PathBuilder.Make();
    p.moveTo(s * 0.42, s * 0.745).lineTo(s * 0.5, s * 0.84).lineTo(s * 0.58, s * 0.745);
    return p.detach();
  }, [s]);
  const tube = useMemo(() => {
    const p = Skia.PathBuilder.Make();
    p.moveTo(s * 0.38, s * 0.75).quadTo(s * 0.5, s * 1.02, s * 0.62, s * 0.75);
    return p.detach();
  }, [s]);
  const [coat, edge] = uniform ? COAT[uniform] : [look.clothes, undefined];

  return (
    <Canvas style={{ width: s, height: s }} __destroyWebGLContextAfterRender={still}>
      <Circle cx={s / 2} cy={s / 2} r={s / 2} color={look.bg} />
      <Group>
        {/* длинные волосы за головой */}
        {look.long && <RoundedRect x={s * 0.26} y={s * 0.22} width={s * 0.48} height={s * 0.5} r={s * 0.2} color={look.hair} />}
        {/* плечи и шея; у сотрудника — форма с кромкой: белый халат на светлом фоне иначе не видно */}
        <RoundedRect x={s * 0.14} y={s * 0.74} width={s * 0.72} height={s * 0.4} r={s * 0.2} color={coat} />
        {edge && <RoundedRect x={s * 0.14} y={s * 0.74} width={s * 0.72} height={s * 0.4} r={s * 0.2} style="stroke" strokeWidth={s * 0.015} color={edge} />}
        {uniform === 'doctor' && <Path path={vee} color={look.clothes} />}
        <Rect x={s * 0.43} y={s * 0.62} width={s * 0.14} height={s * 0.14} color={look.skin} />
        {uniform === 'nurse' && <Path path={neckline} style="stroke" strokeWidth={s * 0.015} color={edge} />}
        {uniform === 'doctor' && (
          <Group>
            <Path path={tube} style="stroke" strokeWidth={s * 0.025} color="#3E4B4F" />
            <Circle cx={s * 0.58} cy={s * 0.83} r={s * 0.035} color="#8FA3A8" />
          </Group>
        )}
        {uniform === 'staff' && <RoundedRect x={s * 0.6} y={s * 0.84} width={s * 0.1} height={s * 0.05} r={s * 0.01} color="#FFFFFF" />}
        {/* лицо */}
        <Oval x={s * 0.3} y={s * 0.2} width={s * 0.4} height={s * 0.5} color={look.skin} />
        {/* волосы сверху; у медсестры шапочка их закрывает */}
        {uniform === 'nurse' ? (
          <Group>
            <RoundedRect x={s * 0.29} y={s * 0.12} width={s * 0.42} height={s * 0.16} r={s * 0.06} color="#FFFFFF" />
            <RoundedRect x={s * 0.29} y={s * 0.12} width={s * 0.42} height={s * 0.16} r={s * 0.06} style="stroke" strokeWidth={s * 0.012} color={CAP_EDGE} />
          </Group>
        ) : !look.bald && <Oval x={s * 0.28} y={s * 0.15} width={s * 0.44} height={s * 0.2} color={look.hair} />}
        {look.beard && <Oval x={s * 0.34} y={s * 0.56} width={s * 0.32} height={s * 0.16} color={look.hair} opacity={0.85} />}
        {/* глаза и рот */}
        <Circle cx={s * 0.43} cy={s * 0.44} r={s * 0.022} color="#2B2B2B" />
        <Circle cx={s * 0.57} cy={s * 0.44} r={s * 0.022} color="#2B2B2B" />
        <Path path={smile} style="stroke" strokeWidth={s * 0.02} color="#8A4B3B" />
        {look.wrinkles && <Path path={wrinkle} style="stroke" strokeWidth={s * 0.01} color="#A07A60" opacity={0.6} />}
        {look.glasses && (
          <Group>
            <Circle cx={s * 0.43} cy={s * 0.44} r={s * 0.055} style="stroke" strokeWidth={s * 0.015} color="#333" />
            <Circle cx={s * 0.57} cy={s * 0.44} r={s * 0.055} style="stroke" strokeWidth={s * 0.015} color="#333" />
          </Group>
        )}
      </Group>
    </Canvas>
  );
}
