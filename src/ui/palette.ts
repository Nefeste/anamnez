// Две темы вида (spec 2026-09-own-look, ADR 0017): светлая «Медкарта» — бумага, синие
// чернила, линовка — и тёмный «Монитор» — цвета прикроватного монитора. Только данные, без
// React Native: их проверяют тесты контраста в Bun. Экраны берут тему через useTheme
// (theme.ts).
import type { ThemeChoice } from '@/state/settings';

export type ThemeName = 'light' | 'dark';

export interface Palette {
  /** фон экрана */
  bg: string;
  /** лист, карточка, шапка */
  card: string;
  /** край листа и кнопок-листов */
  edge: string;
  /** тонкие линии: разделители, линовка, рамки */
  line: string;
  ink: string;
  muted: string;
  /** главная кнопка и выбранное */
  accent: string;
  /** текст и подсказка на главной кнопке */
  onAccent: string;
  onAccentHint: string;
  /** мягкий фон выбранного: плашки жалоб */
  accentSoft: string;
  /** выделенное на плане больницы: кольцо у пациента, рамка помещения, призрак стройки. План
   * светлый в обеих темах, поэтому цвет тёмный и в «Мониторе» */
  mark: string;
  /** фон кольца у пациента на плане */
  markSoft: string;
  /** справка «?», время и минуты */
  info: string;
  /** срочность: красный — «срочно», жёлтый — «нужно скоро», зелёный — «в порядке очереди» */
  red: string;
  yellow: string;
  green: string;
  /** жёлтый для надписей: на светлом фоне обычный жёлтый бледен */
  yellowText: string;
  /** текст плашек на красном, жёлтом, зелёном */
  onRed: string;
  onYellow: string;
  onGreen: string;
  /** ошибка, противопоказание */
  danger: string;
  /** новое: фон и рамка */
  fresh: string;
  freshLine: string;
  /** слабая плашка: «без особенностей», неважное */
  chip: string;
  /** поле тетради у документов «Медкарты» — номера строк на поле */
  margin: string;
  /** лампа вызова у «Пригласить» — как над дверями на плане */
  lamp: string;
  /** затемнение под листом поверх экрана */
  backdrop: string;
}

export interface Fonts {
  /** заголовки и имена */
  title: string;
  body: string;
  /** часы, минуты, рубли */
  mono: string;
}

export interface Theme {
  name: ThemeName;
  colors: Palette;
  fonts: Fonts;
  shape: {
    /** радиус кнопок */
    radius: number;
    /** радиус листов и карточек */
    card: number;
    /** главная кнопка — оттиск штампа: тонкая светлая рамка внутри */
    stamp: boolean;
    /** вкладки — закладки картотеки, а не переключатель */
    folderTabs: boolean;
    /** под шапкой — двойная черта, как на бланке */
    doubleRule: boolean;
    /** у документов — линовка и поле красной линией */
    ruled: boolean;
  };
}

export const LIGHT: Theme = {
  name: 'light',
  colors: {
    bg: '#F3EEE3', card: '#FFFDF8', edge: '#D8D0BF', line: '#DCE3EA', ink: '#1F2D3D', muted: '#5E6A74',
    accent: '#2B4E8C', onAccent: '#FFFFFF', onAccentHint: '#DCE5F4', accentSoft: '#E6ECF6', mark: '#2B4E8C', markSoft: '#DCE5F4', info: '#2B4E8C',
    red: '#B8392F', yellow: '#D9A21B', green: '#2F7A40', yellowText: '#8A5A00', onRed: '#FFFFFF', onYellow: '#3B2A00', onGreen: '#FFFFFF', danger: '#B3261E',
    fresh: '#FFF6DE', freshLine: '#D9A21B', chip: '#EEE8DA', margin: '#C0766B', lamp: '#FFC94D', backdrop: 'rgba(31,45,61,0.45)',
  },
  fonts: { title: 'PT Serif', body: 'PT Sans', mono: 'PT Mono' },
  shape: { radius: 6, card: 3, stamp: true, folderTabs: true, doubleRule: true, ruled: true },
};

export const DARK: Theme = {
  name: 'dark',
  colors: {
    bg: '#0E1A1D', card: '#15262A', edge: '#26393E', line: '#26393E', ink: '#E4F1EE', muted: '#8DA4A1',
    accent: '#3DDC84', onAccent: '#052B1A', onAccentHint: '#0B4A2D', accentSoft: '#173A2E', mark: '#12804A', markSoft: '#CDEBDB', info: '#56C8E8',
    red: '#FF6B5E', yellow: '#F2C14E', green: '#3DDC84', yellowText: '#F2C14E', onRed: '#2A0703', onYellow: '#2A1F00', onGreen: '#052B1A', danger: '#FF6B5E',
    fresh: '#2C2A16', freshLine: '#F2C14E', chip: '#1C3035', margin: '#26393E', lamp: '#FFC94D', backdrop: 'rgba(0,0,0,0.6)',
  },
  fonts: { title: 'Golos Text', body: 'Golos Text', mono: 'JetBrains Mono' },
  shape: { radius: 12, card: 12, stamp: false, folderTabs: false, doubleRule: false, ruled: false },
};

export const THEMES: Record<ThemeName, Theme> = { light: LIGHT, dark: DARK };

/** Тема на сейчас: выбор в настройках; «как в телефоне» — по теме телефона, нет её — светлая. */
export function themeOf(choice: ThemeChoice, scheme: string | null | undefined): Theme {
  return THEMES[choice === 'system' ? (scheme === 'dark' ? 'dark' : 'light') : choice];
}
