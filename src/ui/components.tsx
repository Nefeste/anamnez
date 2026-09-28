// Общие элементы интерфейса. Без системного Alert: в веб-сборке он не работает (AGENTS.md).
import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Switch, View, type ViewStyle } from 'react-native';
import { Text } from './text';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, space, touch } from './theme';

/**
 * Экран с прокруткой. Смена `resetKey` возвращает прокрутку наверх (новый пациент).
 * `footer` — полоса внизу поверх прокрутки: главная кнопка экрана всегда под большим
 * пальцем, а не в конце длинного списка. `header` — закреплён сверху (карта смены).
 */
export function Screen({ children, scroll = true, resetKey, footer, header }: { children: ReactNode; scroll?: boolean; resetKey?: string | number; footer?: ReactNode; header?: ReactNode }) {
  return (
    <SafeAreaView style={styles.screen} edges={['bottom', 'left', 'right']}>
      {header ? <View style={styles.header}>{header}</View> : null}
      {scroll ? <ScrollView key={resetKey} contentContainerStyle={styles.content}>{children}</ScrollView> : <View style={styles.fill}>{children}</View>}
      {footer ? <View style={styles.footer}><View style={styles.footerInner}>{footer}</View></View> : null}
    </SafeAreaView>
  );
}

export function Card({ children, style, testID }: { children: ReactNode; style?: ViewStyle; testID?: string }) {
  return <View testID={testID} style={[styles.card, style]}>{children}</View>;
}

export function H({ children }: { children: ReactNode }) {
  return <Text style={styles.h}>{children}</Text>;
}

export function P({ children, muted, testID }: { children: ReactNode; muted?: boolean; testID?: string }) {
  return <Text testID={testID} style={[styles.p, muted && styles.muted]}>{children}</Text>;
}

/** Кнопка; `onInfo` добавляет справа «?» — справку «Что это?» (нажимается отдельно). */
export function Button({ title, onPress, hint, kind = 'primary', disabled, testID, onInfo, infoLabel }: {
  title: string; onPress: () => void; hint?: string; kind?: 'primary' | 'plain'; disabled?: boolean; testID?: string;
  onInfo?: () => void; infoLabel?: string;
}) {
  return (
    <View style={styles.btnRow}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [styles.btn, styles.fill, kind === 'plain' && styles.btnPlain, disabled && styles.btnDisabled, pressed && styles.btnPressed]}>
        <Text style={[styles.btnText, kind === 'plain' && styles.btnTextPlain]}>{title}</Text>
        {hint ? <Text style={[styles.btnHint, kind === 'plain' && styles.muted]}>{hint}</Text> : null}
      </Pressable>
      {onInfo ? (
        <Pressable
          testID={testID ? `${testID}-info` : undefined}
          accessibilityRole="button"
          accessibilityLabel={infoLabel}
          hitSlop={8}
          onPress={onInfo}
          style={({ pressed }) => [styles.info, pressed && styles.btnPressed]}>
          <Text style={styles.infoText}>?</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

type SheetProps = { visible: boolean; onClose: () => void; closeTitle: string; children: ReactNode; testID?: string };

/**
 * Карточка поверх экрана: закрывается кнопкой, касанием фона и «назад» Android.
 * Modal — отдельное окно, и системные отступы главного экрана на него не действуют:
 * без своего SafeAreaProvider кнопка уходила под панель навигации Android (отзыв на 0.0.2).
 * Не помещается — содержимое прокручивается, а кнопка остаётся внизу: на экране 360 × 640
 * верх длинного листа (выбор помещения — девять типов) уходил за край, и выбрать первые
 * типы было нельзя.
 */
export function Sheet({ visible, onClose, closeTitle, children, testID }: SheetProps) {
  return (
    <Modal visible={visible} transparent animationType="slide" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      <SafeAreaProvider>
        <SheetBody visible={visible} onClose={onClose} closeTitle={closeTitle} testID={testID}>{children}</SheetBody>
      </SafeAreaProvider>
    </Modal>
  );
}

// Фон — отдельный слой под листом, а не его родитель: касание листа фон не закрывает, и
// прокрутке листа ничто не мешает.
function SheetBody({ onClose, closeTitle, children, testID }: SheetProps) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.backdrop, { paddingTop: space.xl + insets.top }]}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessible={false} />
      <View testID={testID} style={[styles.sheet, { paddingBottom: space.xl + insets.bottom }]}>
        <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
        <Button testID={testID ? `${testID}-close` : undefined} title={closeTitle} onPress={onClose} />
      </View>
    </View>
  );
}

/**
 * Вкладки одной полосой. Подпись всегда в одну строку: на узком экране или с крупным
 * системным шрифтом она уменьшается, а не обрезается многоточием (отзыв на 0.0.5).
 * Вкладка — 40 dp с полем полосы вокруг; касание добирает до 48 (NFR-ACC-1) полем сверху и
 * снизу, а не сбоку — иначе соседние вкладки делили бы щель между собой.
 */
const TAB_SLOP = { top: space.xs, bottom: space.xs };

export function Tabs<K extends string>({ items, value, onChange, testPrefix = 'tab' }: { items: { key: K; title: string }[]; value: K; onChange: (k: K) => void; testPrefix?: string }) {
  return (
    <View style={styles.tabs} accessibilityRole="tablist">
      {items.map(({ key, title }) => {
        const on = key === value;
        return (
          <Pressable
            key={key}
            testID={`${testPrefix}-${key}`}
            accessibilityRole="tab"
            aria-selected={on}
            hitSlop={TAB_SLOP}
            onPress={() => onChange(key)}
            style={({ pressed }) => [styles.tab, on && styles.tabOn, pressed && styles.btnPressed]}>
            <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={[styles.tabText, on && styles.tabTextOn]}>{title}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Строка «вкл / выкл». Касание — по всей строке; переключатель только показывает
 * состояние: иначе в вебе касание самого переключателя срабатывало бы дважды.
 */
export function Toggle({ title, hint, value, onChange, testID }: { title: string; hint?: string; value: boolean; onChange: (v: boolean) => void; testID?: string }) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      aria-checked={value}
      onPress={() => onChange(!value)}
      style={({ pressed }) => [styles.toggle, pressed && styles.btnPressed]}>
      <View style={styles.fill}>
        <Text style={styles.p}>{title}</Text>
        {hint ? <Text style={[styles.toggleHint, styles.muted]}>{hint}</Text> : null}
      </View>
      {/* переключатель только показывает состояние: для чтения с экрана строка — один элемент */}
      <View style={styles.inert} aria-hidden importantForAccessibility="no-hide-descendants">
        <Switch value={value} trackColor={{ false: colors.line, true: colors.accent }} thumbColor={colors.card} />
      </View>
    </Pressable>
  );
}

/** Ряд плашек с переносом; длинная плашка переносит текст, а не вылезает за край. */
export function Chips({ children }: { children: ReactNode }) {
  return <View style={styles.chips}>{children}</View>;
}

export function Chip({ text, strong, onPress, testID }: { text: string; strong?: boolean; onPress?: () => void; testID?: string }) {
  return (
    <Pressable testID={testID} onPress={onPress} disabled={!onPress} style={({ pressed }) => [styles.chip, strong ? styles.chipStrong : styles.chipWeak, pressed && styles.btnPressed]}>
      <Text style={[styles.chipText, !strong && styles.muted]}>{text}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  fill: { flex: 1 },
  content: { padding: space.l, gap: space.m, maxWidth: 640, width: '100%', alignSelf: 'center' },
  header: { alignItems: 'center', borderBottomWidth: 1, borderBottomColor: colors.line, backgroundColor: colors.card },
  footer: { borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.card },
  footerInner: { paddingHorizontal: space.l, paddingVertical: space.s, gap: space.s, maxWidth: 640, width: '100%', alignSelf: 'center' },
  card: { backgroundColor: colors.card, borderRadius: radius, padding: space.l, gap: space.s, borderWidth: 1, borderColor: colors.line },
  h: { fontSize: 18, fontWeight: '700', color: colors.ink },
  p: { fontSize: 15, lineHeight: 21, color: colors.ink },
  muted: { color: colors.muted },
  btn: { minHeight: touch, backgroundColor: colors.accent, borderRadius: radius, paddingHorizontal: space.l, paddingVertical: space.m, justifyContent: 'center' },
  btnPlain: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  btnDisabled: { opacity: 0.45 },
  btnPressed: { opacity: 0.8 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  btnTextPlain: { color: colors.ink },
  btnHint: { color: '#E4F4F2', fontSize: 13, marginTop: 2 },
  btnRow: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  info: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' },
  infoText: { fontSize: 17, fontWeight: '700', color: colors.accent },
  backdrop: { flex: 1, backgroundColor: 'rgba(12,24,26,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: space.xl, gap: space.m, maxWidth: 640, width: '100%', alignSelf: 'center', flexShrink: 1 },
  sheetScroll: { flexGrow: 0, flexShrink: 1 },
  sheetContent: { gap: space.m },
  tabs: { flexDirection: 'row', backgroundColor: colors.card, borderRadius: radius, borderWidth: 1, borderColor: colors.line, padding: space.xs, gap: space.xs },
  tab: { flex: 1, minHeight: touch - 2 * space.xs, borderRadius: radius - space.xs, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.xs },
  tabOn: { backgroundColor: colors.accent },
  tabText: { fontSize: 15, fontWeight: '600', color: colors.ink },
  tabTextOn: { color: '#fff' },
  toggle: { minHeight: touch, flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: space.xs },
  toggleHint: { fontSize: 13, marginTop: 2 },
  inert: { pointerEvents: 'none' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  chip: { maxWidth: '100%', borderRadius: 16, paddingHorizontal: space.m, paddingVertical: 6 },
  chipStrong: { backgroundColor: colors.accentSoft },
  chipWeak: { backgroundColor: '#EEF1F1' },
  chipText: { fontSize: 14, color: colors.ink },
});
