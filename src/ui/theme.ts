// Вид игры (spec 2026-09-own-look, ADR 0017): две темы — светлая «Медкарта» и тёмный
// «Монитор» (palette.ts). Какая сейчас — выбор в настройках или тема телефона. Экраны берут
// цвета и шрифты из темы на сейчас (useTheme), а стили — через makeStyles: лист стилей на
// тему собирается один раз. Срочность — цветом **и** словом со значком: цвет один не
// различают не все.
import { StyleSheet, useColorScheme } from 'react-native';
import { useSettings } from '@/state/settings';
import { type Theme, type ThemeName, themeOf } from './palette';

export { DARK, type Fonts, LIGHT, type Palette, type Theme, type ThemeName, THEMES, themeOf } from './palette';

export function useTheme(): Theme {
  const scheme = useColorScheme();
  return themeOf(useSettings().theme, scheme);
}

/**
 * Стили по теме: `build` получает тему, лист собирается один раз на тему и хранится.
 * Компонент берёт свои стили хуком: `const styles = useStyles()`.
 */
export function makeStyles<T extends StyleSheet.NamedStyles<T>>(build: (t: Theme) => T): () => T {
  const sheets: Partial<Record<ThemeName, T>> = {};
  return function useStyles() {
    const t = useTheme();
    const done = sheets[t.name];
    if (done) return done;
    const made = StyleSheet.create(build(t));
    sheets[t.name] = made;
    return made;
  };
}

export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24 };
/** не меньше 48 dp — NFR-ACC-1 */
export const touch = 48;
