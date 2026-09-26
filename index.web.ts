// Точка входа веб-сборки (стенд для сценариев, ADR 0003). Skia в браузере — это CanvasKit
// (WASM), а модуль Skia в вебе создаёт свой API при первом выполнении. Поэтому сначала
// загружается CanvasKit, и только потом выполняется роутер со всеми экранами: `require`
// внутри then() — Metro кладёт модуль в тот же бандл, но выполняет его в момент вызова
// (асинхронный import() разбивал бандл и ломал нумерацию модулей).
import { LoadSkiaWeb } from '@shopify/react-native-skia/lib/module/web';

LoadSkiaWeb({ locateFile: (file: string) => `/${file}` }).then(() => {
  require('expo-router/entry');
});
