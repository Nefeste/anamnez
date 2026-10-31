// Точка входа веб-сборки (стенд для сценариев, ADR 0003). Skia в браузере — это CanvasKit
// (WASM), а модуль Skia в вебе создаёт свой API при первом выполнении. Поэтому сначала
// загружается CanvasKit, и только потом выполняется роутер со всеми экранами: `require`
// внутри then() — Metro кладёт модуль в тот же бандл, но выполняет его в момент вызова
// (асинхронный import() разбивал бандл и ломал нумерацию модулей).
// Страница загрузки (public/index.html) видит ход ступенями: код выполняется, CanvasKit готов (spec 2026-10-premium-polish).
import { LoadSkiaWeb } from '@shopify/react-native-skia/lib/module/web';
import { splashStage } from './src/ui/splash';

splashStage(1);
LoadSkiaWeb({ locateFile: (file: string) => `/${file}` }).then(() => {
  splashStage(2);
  require('expo-router/entry');
});
