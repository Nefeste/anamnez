// Страница загрузки — только у веб-сборки (splash.web.ts); на телефоне экран запуска системный (app.json), и прятать
// нечего.
export function splashStage(_stage: 1 | 2 | 3): void {}
export function hideSplash(): void {}
