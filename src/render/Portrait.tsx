// Портрет человека кодом из зерна (ADR 0013): лицо, возраст, волосы, очки, одежда.
import { Canvas, Circle, Group, Oval, Path, Rect, RoundedRect, Skia } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { lookOf } from './look';

export function Portrait({ seed, sex, age, size = 72 }: { seed: number; sex: 'm' | 'f'; age: number; size?: number }) {
  const look = useMemo(() => lookOf(seed, sex, age), [seed, sex, age]);

  const s = size;
  const smile = useMemo(() => {
    const p = Skia.Path.Make();
    p.moveTo(s * 0.42, s * 0.62);
    p.quadTo(s * 0.5, s * 0.66, s * 0.58, s * 0.62);
    return p;
  }, [s]);
  const wrinkle = useMemo(() => {
    const p = Skia.Path.Make();
    p.moveTo(s * 0.4, s * 0.36);
    p.lineTo(s * 0.6, s * 0.36);
    return p;
  }, [s]);

  return (
    <Canvas style={{ width: s, height: s }}>
      <Circle cx={s / 2} cy={s / 2} r={s / 2} color={look.bg} />
      <Group>
        {/* длинные волосы за головой */}
        {look.long && <RoundedRect x={s * 0.26} y={s * 0.22} width={s * 0.48} height={s * 0.5} r={s * 0.2} color={look.hair} />}
        {/* плечи и шея */}
        <RoundedRect x={s * 0.14} y={s * 0.74} width={s * 0.72} height={s * 0.4} r={s * 0.2} color={look.clothes} />
        <Rect x={s * 0.43} y={s * 0.62} width={s * 0.14} height={s * 0.14} color={look.skin} />
        {/* лицо */}
        <Oval x={s * 0.3} y={s * 0.2} width={s * 0.4} height={s * 0.5} color={look.skin} />
        {/* волосы сверху */}
        {!look.bald && <Oval x={s * 0.28} y={s * 0.15} width={s * 0.44} height={s * 0.2} color={look.hair} />}
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
