// Страница загрузки — только у веб-сборки (splash.web.ts). На телефоне экран запуска системный — в цветах темы
// (app.json, плагин expo-splash-screen, часть 104, spec 2026-10-publish-ready): он уходит сам, когда игра готова, —
// плавно, за 300 мс, а не обрывом.
import * as SplashScreen from 'expo-splash-screen';

SplashScreen.setOptions({ duration: 300, fade: true });

export function splashStage(_stage: 1 | 2 | 3): void {}
export function hideSplash(): void {}
