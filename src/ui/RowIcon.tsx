// Значок строки карты пациента (0.6.8, вопрос 49): рисунок — itemIcons.ts, кружок, цвет и «?» — rowIconArt.ts. Картинкой:
// на вебе — SVG, на телефоне — PNG, нарисованная Skia; одна на значок, состояние, тему и размер.
import { memo } from 'react';
import { Image, PixelRatio, Platform } from 'react-native';
import { iconShape, type ItemIcon } from './itemIcons';
import { rowIconPng, rowIconSvg, type RowState } from './rowIconArt';
import { useTheme } from './theme';

export type { RowState } from './rowIconArt';

const WEB = Platform.OS === 'web';
const uris = new Map<string, string>();

/** Значок строки: `icon` — рисунок, `state` — что известно; `testID` — для сценария в браузере (`ic-present` и др.). */
export const RowIcon = memo(function RowIcon({ icon, state, size = 22, testID }: { icon: ItemIcon; state: RowState; size?: number; testID?: string }) {
  const t = useTheme();
  // на телефоне — в точках экрана, чтобы не мылилось
  const px = WEB ? 0 : Math.ceil(size * PixelRatio.get());
  const key = `${icon}|${state}|${t.name}|${px}`;
  let uri = uris.get(key);
  if (!uri) {
    uri = WEB ? rowIconSvg(iconShape(icon), state, t.colors) : rowIconPng(iconShape(icon), state, t.colors, px);
    uris.set(key, uri);
  }
  return <Image testID={testID} source={{ uri }} style={{ width: size, height: size }} fadeDuration={0} aria-hidden />;
});
