// Общие элементы интерфейса. Без системного Alert: в веб-сборке он не работает (AGENTS.md).
// Вид — из темы (spec 2026-09-own-look): в «Медкарте» главная кнопка — оттиск штампа с
// рамкой внутри, листы — бумага, вкладки действий — закладки картотеки; в «Мониторе» — панели
// и зелёная кнопка.
import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { Text } from './text';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { makeStyles, space, touch, useTheme } from './theme';

/**
 * Экран с прокруткой. Смена `resetKey` возвращает прокрутку наверх (новый пациент).
 * `footer` — полоса внизу поверх прокрутки: главная кнопка экрана всегда под большим
 * пальцем, а не в конце длинного списка. `header` — закреплён сверху (карта смены).
 */
export function Screen({ children, scroll = true, resetKey, footer, header }: { children: ReactNode; scroll?: boolean; resetKey?: string | number; footer?: ReactNode; header?: ReactNode }) {
  const styles = useStyles();
  return (
    <SafeAreaView style={styles.screen} edges={['bottom', 'left', 'right']}>
      <Rule />
      {header ? <View style={styles.header}>{header}</View> : null}
      {scroll ? <ScrollView key={resetKey} contentContainerStyle={styles.content}>{children}</ScrollView> : <View style={styles.fill}>{children}</View>}
      {footer ? <View style={styles.footer}><View style={styles.footerInner}>{footer}</View></View> : null}
    </SafeAreaView>
  );
}

/** Черта под шапкой: в «Медкарте» — двойная, как на бланке; в «Мониторе» — тонкая линия. */
function Rule() {
  const styles = useStyles();
  const t = useTheme();
  if (!t.shape.doubleRule) return <View style={styles.line} />;
  return (
    <View style={styles.rule}>
      <View style={styles.ruleThick} />
      <View style={styles.ruleThin} />
    </View>
  );
}

export function Card({ children, style, testID }: { children: ReactNode; style?: ViewStyle; testID?: string }) {
  const styles = useStyles();
  return <View testID={testID} style={[styles.card, style]}>{children}</View>;
}

export function H({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <Text style={styles.h}>{children}</Text>;
}

export function P({ children, muted, testID }: { children: ReactNode; muted?: boolean; testID?: string }) {
  const styles = useStyles();
  return <Text testID={testID} style={[styles.p, muted && styles.muted]}>{children}</Text>;
}

/**
 * Кнопка; `onInfo` добавляет справа «?» — справку «Что это?» (нажимается отдельно). `lamp` —
 * лампа вызова перед подписью, как над дверями на плане: у «Пригласить».
 */
export function Button({ title, onPress, hint, kind = 'primary', disabled, testID, onInfo, infoLabel, lamp }: {
  title: string; onPress: () => void; hint?: string; kind?: 'primary' | 'plain'; disabled?: boolean; testID?: string;
  onInfo?: () => void; infoLabel?: string; lamp?: boolean;
}) {
  const styles = useStyles();
  const t = useTheme();
  const primary = kind === 'primary';
  return (
    <View style={styles.btnRow}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [styles.btn, styles.fill, !primary && styles.btnPlain, disabled && styles.btnDisabled, pressed && styles.btnPressed]}>
        {/* оттиск штампа: тонкая светлая рамка внутри главной кнопки «Медкарты» */}
        {primary && t.shape.stamp ? <View style={styles.stamp} /> : null}
        {lamp ? (
          <View style={styles.lampRow}>
            <Lamp />
            <Text style={[styles.btnText, styles.fill, !primary && styles.btnTextPlain]}>{title}</Text>
          </View>
        ) : <Text style={[styles.btnText, !primary && styles.btnTextPlain]}>{title}</Text>}
        {hint ? <Text style={[styles.btnHint, !primary && styles.muted]}>{hint}</Text> : null}
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

/** Лампа вызова — жёлтая, не мигает: вид не торопит (spec 2026-09-own-look). */
export function Lamp() {
  const styles = useStyles();
  return <View style={styles.lamp} aria-hidden importantForAccessibility="no" />;
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
  const styles = useStyles();
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
 * снизу, а не сбоку — иначе соседние вкладки делили бы щель между собой. `folder` — закладки
 * картотеки над листом (действия карты пациента в «Медкарте»); остальное — переключатель.
 */
const TAB_SLOP = { top: space.xs, bottom: space.xs };

export function Tabs<K extends string>({ items, value, onChange, testPrefix = 'tab', folder }: { items: { key: K; title: string }[]; value: K; onChange: (k: K) => void; testPrefix?: string; folder?: boolean }) {
  const styles = useStyles();
  const t = useTheme();
  const tabbed = folder && t.shape.folderTabs;
  return (
    <View style={tabbed ? styles.folders : styles.tabs} accessibilityRole="tablist">
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
            style={({ pressed }) => (tabbed ? [styles.folder, on && styles.folderOn, pressed && styles.btnPressed] : [styles.tab, on && styles.tabOn, pressed && styles.btnPressed])}>
            <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={[styles.tabText, on && (tabbed ? styles.folderTextOn : styles.tabTextOn)]}>{title}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Строка «вкл / выкл». Касание — по всей строке; переключатель только показывает
 * состояние: иначе в вебе касание самого переключателя срабатывало бы дважды. Рисуется сам,
 * цветами темы: системный в вебе красил бегунок своим бирюзовым.
 */
export function Toggle({ title, hint, value, onChange, testID }: { title: string; hint?: string; value: boolean; onChange: (v: boolean) => void; testID?: string }) {
  const styles = useStyles();
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
        <View style={[styles.track, value && styles.trackOn]}>
          <View style={[styles.knob, value && styles.knobOn]} />
        </View>
      </View>
    </Pressable>
  );
}

/** Выбор одного из нескольких — строками с кружком: подпись и пояснение не обрезаются, как на узкой вкладке. */
export function Choice<K extends string>({ items, value, onChange, testPrefix }: { items: { key: K; title: string; hint?: string }[]; value: K; onChange: (k: K) => void; testPrefix: string }) {
  const styles = useStyles();
  return (
    <View accessibilityRole="radiogroup">
      {items.map(({ key, title, hint }) => {
        const on = key === value;
        return (
          <Pressable
            key={key}
            testID={`${testPrefix}-${key}`}
            accessibilityRole="radio"
            aria-checked={on}
            onPress={() => onChange(key)}
            style={({ pressed }) => [styles.toggle, pressed && styles.btnPressed]}>
            <View style={[styles.radio, on && styles.radioOn]}>{on ? <View style={styles.radioDot} /> : null}</View>
            <View style={styles.fill}>
              <Text style={styles.p}>{title}</Text>
              {hint ? <Text style={[styles.toggleHint, styles.muted]}>{hint}</Text> : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Ряд плашек с переносом; длинная плашка переносит текст, а не вылезает за край. */
export function Chips({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <View style={styles.chips}>{children}</View>;
}

export function Chip({ text, strong, onPress, testID }: { text: string; strong?: boolean; onPress?: () => void; testID?: string }) {
  const styles = useStyles();
  return (
    <Pressable testID={testID} onPress={onPress} disabled={!onPress} style={({ pressed }) => [styles.chip, strong ? styles.chipStrong : styles.chipWeak, pressed && styles.btnPressed]}>
      <Text style={[styles.chipText, !strong && styles.muted]}>{text}</Text>
    </Pressable>
  );
}

const useStyles = makeStyles(t => ({
  screen: { flex: 1, backgroundColor: t.colors.bg },
  fill: { flex: 1 },
  content: { padding: space.l, gap: space.m, maxWidth: 640, width: '100%', alignSelf: 'center' },
  line: { height: 1, backgroundColor: t.colors.line },
  rule: { gap: 2, backgroundColor: t.colors.card, paddingBottom: 1 },
  ruleThick: { height: 2, backgroundColor: t.colors.accent, opacity: 0.55 },
  ruleThin: { height: 1, backgroundColor: t.colors.accent, opacity: 0.55 },
  header: { alignItems: 'center', borderBottomWidth: 1, borderBottomColor: t.colors.line, backgroundColor: t.colors.card },
  footer: { borderTopWidth: 1, borderTopColor: t.colors.edge, backgroundColor: t.colors.bg },
  footerInner: { paddingHorizontal: space.l, paddingVertical: space.s, gap: space.s, maxWidth: 640, width: '100%', alignSelf: 'center' },
  card: { backgroundColor: t.colors.card, borderRadius: t.shape.card, padding: space.l, gap: space.s, borderWidth: 1, borderColor: t.colors.edge },
  h: { fontFamily: t.fonts.title, fontSize: 19, fontWeight: '700', color: t.colors.ink },
  p: { fontSize: 15, lineHeight: 21, color: t.colors.ink },
  muted: { color: t.colors.muted },
  btn: { minHeight: touch, backgroundColor: t.colors.accent, borderRadius: t.shape.radius, paddingHorizontal: space.l, paddingVertical: space.m, justifyContent: 'center' },
  stamp: { position: 'absolute', top: 3, right: 3, bottom: 3, left: 3, pointerEvents: 'none', borderWidth: 1, borderColor: t.colors.onAccentHint, borderRadius: Math.max(0, t.shape.radius - 2) },
  btnPlain: { backgroundColor: t.colors.card, borderWidth: 1.5, borderColor: t.shape.stamp ? t.colors.accent : t.colors.edge },
  btnDisabled: { opacity: 0.45 },
  btnPressed: { opacity: 0.8 },
  btnText: { color: t.colors.onAccent, fontSize: 16, fontWeight: '700' },
  btnTextPlain: { color: t.colors.ink },
  btnHint: { color: t.colors.onAccentHint, fontSize: 13, marginTop: 2 },
  btnRow: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  lampRow: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  lamp: { width: 14, height: 14, borderRadius: 7, backgroundColor: t.colors.lamp, borderWidth: 2, borderColor: t.colors.onAccent },
  info: { width: 36, height: 36, borderRadius: 18, borderWidth: 1.5, borderColor: t.colors.info, backgroundColor: t.colors.card, alignItems: 'center', justifyContent: 'center' },
  infoText: { fontFamily: t.fonts.title, fontSize: 17, fontWeight: '700', color: t.colors.info },
  backdrop: { flex: 1, backgroundColor: t.colors.backdrop, justifyContent: 'flex-end' },
  sheet: { backgroundColor: t.colors.card, borderTopLeftRadius: t.shape.stamp ? 8 : 20, borderTopRightRadius: t.shape.stamp ? 8 : 20, padding: space.xl, gap: space.m, maxWidth: 640, width: '100%', alignSelf: 'center', flexShrink: 1 },
  sheetScroll: { flexGrow: 0, flexShrink: 1 },
  sheetContent: { gap: space.m },
  // переключатель: «Медкарта» — рамка чернилами, «Монитор» — панель
  tabs: t.shape.stamp
    ? { flexDirection: 'row', borderRadius: t.shape.radius, borderWidth: 1.5, borderColor: t.colors.accent, backgroundColor: t.colors.card, padding: 2, gap: 2 }
    : { flexDirection: 'row', backgroundColor: t.colors.card, borderRadius: t.shape.radius, borderWidth: 1, borderColor: t.colors.edge, padding: space.xs, gap: space.xs },
  tab: { flex: 1, minHeight: touch - 2 * space.xs, borderRadius: Math.max(2, t.shape.radius - space.xs), alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.xs },
  tabOn: { backgroundColor: t.colors.accent },
  tabText: { fontSize: 15, fontWeight: '700', color: t.shape.stamp ? t.colors.accent : t.colors.muted },
  tabTextOn: { color: t.colors.onAccent },
  // закладки картотеки: выбранная — цвета листа и сливается с ним
  folders: { flexDirection: 'row', gap: space.xs, paddingHorizontal: space.xs, marginBottom: -space.m - 1, zIndex: 1 },
  folder: { flex: 1, minHeight: touch - space.s, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.xs, borderTopLeftRadius: 8, borderTopRightRadius: 8, borderWidth: 1, borderBottomWidth: 0, borderColor: t.colors.edge, backgroundColor: t.colors.chip },
  folderOn: { backgroundColor: t.colors.card, paddingBottom: 1 },
  folderTextOn: { color: t.colors.accent },
  toggle: { minHeight: touch, flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: space.xs },
  toggleHint: { fontSize: 13, marginTop: 2 },
  inert: { pointerEvents: 'none' },
  track: { width: 44, height: 26, borderRadius: 13, padding: 3, backgroundColor: t.colors.muted },
  trackOn: { backgroundColor: t.colors.accent },
  knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: t.colors.card },
  knobOn: { marginLeft: 18 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: t.colors.muted, alignItems: 'center', justifyContent: 'center' },
  radioOn: { borderColor: t.colors.accent },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: t.colors.accent },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  chip: { maxWidth: '100%', borderRadius: t.shape.stamp ? 4 : 16, paddingHorizontal: space.m, paddingVertical: 6 },
  chipStrong: { backgroundColor: t.colors.accentSoft },
  chipWeak: { backgroundColor: t.colors.chip },
  chipText: { fontSize: 14, color: t.colors.ink },
}));
