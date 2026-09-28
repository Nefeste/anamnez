// Текст игры — с размером из настроек (03-game-design.md §12, «размер текста»): шрифт и
// межстрочный множатся на ступень. Системный размер шрифта Android действует поверх. Текст
// без своего размера не трогаем — вложенный наследует размер родителя. Шрифт — из темы
// (spec 2026-09-own-look): свой у текста — его; вложенный текст наследует шрифт родителя —
// часы в заголовке набраны шрифтом заголовка. Подписи на карте (render/map) берут размер
// клетки и не масштабируются.
import { createContext, useContext } from 'react';
import { Text as RNText, TextInput as RNTextInput, type StyleProp, StyleSheet, type TextInputProps, type TextProps, type TextStyle } from 'react-native';
import { useSettings } from '@/state/settings';
import { useTheme } from './theme';

function scaled(style: StyleProp<TextStyle>, k: number): StyleProp<TextStyle> {
  if (k === 1) return style;
  const f = StyleSheet.flatten(style);
  if (!f || typeof f.fontSize !== 'number') return style;
  return [style, { fontSize: f.fontSize * k, ...(typeof f.lineHeight === 'number' ? { lineHeight: f.lineHeight * k } : {}) }];
}

/** Текст внутри текста: шрифт темы ставит только внешний. */
const Nested = createContext(false);

export function Text(props: TextProps) {
  const k = useSettings().textScale;
  const t = useTheme();
  const nested = useContext(Nested);
  return (
    <Nested value>
      <RNText {...props} style={scaled(nested ? props.style : [{ fontFamily: t.fonts.body }, props.style], k)} />
    </Nested>
  );
}

export function TextInput(props: TextInputProps) {
  const k = useSettings().textScale;
  const t = useTheme();
  return <RNTextInput placeholderTextColor={t.colors.muted} {...props} style={scaled([{ fontFamily: t.fonts.body, color: t.colors.ink }, props.style], k)} />;
}
