// Главное меню в виде темы (spec 2026-09-own-look, часть 25). «Медкарта» — обложка карты:
// «АНАМНЕЗ» прописными над двойной чертой, пункты — строки журнала на одном листе, номер на поле
// за красной линией. «Монитор» — название, под ним кривая ЭКГ, пункты — панели с полосой.
import { Pressable, useWindowDimensions, View } from 'react-native';
import { T } from '@/i18n';
import { EcgLine } from '@/render/EcgLine';
import { Text } from './text';
import { makeStyles, space, useTheme } from './theme';

export function Cover({ version }: { version: string }) {
  const styles = useStyles();
  const t = useTheme();
  const { width } = useWindowDimensions();
  const title = T.common.appName.toUpperCase();
  if (t.shape.ruled) {
    return (
      <View style={styles.cover}>
        <Text accessibilityRole="header" style={styles.coverTitle}>{title}</Text>
        <Text style={styles.coverTag}>{T.menu.tag}</Text>
        <View style={styles.rule}>
          <View style={styles.ruleThick} />
          <View style={styles.ruleThin} />
        </View>
        <Text style={styles.version}>{T.menu.versionLine(version)}</Text>
      </View>
    );
  }
  return (
    <View style={styles.monitor}>
      <Text accessibilityRole="header" style={styles.monitorTitle}>{title}</Text>
      <EcgLine width={Math.min(width, 640) - 2 * space.l} height={40} color={t.colors.accent} />
      <Text style={styles.monitorVersion}>{T.menu.subtitle(version)}</Text>
    </View>
  );
}

export type MenuItem = { testID: string; title: string; hint?: string; onPress: () => void };

/** Пункты меню: журнал на листе («Медкарта») или панели («Монитор»). */
export function MenuList({ items }: { items: MenuItem[] }) {
  const styles = useStyles();
  const t = useTheme();
  if (t.shape.ruled) {
    return (
      <View style={styles.journal}>
        {items.map((it, i) => (
          <Pressable key={it.testID} testID={it.testID} accessibilityRole="button" onPress={it.onPress}
            style={({ pressed }) => [styles.row, i > 0 && styles.rowLine, pressed && styles.pressed]}>
            {/* номер на поле — украшение: для чтения с экрана пункт — название и пояснение */}
            <View style={styles.margin} aria-hidden importantForAccessibility="no-hide-descendants">
              <Text style={styles.number}>{i + 1}</Text>
            </View>
            <View style={styles.body}>
              <Text style={styles.title}>{it.title}</Text>
              {it.hint ? <Text style={styles.hint}>{it.hint}</Text> : null}
            </View>
          </Pressable>
        ))}
      </View>
    );
  }
  return (
    <View style={styles.panels}>
      {items.map((it, i) => (
        <Pressable key={it.testID} testID={it.testID} accessibilityRole="button" onPress={it.onPress}
          style={({ pressed }) => [styles.panel, pressed && styles.pressed]}>
          <View style={[styles.bar, i === 0 && styles.barFirst]} />
          <View style={styles.body}>
            <Text style={styles.panelTitle}>{it.title}</Text>
            {it.hint ? <Text style={styles.hint}>{it.hint}</Text> : null}
          </View>
          <Text style={styles.chevron} aria-hidden>›</Text>
        </Pressable>
      ))}
    </View>
  );
}

const useStyles = makeStyles(t => ({
  // «Медкарта»
  cover: { alignItems: 'center', paddingTop: space.xl, paddingBottom: space.s, gap: space.xs },
  coverTitle: { fontFamily: t.fonts.title, fontSize: 40, lineHeight: 48, fontWeight: '700', letterSpacing: 4, color: t.colors.ink, textAlign: 'center' },
  coverTag: { fontFamily: t.fonts.title, fontStyle: 'italic', fontSize: 18, lineHeight: 24, color: t.colors.muted, textAlign: 'center' },
  rule: { alignSelf: 'stretch', marginHorizontal: space.xl, marginTop: space.m, gap: 2 },
  ruleThick: { height: 2, backgroundColor: t.colors.accent, opacity: 0.55 },
  ruleThin: { height: 1, backgroundColor: t.colors.accent, opacity: 0.55 },
  version: { marginTop: space.s, fontSize: 13, lineHeight: 18, color: t.colors.muted, textAlign: 'center' },
  journal: { backgroundColor: t.colors.card, borderWidth: 1, borderColor: t.colors.edge, borderRadius: t.shape.card, overflow: 'hidden' },
  row: { flexDirection: 'row', minHeight: 64 },
  rowLine: { borderTopWidth: 1, borderTopColor: t.colors.line },
  margin: { width: 40, alignItems: 'center', paddingTop: space.m + 2, borderRightWidth: 1.5, borderRightColor: t.colors.margin },
  number: { fontSize: 16, color: t.colors.margin },
  body: { flex: 1, justifyContent: 'center', paddingVertical: space.m, paddingHorizontal: space.m + 2, gap: 2 },
  title: { fontFamily: t.fonts.title, fontSize: 20, lineHeight: 26, fontWeight: '700', color: t.colors.ink },
  hint: { fontSize: 14, lineHeight: 19, color: t.colors.muted },
  pressed: { opacity: 0.8 },
  // «Монитор»
  monitor: { paddingTop: space.l, gap: space.xs },
  monitorTitle: { fontSize: 34, lineHeight: 42, fontWeight: '700', letterSpacing: 6, color: t.colors.ink },
  monitorVersion: { fontSize: 14, lineHeight: 20, color: t.colors.muted },
  panels: { gap: space.s },
  panel: {
    flexDirection: 'row', alignItems: 'center', minHeight: 64, paddingRight: space.m, paddingLeft: space.m + 2,
    borderRadius: t.shape.card, borderWidth: 1, borderColor: t.colors.edge, backgroundColor: t.colors.card,
  },
  bar: { alignSelf: 'stretch', width: 4, marginVertical: space.m, borderRadius: 2, backgroundColor: t.colors.edge },
  barFirst: { backgroundColor: t.colors.info },
  panelTitle: { fontSize: 18, lineHeight: 24, fontWeight: '700', color: t.colors.ink },
  chevron: { fontSize: 24, color: t.colors.muted },
}));
