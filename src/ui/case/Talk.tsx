// «Спросить» беседой (spec 2026-10-patient-card, 0.6.0; решение владельца по вопросу 43): «чтобы было похоже на диалог,
// где врач выбирает что спросить и далее пациент рассказывает». Лента — вопрос врача и реплика пациента, по порядку;
// вопросы — внизу, над вкладками: «О жалобах» и «О жизни».
import { type LayoutChangeEvent, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { T } from '@/i18n';
import { examInfo, examTerm, findingInfo, lifeHistory, type TermInfo, type VisitView } from '@/state/caseView';
import { examIcon } from '@/ui/itemIcons';
import { RowIcon } from '@/ui/RowIcon';
import { makeStyles, space } from '@/ui/theme';
import { Text } from '../text';
import { joinSaid, NO_SAID, replyOf } from './reply';

/** Вопрос врача — живой речью; нет такого — названием расспроса. */
const question = (id: string) => T.spikes.talk.questions[id] ?? examInfo(id).name;

/**
 * Лента беседы: заданные вопросы по порядку, у каждого — реплика пациента. Новая — целиком и выделена; в прежних
 * найденное — первым и жирным, из «нет» — до трёх, остальное — «ещё N — без особенностей». Найденное — своим абзацем,
 * «нет» — под ним, приглушённо: стена «нет» не прячет найденное, а нужные «нет» (при стенокардии — «приступы такие же»)
 * остаются на виду (часть 97, spec 2026-10-publish-ready). Касание фразы — справка.
 */
export function Talk({ v, asks, explain, isOpen, toggle, onRow }: {
  v: VisitView; asks: ReadonlySet<string>; explain: (info: TermInfo) => void;
  isOpen: (key: string) => boolean; toggle: (key: string) => void; onRow: (exam: string, e: LayoutChangeEvent) => void;
}) {
  const styles = useStyles();
  const t = T.spikes.talk;
  // «Известно» — новые сверху; беседа — по порядку; из карты («Нелюдимый врач», часть 91) — не беседа
  const asked = [...v.groups].reverse().filter(g => asks.has(g.exam) && !g.card);
  // без расспроса звать к вопросам незачем: что известно и откуда — в пояснении над лентой
  if (asked.length === 0) return v.challenges?.includes('mute') ? null : <Text style={styles.empty}>{t.empty}</Text>;
  return (
    <View style={styles.chat}>
      {asked.map(g => {
        // новая реплика — целиком, как новое в «Известно»; прежние — найденное и до трёх «нет»
        const k = `talk:${g.key}`;
        const open = g.fresh || isOpen(k);
        const { said, more } = replyOf(g.lines, open);
        const yes = said.filter(l => l.shown);
        const no = said.filter(l => !l.shown);
        return (
          <Animated.View key={g.key} entering={FadeInDown.duration(250)} testID={`done-${g.exam}`} onLayout={e => onRow(g.exam, e)} style={styles.pair}>
            <View style={styles.doc}>
              <Text style={styles.when}>{g.at}</Text>
              <Text style={styles.docText}>{question(g.exam)}</Text>
            </View>
            <View style={[styles.pt, g.fresh && styles.ptFresh]}>
              {said.length === 0 ? <Text style={styles.ptText}>{t.nothing}</Text> : null}
              {[yes, no].filter(part => part.length > 0).map((part, j) => {
                const texts = joinSaid(part.map(l => l.text));
                return (
                  <Text key={j} testID={part === yes ? `said-yes-${g.exam}` : `said-no-${g.exam}`} style={[styles.ptText, part === no && styles.no]}>
                    {part.map((l, i) => (
                      <Text key={`${l.f}${i}`} onPress={() => explain(findingInfo(l.f))} style={l.shown ? styles.found : undefined}>
                        {`${texts[i]}${i < part.length - 1 ? ' ' : ''}`}
                      </Text>
                    ))}
                  </Text>
                );
              })}
              {!g.fresh && g.lines.filter(l => !l.shown).length > NO_SAID ? (
                <Pressable testID={`more-${g.exam}`} accessibilityRole="button" aria-expanded={open} onPress={() => toggle(k)} hitSlop={space.s}
                  style={styles.moreTap}>
                  <Text style={styles.more}>{open ? t.less : t.moreNo(more)}</Text>
                </Pressable>
              ) : null}
            </View>
          </Animated.View>
        );
      })}
    </View>
  );
}

/**
 * Вопросы — внизу вкладки, под большим пальцем: заданные уходят в ленту. Долгое касание — что это за вопрос, как «?» у
 * обследований. «Практикант» — сначала то, что относится к жалобе, остальное — свёрнуто.
 */
export function Questions({ v, ids, rest, restOpen, onRest, onAsk, explain }: {
  v: VisitView; ids: readonly string[]; rest: readonly string[]; restOpen: boolean; onRest: () => void;
  onAsk: (id: string) => void; explain: (info: TermInfo) => void;
}) {
  const styles = useStyles();
  // вопросам — не больше трети экрана: главное на вкладке — беседа
  const { height } = useWindowDimensions();
  const t = T.spikes.talk;
  const p = T.spikes.patient;
  const left = [...ids, ...(restOpen ? rest : [])].filter(id => !v.done.includes(id));
  const parts = [
    { key: 'complaints', title: t.aboutComplaints, list: left.filter(id => !lifeHistory(id)) },
    { key: 'life', title: t.aboutLife, list: left.filter(lifeHistory) },
  ].filter(x => x.list.length > 0);
  const restLeft = rest.filter(id => !v.done.includes(id)).length;
  if (parts.length === 0 && restLeft === 0) return null;
  return (
    <View style={[styles.panel, { maxHeight: Math.round(height * 0.3) }]}>
      <ScrollView style={styles.panelScroll} contentContainerStyle={styles.panelContent} testID="talk-questions">
        {parts.map(x => (
          <View key={x.key} style={styles.part}>
            <Text style={styles.label}>{x.title}</Text>
            <View style={styles.row}>
              {x.list.map(id => {
                const why = v.unavailable[id];
                const info = examInfo(id);
                const min = v.minutes?.[id] ?? info.minutes;
                return (
                  <Pressable key={id} testID={`exam-${id}`} accessibilityRole="button" disabled={!!why} accessibilityHint={why ?? t.helpHint} hitSlop={5}
                    accessibilityActions={[{ name: 'longpress', label: p.whatIsIt }]}
                    onAccessibilityAction={e => { if (e.nativeEvent.actionName === 'longpress') explain(examTerm(id)); }}
                    onPress={() => onAsk(id)} onLongPress={() => explain(examTerm(id))}
                    style={({ pressed }) => [styles.q, !!why && styles.qOff, pressed && styles.pressed]}>
                    {/* значок вопроса (0.6.8) — о чём он; ответа ещё нет — серым пунктиром с «?» */}
                    <View style={styles.qRow}>
                      <RowIcon icon={examIcon(id)} state="unknown" size={18} testID="ic-unknown" />
                      <Text style={[styles.qText, styles.qTextIcon]}>
                        {question(id)}
                        <Text style={styles.qCost}>{` ${p.cost(min, info.cost)}`}</Text>
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ))}
        {restLeft > 0 ? (
          <Pressable testID="visit-rest-ask" accessibilityRole="button" aria-expanded={restOpen} onPress={onRest} style={({ pressed }) => [styles.rest, pressed && styles.pressed]}>
            <Text style={styles.restText}>{restOpen ? t.restHide : t.restShow(restLeft)}</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles(t => ({
  empty: { fontSize: 15, lineHeight: 21, color: t.colors.muted, textAlign: 'center', paddingVertical: space.xl },
  chat: { gap: space.m },
  pair: { gap: space.xs },
  // вопрос врача — справа, цветом главной кнопки; реплика пациента — слева, курсивом, как жалобы
  doc: {
    alignSelf: 'flex-end', maxWidth: '86%', paddingHorizontal: space.m, paddingVertical: space.s, gap: 2,
    backgroundColor: t.colors.accent, borderRadius: 14, borderBottomRightRadius: 4,
  },
  when: { fontFamily: t.fonts.mono, fontSize: 11, color: t.colors.onAccentHint },
  docText: { fontSize: 15, lineHeight: 20, color: t.colors.onAccent },
  pt: {
    alignSelf: 'flex-start', maxWidth: '90%', paddingHorizontal: space.m, paddingVertical: space.s, gap: space.xs,
    backgroundColor: t.colors.card, borderWidth: 1, borderColor: t.colors.edge, borderRadius: 14, borderBottomLeftRadius: 4,
  },
  ptFresh: { backgroundColor: t.colors.fresh, borderColor: t.colors.freshLine, borderLeftWidth: 3 },
  ptText: { fontFamily: t.fonts.title, fontStyle: 'italic', fontSize: 15, lineHeight: 21, color: t.colors.ink },
  found: { fontWeight: '700' },
  // «нет» — под найденным, приглушённо (часть 97)
  no: { color: t.colors.muted },
  more: { fontSize: 13, color: t.colors.muted },
  // строка в 17 пикселей: с полем сверху и снизу и hitSlop касание — 49 dp (NFR-ACC-1)
  moreTap: { paddingVertical: space.s },
  // как панель места: сжимается, если с крупным текстом места меньше, — вкладки не уходят за край (NFR-ACC-1)
  panel: { flexShrink: 1, backgroundColor: t.colors.card, borderTopWidth: 1, borderTopColor: t.colors.edge },
  panelScroll: { flexGrow: 0 },
  panelContent: { paddingHorizontal: space.l, paddingVertical: space.s, gap: space.s },
  part: { gap: space.xs },
  label: { fontSize: 12, fontWeight: '700', letterSpacing: 1.1, color: t.colors.muted, textTransform: 'uppercase' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  q: {
    minHeight: 38, justifyContent: 'center', paddingHorizontal: space.m, paddingVertical: space.xs, maxWidth: '100%',
    borderRadius: 20, borderWidth: 1.5, borderColor: t.colors.accent, backgroundColor: t.colors.card,
  },
  qOff: { opacity: 0.45 },
  qRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  qTextIcon: { flexShrink: 1 },
  qText: { fontSize: 13.5, lineHeight: 18, fontWeight: '700', color: t.shape.stamp ? t.colors.accent : t.colors.ink },
  qCost: { fontFamily: t.fonts.mono, fontSize: 11.5, fontWeight: '400', color: t.colors.muted },
  rest: { minHeight: 40, justifyContent: 'center' },
  restText: { fontSize: 14, fontWeight: '700', color: t.colors.accent },
  pressed: { opacity: 0.7 },
}));
