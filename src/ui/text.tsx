// Текст игры — с размером из настроек (03-game-design.md §12, «размер текста»): шрифт и
// межстрочный множатся на ступень. Системный размер шрифта Android действует поверх. Текст
// без своего размера не трогаем — вложенный наследует размер родителя. Подписи на карте
// (render/map) берут размер клетки и не масштабируются.
import { Text as RNText, TextInput as RNTextInput, type StyleProp, StyleSheet, type TextInputProps, type TextProps, type TextStyle } from 'react-native';
import { useSettings } from '@/state/settings';

function scaled(style: StyleProp<TextStyle>, k: number): StyleProp<TextStyle> {
  if (k === 1) return style;
  const f = StyleSheet.flatten(style);
  if (!f || typeof f.fontSize !== 'number') return style;
  return [style, { fontSize: f.fontSize * k, ...(typeof f.lineHeight === 'number' ? { lineHeight: f.lineHeight * k } : {}) }];
}

export function Text(props: TextProps) {
  const k = useSettings().textScale;
  return <RNText {...props} style={scaled(props.style, k)} />;
}

export function TextInput(props: TextInputProps) {
  const k = useSettings().textScale;
  return <RNTextInput {...props} style={scaled(props.style, k)} />;
}
