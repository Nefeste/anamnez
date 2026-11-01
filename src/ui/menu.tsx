// Главное меню в виде темы (spec 2026-09-own-look, часть 25; с 0.6.5 — бейдж врача и «Случай дня», вопрос 47, spec
// 2026-10-menu). «Медкарта» — обложка карты: «АНАМНЕЗ» прописными над двойной чертой, бейдж — карточка с прорезью для
// зажима и личной печатью врача, пункты — строки журнала на одном листе, номер на поле за красной линией, версия — внизу.
// «Монитор» — название, под ним кривая ЭКГ и версия, бейдж — панель с цифрами, как на мониторе у постели, пункты —
// панели с полосой, клавишами (часть 106, вопрос 74).
import { Pressable, useWindowDimensions, View } from 'react-native';
import { T } from '@/i18n';
import { EcgLine } from '@/render/EcgLine';
import { Portrait } from '@/render/Portrait';
import { Meter } from './charts';
import { Key } from './components';
import { Text } from './text';
import { makeStyles, space, useTheme } from './theme';

export function Cover({ version }: { version: string }) {
  const styles = useStyles();
  const t = useTheme();
  const { width } = useWindowDimensions();
  const title = T.common.appName.toUpperCase();
  if (t.shape.ruled) {
    // версия — внизу меню (MenuFoot): под чертой — бейдж врача
    return (
      <View style={styles.cover}>
        <Text accessibilityRole="header" style={styles.coverTitle}>{title}</Text>
        <Text style={styles.coverTag}>{T.menu.tag}</Text>
        <View style={styles.rule}>
          <View style={styles.ruleThick} />
          <View style={styles.ruleThin} />
        </View>
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

/** Версия внизу меню — в «Медкарте»; в «Мониторе» она под кривой ЭКГ. */
export function MenuFoot({ version }: { version: string }) {
  const styles = useStyles();
  const t = useTheme();
  return t.shape.ruled ? <Text style={styles.version}>{T.menu.versionLine(version)}</Text> : null;
}

/** Место между бейджем и пунктами: на высоком экране пункты — внизу, под большим пальцем. */
/**
 * Сводка карьеры между бейджем и пунктами (часть 102, spec 2026-10-publish-ready; ответ владельца на вопрос 69): на высоком
 * экране там была пустота. Карьера идёт — глава, день, основные задания полосой; нет — путь кампании. Касание — в кампанию.
 */
export function CareerStrip({ title, line, progress, onPress }: {
  title: string; line: string; progress?: { label: string; value: number; max: number; text: string }; onPress: () => void;
}) {
  const styles = useStyles();
  const t = useTheme();
  return (
    <Pressable testID="menu-career" accessibilityRole="button" accessibilityLabel={`${title}. ${line}${progress ? `. ${progress.label}: ${progress.text}` : ''}`}
      onPress={onPress} style={({ pressed }) => [styles.career, pressed && styles.pressed]}>
      <Text style={t.shape.ruled ? styles.title : styles.panelTitle}>{title}</Text>
      <Text style={styles.hint}>{line}</Text>
      {progress ? <Meter label={progress.label} value={progress.value} max={progress.max} text={progress.text} /> : null}
    </Pressable>
  );
}

export function MenuSpacer() {
  const styles = useStyles();
  return <View style={styles.spacer} />;
}

export interface BadgeData {
  name: string;
  rank: string;
  first: string;
  last: string;
  cases: number;
  /** доля верных диагнозов, %; приёмов нет — нет и доли */
  correctPct?: number;
  seed: number;
  sex: 'm' | 'f';
  age: number;
}

/**
 * Бейдж врача игрока (вопрос 47, вариант А): портрет в халате со стетоскопом, имя, звание, сколько принято и доля
 * верных диагнозов. Касание — профиль; для чтения с экрана — одна кнопка со всем, что на бейдже.
 */
export function Badge({ d, onPress }: { d: BadgeData; onPress: () => void }) {
  const styles = useStyles();
  const t = useTheme();
  const m = T.menu;
  const stats = d.correctPct === undefined ? m.badgeEmpty : m.badgeStats(d.cases, d.correctPct);
  const label = m.badgeLabel(d.name, d.rank, stats);
  if (t.shape.ruled) {
    return (
      <Pressable testID="menu-badge" accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
        style={({ pressed }) => [styles.badge, pressed && styles.pressed]}>
        {/* прорезь для зажима и печать — украшения */}
        <View style={styles.clip} />
        <View style={styles.badgeRow}>
          <Portrait seed={d.seed} sex={d.sex} age={d.age} size={64} uniform="doctor" />
          <View style={styles.badgeText}>
            <Text style={styles.badgeName}>{d.name}</Text>
            <Text style={styles.badgeRank}>{d.rank}</Text>
          </View>
        </View>
        <View style={styles.badgeFoot}>
          <Text style={styles.badgeStats}>{stats}</Text>
          <View style={styles.stamp} aria-hidden importantForAccessibility="no-hide-descendants">
            <Text style={styles.stampText}>{m.stamp(d.last, d.first)}</Text>
          </View>
        </View>
      </Pressable>
    );
  }
  return (
    <Pressable testID="menu-badge" accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={({ pressed }) => [styles.panelBadge, pressed && styles.pressed]}>
      <View style={styles.badgeRow}>
        <Portrait seed={d.seed} sex={d.sex} age={d.age} size={48} uniform="doctor" />
        <View style={styles.badgeText}>
          <Text style={styles.monitorName}>{d.name}</Text>
          <Text style={styles.badgeRank}>{d.rank}</Text>
        </View>
      </View>
      {/* цифры — цветами каналов монитора: принято — зелёным, как ЭКГ, верный диагноз — голубым, как сатурация */}
      <View style={styles.readouts}>
        <View style={styles.readout}>
          <Text style={styles.readLabel}>{m.readCases}</Text>
          <Text style={[styles.readValue, styles.readCases]}>{String(d.cases)}</Text>
        </View>
        <View style={[styles.readout, styles.readoutNext]}>
          <Text style={styles.readLabel}>{m.readCorrect}</Text>
          <Text style={[styles.readValue, styles.readCorrect]}>{d.correctPct === undefined ? '—' : `${d.correctPct} %`}</Text>
        </View>
      </View>
    </Pressable>
  );
}

/**
 * «Случай дня» в главном меню (вопрос 47: «чтобы не искать его в подменю»): листок календаря с сегодняшним числом и
 * что с ним — можно сыграть, начат, сыгран.
 */
export function DailyCard({ day, month, hint, label, onPress }: { day: number; month: string; hint: string; label: string; onPress: () => void }) {
  const styles = useStyles();
  const t = useTheme();
  const ruled = t.shape.ruled;
  const inner = (
    <>
      <View style={styles.leaf} aria-hidden importantForAccessibility="no-hide-descendants">
        <Text style={styles.leafDay}>{String(day)}</Text>
        <Text style={styles.leafMonth}>{month}</Text>
      </View>
      <View style={styles.body}>
        <Text style={ruled ? styles.title : styles.panelTitle}>{T.daily.title}</Text>
        <Text style={styles.hint}>{hint}</Text>
      </View>
      {ruled ? null : <Text style={styles.chevron} aria-hidden>›</Text>}
    </>
  );
  // «Монитор» — клавишей, как пункты меню (часть 106); «Медкарта» — листок календаря, как был
  return ruled ? (
    <Pressable testID="menu-daily" accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={({ pressed }) => [styles.daily, pressed && styles.pressed]}>
      {inner}
    </Pressable>
  ) : (
    <Key testID="menu-daily" accessibilityRole="button" accessibilityLabel={label} onPress={onPress} radius={t.shape.card} face={styles.panel}>
      {inner}
    </Key>
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
        // панель-клавиша (часть 106, вопрос 74)
        <Key key={it.testID} testID={it.testID} accessibilityRole="button" onPress={it.onPress} radius={t.shape.card} face={styles.panel}>
          <View style={[styles.bar, i === 0 && styles.barFirst]} />
          <View style={styles.body}>
            <Text style={styles.panelTitle}>{it.title}</Text>
            {it.hint ? <Text style={styles.hint}>{it.hint}</Text> : null}
          </View>
          <Text style={styles.chevron} aria-hidden>›</Text>
        </Key>
      ))}
    </View>
  );
}

const useStyles = makeStyles(t => ({
  // «Медкарта»
  cover: { alignItems: 'center', paddingTop: space.l, gap: space.xs },
  coverTitle: { fontFamily: t.fonts.title, fontSize: 40, lineHeight: 48, fontWeight: '700', letterSpacing: 4, color: t.colors.ink, textAlign: 'center' },
  coverTag: { fontFamily: t.fonts.title, fontStyle: 'italic', fontSize: 18, lineHeight: 24, color: t.colors.muted, textAlign: 'center' },
  rule: { alignSelf: 'stretch', marginHorizontal: space.xl, marginTop: space.m, gap: 2 },
  ruleThick: { height: 2, backgroundColor: t.colors.accent, opacity: 0.55 },
  ruleThin: { height: 1, backgroundColor: t.colors.accent, opacity: 0.55 },
  version: { fontSize: 13, lineHeight: 18, color: t.colors.muted, textAlign: 'center' },
  spacer: { flexGrow: 1 },
  // бейдж «Медкарты»: карточка с прорезью для зажима, внизу — итоги и личная печать
  badge: {
    backgroundColor: t.colors.card, borderWidth: 1, borderColor: t.colors.edge, borderRadius: t.shape.card,
    paddingTop: space.l + 2, paddingHorizontal: space.m + 2, paddingBottom: space.m, gap: space.s,
  },
  clip: {
    position: 'absolute', top: space.s - 2, left: '50%', marginLeft: -22, width: 44, height: 6, borderRadius: 3,
    backgroundColor: t.colors.bg, borderWidth: 1, borderColor: t.colors.edge,
  },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  badgeText: { flex: 1, gap: 2 },
  badgeName: { fontFamily: t.fonts.title, fontSize: 21, lineHeight: 26, fontWeight: '700', color: t.colors.ink },
  badgeRank: { fontSize: 15, lineHeight: 20, fontWeight: '700', color: t.colors.accent },
  badgeFoot: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.s,
    borderTopWidth: 1, borderTopColor: t.colors.line, paddingTop: space.s,
  },
  badgeStats: { flexShrink: 1, fontFamily: t.fonts.mono, fontSize: 14, lineHeight: 20, color: t.colors.muted },
  stamp: {
    transform: [{ rotate: '-6deg' }], borderWidth: 2, borderColor: t.colors.accent, borderRadius: 6,
    paddingHorizontal: space.s, paddingVertical: 2, opacity: 0.75,
  },
  stampText: { fontSize: 10, lineHeight: 12, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase', textAlign: 'center', color: t.colors.accent },
  // «Случай дня»: листок календаря — сверху полоса, число крупно, месяц под ним
  daily: {
    flexDirection: 'row', alignItems: 'center', minHeight: 72, paddingLeft: space.m,
    backgroundColor: t.colors.card, borderWidth: 1, borderColor: t.colors.edge, borderRadius: t.shape.card,
  },
  leaf: {
    width: 52, alignItems: 'center', paddingVertical: space.xs, borderWidth: 1, borderColor: t.colors.edge, borderTopWidth: 5,
    borderTopColor: t.shape.ruled ? t.colors.margin : t.colors.info, borderRadius: t.shape.ruled ? 3 : 8,
  },
  leafDay: { fontFamily: t.shape.ruled ? t.fonts.title : t.fonts.mono, fontSize: 22, lineHeight: 26, fontWeight: '700', color: t.colors.ink },
  leafMonth: { fontSize: 11, lineHeight: 14, color: t.colors.muted },
  journal: { backgroundColor: t.colors.card, borderWidth: 1, borderColor: t.colors.edge, borderRadius: t.shape.card, overflow: 'hidden' },
  row: { flexDirection: 'row', minHeight: 64 },
  rowLine: { borderTopWidth: 1, borderTopColor: t.colors.line },
  margin: { width: 40, alignItems: 'center', paddingTop: space.m + 2, borderRightWidth: 1.5, borderRightColor: t.colors.margin },
  number: { fontSize: 16, color: t.colors.margin },
  body: { flex: 1, justifyContent: 'center', paddingVertical: space.m, paddingHorizontal: space.m + 2, gap: 2 },
  title: { fontFamily: t.fonts.title, fontSize: 20, lineHeight: 26, fontWeight: '700', color: t.colors.ink },
  hint: { fontSize: 14, lineHeight: 19, color: t.colors.muted },
  pressed: { opacity: 0.8 },
  // сводка карьеры (часть 102)
  career: {
    backgroundColor: t.colors.card, borderWidth: 1, borderColor: t.colors.edge, borderRadius: t.shape.card,
    paddingVertical: space.m, paddingHorizontal: space.m + 2, gap: space.xs,
  },
  // «Монитор»
  monitor: { paddingTop: space.l, gap: space.xs },
  monitorTitle: { fontSize: 34, lineHeight: 42, fontWeight: '700', letterSpacing: 6, color: t.colors.ink },
  monitorVersion: { fontSize: 14, lineHeight: 20, color: t.colors.muted },
  // бейдж «Монитора»: панель, под именем — цифры, как на мониторе
  panelBadge: { backgroundColor: t.colors.card, borderWidth: 1, borderColor: t.colors.edge, borderRadius: t.shape.card, padding: space.m, gap: space.m - 2 },
  monitorName: { fontSize: 19, lineHeight: 24, fontWeight: '700', color: t.colors.ink },
  readouts: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: t.colors.line, paddingTop: space.s + 2 },
  readout: { flex: 1, gap: 2 },
  readoutNext: { borderLeftWidth: 1, borderLeftColor: t.colors.line, paddingLeft: space.m },
  readLabel: { fontSize: 11, lineHeight: 14, letterSpacing: 1.2, textTransform: 'uppercase', fontWeight: '600', color: t.colors.muted },
  readValue: { fontFamily: t.fonts.mono, fontSize: 26, lineHeight: 32, fontWeight: '700' },
  readCases: { color: t.colors.accent },
  readCorrect: { color: t.colors.info },
  panels: { gap: space.s },
  // лицо панели-клавиши: фон, рамку и губу даёт `Key` (часть 106)
  panel: { flexDirection: 'row', alignItems: 'center', minHeight: 64, paddingRight: space.m, paddingLeft: space.m + 2 },
  bar: { alignSelf: 'stretch', width: 4, marginVertical: space.m, borderRadius: 2, backgroundColor: t.colors.edge },
  barFirst: { backgroundColor: t.colors.info },
  panelTitle: { fontSize: 18, lineHeight: 24, fontWeight: '700', color: t.colors.ink },
  chevron: { fontSize: 24, color: t.colors.muted },
}));
