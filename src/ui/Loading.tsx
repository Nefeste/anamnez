// Экран загрузки (spec 2026-10-premium-polish): название игры и кривая ЭКГ, по которой бежит отрезок, — вместо пустого
// экрана, пока читаются сохранения, партия или считается разбор. Цвета и шрифт — из темы; при «уменьшить движение» в
// телефоне отрезок не бежит — кривая целиком.
import { useEffect } from 'react';
import { View } from 'react-native';
import { cancelAnimation, Easing, useDerivedValue, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { T } from '@/i18n';
import { EcgLine } from '@/render/EcgLine';
import { Screen } from './components';
import { Text } from './text';
import { makeStyles, space, useTheme } from './theme';

/** Длина бегущего отрезка — доля кривой; один пробег — столько миллисекунд. */
const TAIL = 0.42;
const SWEEP_MS = 1500;
const WIDTH = 220;
const HEIGHT = 56;

/**
 * `caption` — что происходит («Открываем амбулаторию…»); без него — «Загружаем…». `bare` — без шапки (меню до прочтения
 * сохранений); иначе — в экране с шапкой стека, как остальное.
 */
export function Loading({ caption, bare, testID }: { caption?: string; bare?: boolean; testID?: string }) {
  const styles = useStyles();
  const t = useTheme();
  const reduced = useReducedMotion();
  const end = useSharedValue(reduced ? 1 : 0);
  // хвост отрезка — отстаёт от головы; при неподвижной кривой — с начала
  const start = useDerivedValue(() => (reduced ? 0 : Math.max(0, end.value - TAIL)));
  useEffect(() => {
    if (reduced) {
      end.set(1);
      return;
    }
    end.set(withRepeat(withTiming(1 + TAIL, { duration: SWEEP_MS, easing: Easing.linear }), -1, false));
    return () => cancelAnimation(end);
  }, [reduced, end]);
  const text = caption ?? T.common.loading;
  return (
    <Screen bare={bare} scroll={false}>
      <View style={styles.box} accessible accessibilityRole="progressbar" accessibilityLabel={`${T.common.loadingLabel}: ${text}`}>
        <Text style={styles.title}>{T.common.appName.toUpperCase()}</Text>
        <View style={styles.line}>
          {/* кривая целиком — едва видна, по ней бежит яркий отрезок */}
          <View style={styles.ghost}>
            <EcgLine width={WIDTH} height={HEIGHT} color={t.colors.line} />
          </View>
          <EcgLine width={WIDTH} height={HEIGHT} color={t.colors.accent} start={start} end={end} strokeWidth={2.5} />
        </View>
        <Text testID={testID} style={styles.caption}>{text}</Text>
      </View>
    </Screen>
  );
}

const useStyles = makeStyles(t => ({
  box: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.m, padding: space.xl },
  title: { fontFamily: t.fonts.title, fontSize: 26, lineHeight: 32, fontWeight: '700', letterSpacing: t.shape.ruled ? 4 : 6, color: t.colors.ink, textAlign: 'center' },
  line: { width: WIDTH, height: HEIGHT },
  ghost: { position: 'absolute', left: 0, top: 0 },
  caption: { fontSize: 14, lineHeight: 20, color: t.colors.muted, textAlign: 'center' },
}));
