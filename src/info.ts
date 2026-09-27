// Версия игры и адреса разработчика — одно место для меню и экрана «Об игре». Тексты
// магазина и сайта (store/) сверяет с адресами тест store.test.ts. Имя разработчика — текст,
// оно в словаре (T.about).
import app from '../app.json';

/**
 * Версия — из app.json, из которого собран этот бандл; на телефоне она же — versionName.
 * Не из expo-constants: в веб-сборке манифест вклеивается через кэш Metro и отставал на
 * несколько версий.
 */
export const VERSION: string = app.expo.version;

export const SITE_URL = 'https://gornitsa.games';
export const SUPPORT_EMAIL = 'support@gornitsa.games';
export const PRIVACY_URL = 'https://gornitsa.games/anamnez/privacy';
