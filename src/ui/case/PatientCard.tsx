// Карта пациента (09-game-design.md §5, spec 2026-10-patient-card): сверху закреплены шапка пациента и «Похоже на»,
// внизу — вкладки «Карта · Спросить · Осмотреть · Назначить» и «Решение»; у каждой вкладки своя прокрутка (0.6.0,
// решение владельца по вопросу 43). «Карта» — из двух частей с переключателем сверху: «Результаты» — журнал, «Гипотезы»
// — «Похоже на», «Ваш ряд» и правила; у каждой части своя прокрутка (0.6.5, вопрос 46). Решение — отдельный экран.
// Общая для прототипа П4, смены, «Случая дня» и «Разобрать случай»: вид и действия приходят снаружи.
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { type LayoutChangeEvent, Pressable, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { buzz, play } from '@/audio/sounds';
import { T } from '@/i18n';
import type { StaffPortrait } from '@/render/look';
import { Portrait } from '@/render/Portrait';
import { examInfo, examsByAction, findingInfo, type Line, type ResultGroup, type TermInfo, type VisitView } from '@/state/caseView';
import { Button, Card, Chip, Chips, H, P, Pane, Screen, type ScreenScroll, Tabs } from '@/ui/components';
import { examIcon } from '@/ui/itemIcons';
import { TermSheet } from '@/ui/TermSheet';
import { makeStyles, space, touch } from '@/ui/theme';
import { Text } from '../text';
import type { CaseActions, FooterAction } from './actions';
import { type CardTab, CardTabs } from './CardTabs';
import { Dangers, dangerLine } from './Dangers';
import { Differential } from './Differential';
import { BodyMap, PlacePanel } from './Examine';
import { lineMark } from './marks';
import type { ExamPlace } from './places';
import { longestOf, partsOf, Referral } from './Referral';
import { ResultPicture } from './ResultPicture';
import { Questions, Talk } from './Talk';

type Where = 'known' | 'list';
/** Часть «Карты» (вопрос 46): журнал результатов или доска гипотез. */
type CardPart = 'results' | 'board';

/** Сколько после действия держать ответ посередине: пока раскладка выше не улеглась; листаете сами — сразу перестаём. */
const CENTER_MS = 900;
const WAIT_MS = 8000;
/** Ключ первого нового — к нему после «Подождать»: в «Известно» на «Карте», в списке — на остальных вкладках. */
const FIRST_FRESH = 'fresh';

/**
 * С чего начать приём: игрок уже что-то сделал (вернулся с результатами), приём закончен или его ведёт нанятый врач —
 * с «Карты»; новый пациент — со «Спросить», а давление, что померила медсестра, ждёт на «Карте» числом нового.
 */
const firstTab = (v: VisitView, readOnly: boolean): CardTab => (v.acted || v.decision || readOnly ? 'card' : 'ask');

/**
 * Последнее у пациента — вкладка, место на фигуре, отмеченное в бланке — и после того, как экран карты собрали заново:
 * из справки «Подробнее» в веб-сборке назад — там же. Немного: только что принятые.
 */
function recent<V>() {
  const seen = new Map<number, V>();
  return {
    get: (patient: number) => seen.get(patient),
    set: (patient: number, value: V | undefined) => {
      seen.delete(patient);
      if (value !== undefined) seen.set(patient, value);
      if (seen.size > 20) seen.delete(seen.keys().next().value!);
    },
  };
}
const lastTab = recent<CardTab>();
const lastPlace = recent<ExamPlace>();
const lastMarked = recent<string[]>();
const lastPart = recent<CardPart>();
const startTab = (v: VisitView, readOnly: boolean): CardTab => lastTab.get(v.portrait.key) ?? firstTab(v, readOnly);

/**
 * `readOnly` — приём ведёт нанятый врач (spec 2026-09-hired-doctors, часть 19): видно, что он
 * узнал, но действий и решения нет; внизу — своя кнопка («Забрать себе»); рядом с его строкой — его портрет (0.5.7).
 */
export function PatientCard({ view: v, actions, readOnly }: { view: VisitView; actions: CaseActions; readOnly?: { note: string; portrait?: StaffPortrait; footer: FooterAction & { hint?: string } } }) {
  const styles = useStyles();
  const key = v.portrait.key;
  // вкладка привязана к пациенту; приём закончен или его ведёт нанятый врач — только «Карта»
  const [picked, setPicked] = useState<{ patient: number; tab: CardTab }>(() => ({ patient: key, tab: startTab(v, !!readOnly) }));
  if (picked.patient !== key) setPicked({ patient: key, tab: startTab(v, !!readOnly) });
  const tabbed = !readOnly && !v.decision;
  const tab: CardTab = !tabbed ? 'card' : picked.patient === key ? picked.tab : startTab(v, !!readOnly);
  // часть «Карты» — у этого пациента; приём закончен или его ведёт нанятый врач — только результаты
  const [partPicked, setPartPicked] = useState<{ patient: number; part: CardPart }>(() => ({ patient: key, part: lastPart.get(key) ?? 'results' }));
  const part: CardPart = !tabbed ? 'results' : partPicked.patient === key ? partPicked.part : lastPart.get(key) ?? 'results';
  // свой лист — у каждой вкладки и у каждой части «Карты»
  const pane = tab === 'card' ? `card:${part}` : tab;
  const [term, setTerm] = useState<TermInfo | null>(null);
  // что раскрыл игрок — у этого пациента; новый пациент начинается свёрнутым
  const [opened, setOpened] = useState<{ patient: number; keys: string[] }>({ patient: key, keys: [] });
  const openKeys = opened.patient === key ? opened.keys : [];
  const isOpen = (k: string) => openKeys.includes(k);
  const toggle = (k: string) => setOpened({ patient: key, keys: isOpen(k) ? openKeys.filter(x => x !== k) : [...openKeys, k] });
  // место на фигуре, чьи осмотры открыты, — у этого пациента; касание открытого закрывает
  const [where, setWhere] = useState<{ patient: number; place?: ExamPlace }>(() => ({ patient: key, place: lastPlace.get(key) }));
  const place = where.patient === key ? where.place : lastPlace.get(key);
  const pickPlace = (next: ExamPlace) => {
    const open = place === next ? undefined : next;
    lastPlace.set(key, open);
    setWhere({ patient: key, place: open });
  };
  // отмеченное в бланке направления, по порядку отметки, — у этого пациента; сделанное и недоступное — не в счёт
  const [marks, setMarks] = useState<{ patient: number; ids: string[] }>(() => ({ patient: key, ids: lastMarked.get(key) ?? [] }));
  const marked = (marks.patient === key ? marks.ids : lastMarked.get(key) ?? []).filter(id => !v.done.includes(id) && !v.unavailable[id]);
  const setMarked = (ids: string[]) => {
    lastMarked.set(key, ids.length > 0 ? ids : undefined);
    setMarks({ patient: key, ids });
  };
  // подсказка «нажмите, чтобы узнать» — пока игрок ни разу не открыл справку
  const [hinted, setHinted] = useState(false);
  const t = T.spikes.patient;
  const d = T.spikes.decision;
  const groups = examsByAction(v.portrait);
  // «Известно»: новое, то, где что-то нашли, и снимки — на виду; где ничего не нашли — одной строкой
  const loud = v.groups.filter(g => g.fresh || found(g) || g.image);
  const quiet = v.groups.filter(g => !loud.includes(g));
  const firstFresh = loud.find(x => x.fresh);

  useEffect(() => {
    if (v.meanwhile.length > 0) {
      const kind = v.alarm ? 'alarm' : v.urgent ? 'urgent' : 'ready';
      play(kind);
      buzz(kind);
    }
  }, [v.meanwhile, v.urgent, v.alarm]);

  // ответ на сделанное — посередине листа (отзыв владельца 16.10.2026, 0.5.20): что выше, растёт вместе с ответом, а
  // прокрутка на Android места не держит. Где что лежит — по onLayout: строка — от начала своей карточки, карточка — от
  // начала листа; ставим, когда раскладка улеглась. У каждой вкладки свой лист, и места — свои
  const scroll = useRef<ScreenScroll>(null);
  const cardY = useRef<Record<Where, number>>({ known: 0, list: 0 });
  const rows = useRef(new Map<string, { card: Where; y: number; height: number; id?: string }>());
  // `skip` — новое, что было до «Подождать»: ставим следующее, а не его
  const want = useRef<{ key: string; skip?: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expiry = useRef<ReturnType<typeof setTimeout> | null>(null);
  // где был лист каждой вкладки — у этого пациента: вернулись на вкладку — там же
  const offsets = useRef<{ patient: number; y: Record<string, number> }>({ patient: key, y: {} });
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (expiry.current) clearTimeout(expiry.current);
  }, []);
  const centerSoon = () => {
    if (!want.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      const w = want.current;
      const r = w && rows.current.get(w.key);
      if (r && !(w.skip && r.id === w.skip)) scroll.current?.center(cardY.current[r.card] + r.y, r.height);
    }, 40);
  };
  const follow = (k: string, ms = CENTER_MS, skip?: string) => {
    want.current = { key: k, skip };
    if (expiry.current) clearTimeout(expiry.current);
    expiry.current = setTimeout(() => {
      want.current = null;
    }, ms);
    centerSoon();
  };
  const placeCard = (card: Where, e: LayoutChangeEvent) => {
    cardY.current[card] = e.nativeEvent.layout.y;
    centerSoon();
  };
  const placeRow = (k: string, card: Where, e: LayoutChangeEvent, id?: string) => {
    const { y, height } = e.nativeEvent.layout;
    rows.current.set(k, { card, y, height, id });
    if (want.current?.key === k) centerSoon();
  };
  const remember = (y: number) => {
    if (offsets.current.patient !== key) offsets.current = { patient: key, y: {} };
    offsets.current.y[pane] = y;
  };
  const setTab = (next: CardTab) => {
    want.current = null;
    rows.current.clear();
    lastTab.set(key, next);
    setPicked({ patient: key, tab: next });
  };
  const setPart = (next: CardPart) => {
    want.current = null;
    rows.current.clear();
    lastPart.set(key, next);
    setPartPicked({ patient: key, part: next });
  };

  // «Практикант» (spec 2026-10-trainee): сверху то, что относится к жалобе, и сделанное; остальное — свёрнуто
  const focus = v.focus ? new Set(v.focus) : undefined;
  const askMain = focus ? groups.ask.filter(id => focus.has(id) || v.done.includes(id)) : groups.ask;
  const askRest = focus ? groups.ask.filter(id => !askMain.includes(id)) : [];
  // первое новое на листе вкладки — к нему после «Подождать»; в бланке — по порядку разделов
  const rowsOfTab = tab === 'order' ? partsOf(groups.order, focus).flatMap(x => x.ids) : tab === 'ask' ? groups.ask : [];
  const freshRow = rowsOfTab.find(id => v.done.includes(id) && v.groups.some(g => g.exam === id && g.fresh));

  // касание — вибрацией: звук касания на телефоне не понравился (отзыв на 0.0.2)
  const doExam = (id: string) => {
    buzz('tap');
    follow(`done:${id}`);
    actions.act(id);
  };
  // бланк: галочка — отметить или снять; «Отправить» — отмеченное разом, по порядку отметки; к первому — ответ
  const mark = (id: string) => setMarked(marked.includes(id) ? marked.filter(x => x !== id) : [...marked, id]);
  const send = () => {
    if (marked.length === 0) return;
    buzz('tap');
    follow(`done:${marked[0]}`);
    setMarked([]);
    if (actions.actAll) actions.actAll(marked);
    else for (const id of marked) actions.act(id);
  };
  // пришли результаты — к первому новому; часы доживают ожидание в следующих кадрах, поэтому дольше
  const wait = () => {
    // новое придёт в журнал: с доски гипотез — к нему
    if (tab === 'card' && part === 'board') setPart('results');
    follow(FIRST_FRESH, WAIT_MS, tab === 'card' ? firstFresh?.key : freshRow);
    actions.waitForResults();
  };
  const explain = (info: TermInfo) => {
    setHinted(true);
    setTerm(info);
  };
  // отпустили ждать или попросили подождать — вернётся с новым: тогда с «Карты», а не с прежней вкладки
  const sendAway = actions.sendAway ? () => {
    lastTab.set(key, undefined);
    lastPlace.set(key, undefined);
    lastMarked.set(key, undefined);
    lastPart.set(key, undefined);
    actions.sendAway?.();
  } : undefined;

  // внизу, под большим пальцем: нанятый врач — «Забрать себе»; приём закончен — итог и разбор; иначе — вкладки и «Решение»
  const bottom = readOnly
    ? <View style={styles.footer}><Button testID={readOnly.footer.testID} title={readOnly.footer.title} hint={readOnly.footer.hint} onPress={readOnly.footer.run} /></View>
    : v.decision
      ? <View style={styles.footer}><Button testID="visit-to-outcome" title={d.toOutcome} onPress={() => router.push(actions.routes.outcome)} /></View>
      : <CardTabs value={tab} onChange={setTab} fresh={v.freshCount}
          decide={{ title: d.open, hint: v.draft.diagnosis ? d.diagnosis(v.draftDiagnosisName ?? '') : undefined, onPress: () => router.push(actions.routes.decision) }} />;

  // ждём результатов или пациента из другого кабинета — полосой над вкладками, видно с любой из них
  const waiting = (v.pending.length > 0 || !!v.away) && !v.decision && !readOnly;
  // ждать нечего, а ждёт кто-то срочнее (часть 37): привезли с болью в груди — к нему
  const stepOut = !waiting && !!v.canStepOut && !!sendAway && !readOnly && !v.decision;

  return (
    <Screen scroll={false}>
      <View style={styles.page}>
        <Head v={v} readOnly={readOnly} open={isOpen('complaints')} onToggle={() => toggle('complaints')} explain={explain} />
        {/* «Похоже на» — полосой под шапкой: видно с любой вкладки; в ряд — на «Карте» */}
        {v.hints.length > 0 && !v.decision && !readOnly ? (
          <View testID="likely-strip" style={styles.likely}>
            <Text style={styles.likelyLabel}>{t.likelyShort}</Text>
            <Text numberOfLines={2} style={styles.likelyText}>{v.hints.map(h => `${h.name} — ${h.word ?? t.outOf10(h.outOf10)}`).join(' · ')}</Text>
          </View>
        ) : null}
        {/* подсказка «Практиканту» (часть 94): опасные причины жалобы — строкой; касание — к ним, на доску гипотез */}
        {v.danger && !v.decision && !readOnly ? (
          <Pressable testID="danger-strip" accessibilityRole="button" accessibilityHint={t.dangerShow} onPress={() => {
            setTab('card');
            setPart('board');
          }} style={({ pressed }) => [styles.likely, pressed && styles.pressed]}>
            <Text numberOfLines={2} style={styles.likelyText}>{dangerLine(v.danger)}</Text>
          </Pressable>
        ) : null}
        {/* за это время (смена): пришёл срочный, у больного в смотровой остановилось сердце — сразу, с любой вкладки */}
        {v.meanwhile.length > 0 ? (
          <View style={styles.meanwhile}>
            {v.meanwhile.map((m, i) => (
              <Text key={i} testID={`meanwhile-${i}`} style={styles.stripLine}>
                {i === 0 ? <Text style={styles.meanwhileLabel}>{`${t.meanwhile}: `}</Text> : null}
                {m}
              </Text>
            ))}
          </View>
        ) : null}

        {/* «Карта»: переключатель частей — над листом, не уезжает с прокруткой */}
        {tab === 'card' && tabbed ? (
          <View style={styles.parts}>
            <Tabs<CardPart> testPrefix="part" value={part} onChange={setPart} items={[
              { key: 'results', title: v.freshCount > 0 ? t.partResultsFresh(v.freshCount) : t.partResults },
              { key: 'board', title: t.partBoard },
            ]} />
          </View>
        ) : null}

        <Pane key={`${key}:${pane}`} startAt={() => (offsets.current.patient === key ? offsets.current.y[pane] : undefined) ?? (tab === 'ask' ? Infinity : 0)}
          onScrollY={remember} scrollRef={scroll} onDrag={() => { want.current = null; }} testID={`pane-${tab}`}>
          {tab === 'card' && part === 'results' ? (
            <>
              {v.returnNote ? <P testID="visit-return">{v.returnNote}</P> : null}
              {v.payerNote ? <P muted testID="visit-payer">{v.payerNote}</P> : null}
              {/* сделанные сроки — здесь, идущие — в шапке; номер строки — тот же, что в шапке */}
              {v.targets?.some(x => x.done) ? (
                <Card>
                  <Text style={styles.label}>{t.targetsDone}</Text>
                  {v.targets.map((x, i) => (x.done ? <P key={i} testID={`visit-target-${i}`}>{x.text}</P> : null))}
                </Card>
              ) : null}
              {v.decision ? (
                <Card>
                  <H>{d.finished}</H>
                  <P testID="visit-finished">{v.decision.outcome}</P>
                </Card>
              ) : null}
              <Card onLayout={e => placeCard('known', e)}>
                <View style={styles.knownHead}>
                  <Text style={styles.label}>{t.known}</Text>
                  {v.freshCount > 0 && <Text testID="visit-fresh-count" style={styles.freshCount}>{t.freshCount(v.freshCount)}</Text>}
                </View>
                {v.groups.length === 0 ? <P muted>{t.none}</P> : (
                  <>
                    {/* новые результаты — сверху, выделены и целиком; прежние — что нашли, остальное свёрнуто */}
                    {loud.map(g => (
                      <KnownGroup key={g.key} g={g} open={g.fresh || isOpen(g.key)} onToggle={() => toggle(g.key)} explain={explain}
                        onLayout={g === firstFresh ? e => placeRow(FIRST_FRESH, 'known', e, g.key) : undefined} />
                    ))}
                    {quiet.length > 0 && (
                      <Pressable testID="visit-quiet" accessibilityRole="button" aria-expanded={isOpen('quiet')} onPress={() => toggle('quiet')}
                        style={({ pressed }) => [styles.quiet, pressed && styles.pressed]}>
                        <Text style={styles.quietText}>{t.quiet(quiet.map(g => g.name).join(', '))}</Text>
                        <Text style={styles.chevron}>{isOpen('quiet') ? '▴' : '▾'}</Text>
                      </Pressable>
                    )}
                    {isOpen('quiet') && quiet.map(g => <KnownGroup key={g.key} g={g} open explain={explain} />)}
                  </>
                )}
                {!hinted && <P muted>{t.tapForHint}</P>}
              </Card>
            </>
          ) : tab === 'card' ? (
            // доска гипотез: «Похоже на» — в ряд, опасные причины «Практиканту» (часть 94), «Ваш ряд», правила решения
            <>
              {tabbed && v.hints.length > 0 && (
                <Card>
                  <Text style={styles.label}>{t.likely}</Text>
                  {/* из подсказки — в дифференциальный ряд (spec 2026-10-differential) */}
                  {v.hints.map(h => {
                    const inRow = v.differential.some(x => x.id === h.id);
                    return (
                      <View key={h.id} style={styles.hint}>
                        <View style={styles.headText}>
                          <P testID={`likely-${h.id}`}>{`${h.name} — ${h.word ?? t.similar(h.outOf10)}`}</P>
                        </View>
                        <Chip testID={`likely-add-${h.id}`} strong={inRow} text={inRow ? T.spikes.differential.inRow : T.spikes.differential.toRow} onPress={() => actions.toggleHypothesis(h.id)} />
                      </View>
                    );
                  })}
                </Card>
              )}
              {tabbed && <Dangers v={v} actions={actions} explain={explain} />}
              {tabbed && <Differential v={v} actions={actions} />}
              {/* правила решения (часть 32): оттавские — нужен ли снимок по уже проверенному */}
              {tabbed && v.rules.length > 0 && (
                <Card>
                  <Text style={styles.label}>{t.rules}</Text>
                  {v.rules.map(r => <P key={r.id} testID={`rule-${r.id}`}>{`${r.name}. ${r.text}`}</P>)}
                </Card>
              )}
            </>
          ) : tab === 'ask' ? (
            // беседа: заданные вопросы и реплики пациента по порядку; вопросы — внизу, под листом
            <View onLayout={e => placeCard('list', e)}>
              <Talk v={v} asks={new Set(groups.ask)} explain={explain} isOpen={isOpen} toggle={toggle}
                onRow={(id, e) => {
                  placeRow(`done:${id}`, 'list', e);
                  if (id === freshRow) placeRow(FIRST_FRESH, 'list', e, id);
                }} />
            </View>
          ) : tab === 'examine' ? (
            <BodyMap v={v} ids={groups.examine} place={place} onPlace={pickPlace} focus={focus} />
          ) : (
            // бланк направления: строки — прямо в столбце, где легла каждая — от его начала
            <View onLayout={e => placeCard('list', e)} style={styles.form}>
              <Referral v={v} ids={groups.order} focus={focus} marked={marked} onMark={mark} isOpen={isOpen} toggle={toggle} explain={explain}
                onRow={(id, e) => {
                  placeRow(`done:${id}`, 'list', e);
                  if (id === freshRow) placeRow(FIRST_FRESH, 'list', e, id);
                }} />
            </View>
          )}
        </Pane>

        {tab === 'ask' ? (
          <Questions v={v} ids={askMain} rest={askRest} restOpen={isOpen('rest:ask')} onRest={() => toggle('rest:ask')} onAsk={doExam} explain={explain} />
        ) : null}
        {tab === 'examine' && place ? (
          <PlacePanel v={v} place={place} ids={groups.examine} focus={focus} isOpen={isOpen} toggle={toggle}
            onExam={id => {
              buzz('tap');
              actions.act(id);
            }}
            explain={explain} onClose={() => pickPlace(place)} />
        ) : null}
        {tab === 'order' && marked.length > 0 ? (
          // бланк: сколько отмечено, во что обойдётся, сколько ждать самого долгого — и «Отправить»
          <View testID="order-bar" style={[styles.strip, styles.orderBar]}>
            <Text testID="order-sum" style={[styles.stripText, styles.stripLine]}>
              {T.spikes.referral.marked(marked.length, T.common.rub(marked.reduce((a, id) => a + examInfo(id).cost, 0)), longestOf(v, marked))}
            </Text>
            <Pressable testID="order-send" accessibilityRole="button" accessibilityHint={T.spikes.referral.sendHint} onPress={send}
              style={({ pressed }) => [styles.stripButton, styles.sendButton, pressed && styles.pressed]}>
              <Text style={[styles.stripButtonText, styles.sendText]}>{T.spikes.referral.send}</Text>
            </Pressable>
          </View>
        ) : null}
        {waiting ? (
          // две кнопки — под строками: иначе строки зажаты в узкий столбец
          <View style={[styles.strip, v.canSendAway && !!sendAway && styles.stripTall]}>
            <View style={styles.stripText}>
              {/* ждёт кто-то срочнее (замечание владельца 24.10.2026) — отпустить и принять его, а не ждать */}
              {v.urgentWaiting ? <Text testID="visit-urgent" style={[styles.stripLine, styles.stripUrgent]}>{t.urgentWaiting}</Text> : null}
              {v.away ? <Text testID="visit-away" style={styles.stripLine}>{v.away}</Text> : null}
              {v.pending.length > 0 ? (
                <Text testID="visit-pending" numberOfLines={2} style={styles.stripLine}>{t.waiting(v.pending.map(p => t.pendingShort(p.name, p.at)).join('; '))}</Text>
              ) : null}
            </View>
            <View style={styles.stripButtons}>
              {v.canSendAway && sendAway ? (
                <Pressable testID="visit-send-away" accessibilityRole="button" accessibilityHint={t.sendAwayHint} onPress={sendAway}
                  style={({ pressed }) => [styles.stripButton, pressed && styles.pressed]}>
                  <Text style={styles.stripButtonText}>{t.sendAwayShort}</Text>
                </Pressable>
              ) : null}
              <Pressable testID="visit-wait" accessibilityRole="button" onPress={wait} style={({ pressed }) => [styles.stripButton, pressed && styles.pressed]}>
                <Text style={styles.stripButtonText}>{v.waitMinutes !== undefined ? t.waitFor(v.waitMinutes) : t.waitShort}</Text>
              </Pressable>
            </View>
          </View>
        ) : stepOut ? (
          <View style={styles.strip}>
            <Text style={[styles.stripText, styles.stripLine]}>{t.urgentWaiting}</Text>
            <Pressable testID="visit-step-out" accessibilityRole="button" accessibilityHint={t.stepOutHint} onPress={sendAway}
              style={({ pressed }) => [styles.stripButton, pressed && styles.pressed]}>
              <Text style={styles.stripButtonText}>{t.stepOut}</Text>
            </Pressable>
          </View>
        ) : null}
        {bottom}
      </View>

      <TermSheet term={term} onClose={() => setTerm(null)} label={t.whatIsIt} closeTitle={t.gotIt} />
    </Screen>
  );
}

/**
 * Шапка пациента — закреплена (0.6.0): портрет, кто он, кем работает, время и потраченное; сроки по рекомендации (часть
 * 37) — строкой: срочное видно с любой вкладки. Жалобы — со слов пациента, в две строки; касание раскрывает их целиком,
 * а у раскрытых — справка о каждой.
 */
function Head({ v, readOnly, open, onToggle, explain }: {
  v: VisitView; readOnly?: { note: string; portrait?: StaffPortrait }; open: boolean; onToggle: () => void; explain: (info: TermInfo) => void;
}) {
  const styles = useStyles();
  const t = T.spikes.patient;
  return (
    <View style={styles.head}>
      <View style={styles.row}>
        <Portrait seed={v.portrait.key} sex={v.portrait.sex} age={v.portrait.age} size={48} />
        <View style={styles.headText}>
          <Text style={styles.title}>{v.title}</Text>
          <Text style={styles.meta}>
            {/* кем работает — с регистратуры (0.5.10) */}
            {v.job ? <Text testID="visit-job">{v.job}</Text> : null}
            {v.job ? ' · ' : null}
            <Text testID="visit-clock" style={styles.mono}>{`${v.clock} · ${t.spentShort(v.minutesSpent, T.common.rub(v.money))}`}</Text>
          </Text>
        </View>
      </View>
      {/* срок по рекомендации, который ещё идёт, — справка: ЭКГ при боли в груди в первые 10 минут; сделанные — на «Карте» */}
      {v.targets?.map((x, i) => (x.done ? null : <Text key={i} testID={`visit-target-${i}`} style={styles.target}>{x.text}</Text>))}
      {/* приём ведёт нанятый врач — строкой во всю ширину, с его портретом (0.5.7) */}
      {readOnly ? (
        <View style={styles.colleague}>
          {readOnly.portrait ? <Portrait {...readOnly.portrait} size={32} /> : null}
          <View style={styles.headText}>
            <Text testID="visit-colleague" style={styles.meta}>{readOnly.note}</Text>
          </View>
        </View>
      ) : null}
      {v.complaints.length === 0 ? <Text testID="visit-checkup" style={styles.meta}>{t.checkup(v.portrait.sex === 'f')}</Text>
        : open ? (
          <View style={styles.complaints}>
            {v.complaints.map(c => (
              <Pressable key={c.f} testID={`complaint-${c.f}`} accessibilityRole="button" onPress={() => explain(findingInfo(c.f))} style={({ pressed }) => pressed && styles.pressed}>
                <Text style={styles.said}>{`«${c.text}»`}</Text>
              </Pressable>
            ))}
            <Pressable testID="visit-complaints" accessibilityRole="button" aria-expanded onPress={onToggle} hitSlop={8}>
              <Text style={styles.toggle}>{t.complaintsLess}</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable testID="visit-complaints" accessibilityRole="button" aria-expanded={false} accessibilityHint={t.complaintsMore} onPress={onToggle}
            style={({ pressed }) => pressed && styles.pressed}>
            <Text numberOfLines={2} style={styles.said}>{v.complaints.map(c => `«${c.text}»`).join(' · ')}</Text>
          </Pressable>
        )}
    </View>
  );
}

/** Выявил ли обследование хоть что-то: признак показан (в том числе ложно). */
const found = (g: ResultGroup) => g.lines.some((l: Line) => l.shown);

/**
 * Результаты одного обследования в «Известно». Раскрытое — все строки; свёрнутое — только то,
 * что нашли, и «ещё N без особенностей», касание раскрывает (отзыв на 0.0.37: меньше листать).
 */
function KnownGroup({ g, open, onToggle, explain, onLayout }: {
  g: ResultGroup; open: boolean; onToggle?: () => void; explain: (info: TermInfo) => void; onLayout?: (e: LayoutChangeEvent) => void;
}) {
  const styles = useStyles();
  const t = T.spikes.patient;
  const lines = open ? g.lines : g.lines.filter(l => l.shown);
  const hidden = g.lines.length - lines.length;
  return (
    <Animated.View entering={FadeInDown.duration(350)} testID={g.fresh ? 'visit-fresh' : undefined} onLayout={onLayout} style={[styles.group, g.fresh && styles.groupFresh]}>
      <View style={styles.groupHead}>
        <Text style={styles.groupTitle}>{`${g.name} · ${t.at(g.at)}`}</Text>
        {g.fresh && <Text style={styles.badge}>{t.fresh}</Text>}
      </View>
      {g.image && <ResultPicture image={g.image} />}
      <Chips>
        {lines.map((r, i) => <Chip key={`${r.f}${i}`} text={r.text} strong={r.shown} icon={lineMark(r)} onPress={() => explain(findingInfo(r.f))} />)}
        {hidden > 0 && onToggle && <Chip testID={`more-${g.exam}`} text={t.moreQuiet(hidden)} icon={{ icon: examIcon(g.exam), state: 'absent' }} onPress={onToggle} />}
        {open && !g.fresh && onToggle && found(g) && g.lines.some(l => !l.shown) && <Chip text={t.collapse} onPress={onToggle} />}
      </Chips>
    </Animated.View>
  );
}

const useStyles = makeStyles(t => ({
  // на широком экране — колонкой посередине, как остальные экраны
  page: { flex: 1, width: '100%', maxWidth: 640, alignSelf: 'center' },
  head: { gap: space.xs, paddingHorizontal: space.l, paddingVertical: space.s, backgroundColor: t.colors.card, borderBottomWidth: 1, borderBottomColor: t.colors.edge },
  row: { flexDirection: 'row', gap: space.m, alignItems: 'center' },
  headText: { flex: 1, gap: 2 },
  title: { fontFamily: t.fonts.title, fontSize: 17, lineHeight: 21, fontWeight: '700', color: t.colors.ink },
  meta: { fontSize: 13, lineHeight: 18, color: t.colors.muted },
  mono: { fontFamily: t.fonts.mono, color: t.shape.ruled ? t.colors.muted : t.colors.info },
  target: { fontSize: 13, lineHeight: 18, fontWeight: '700', color: t.colors.ink },
  colleague: { flexDirection: 'row', gap: space.s, alignItems: 'center' },
  complaints: { gap: 2 },
  said: { fontFamily: t.fonts.title, fontStyle: 'italic', fontSize: 15, lineHeight: 20, color: t.colors.ink },
  toggle: { fontSize: 13, lineHeight: 20, color: t.colors.accent, fontWeight: '700' },
  likely: {
    flexDirection: 'row', gap: space.s, alignItems: 'baseline', paddingHorizontal: space.l, paddingVertical: space.xs + 2,
    backgroundColor: t.colors.accentSoft, borderBottomWidth: 1, borderBottomColor: t.colors.edge,
  },
  likelyLabel: { fontSize: 13, fontWeight: '700', color: t.colors.accent },
  parts: { paddingHorizontal: space.l, paddingTop: space.s },
  likelyText: { flex: 1, fontSize: 13, lineHeight: 18, color: t.colors.ink },
  meanwhile: { gap: 2, paddingHorizontal: space.l, paddingVertical: space.xs + 2, backgroundColor: t.colors.fresh, borderBottomWidth: 1, borderBottomColor: t.colors.freshLine },
  meanwhileLabel: { fontWeight: '700' },
  footer: { paddingHorizontal: space.l, paddingVertical: space.s, borderTopWidth: 1, borderTopColor: t.colors.edge, backgroundColor: t.colors.bg },
  strip: {
    flexDirection: 'row', alignItems: 'center', gap: space.s, paddingLeft: space.l, paddingRight: space.s, paddingVertical: space.xs + 2,
    backgroundColor: t.colors.fresh, borderTopWidth: 1, borderTopColor: t.colors.freshLine,
  },
  stripTall: { flexDirection: 'column', alignItems: 'stretch' },
  stripText: { flexGrow: 1, flexShrink: 1, gap: 2 },
  stripLine: { fontSize: 13, lineHeight: 18, color: t.colors.ink },
  stripUrgent: { fontWeight: '700' },
  stripButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.xs },
  stripButton: {
    minHeight: 40, justifyContent: 'center', paddingHorizontal: space.m, borderRadius: t.shape.radius, borderWidth: 1.5,
    borderColor: t.colors.freshLine, backgroundColor: t.colors.card,
  },
  stripButtonText: { fontSize: 13, fontWeight: '700', color: t.colors.ink },
  // бланк направления: строки — столбцом; «Отправить» — главной кнопкой полосы
  form: { gap: space.s },
  orderBar: { backgroundColor: t.colors.accentSoft, borderTopColor: t.colors.accent },
  sendButton: { minWidth: 120, alignItems: 'center', backgroundColor: t.colors.accent, borderColor: t.colors.accent },
  sendText: { fontSize: 15, color: t.colors.onAccent },
  hint: { flexDirection: 'row', gap: space.s, alignItems: 'center' },
  label: { fontSize: 13, fontWeight: '700', letterSpacing: 1.2, color: t.colors.muted, textTransform: 'uppercase', marginTop: space.s },
  knownHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space.s },
  freshCount: { fontSize: 13, fontWeight: '700', color: t.colors.accent },
  group: { gap: space.s, paddingVertical: space.s, paddingHorizontal: space.s, borderRadius: t.shape.radius, borderWidth: 1, borderColor: 'transparent' },
  groupFresh: { backgroundColor: t.colors.fresh, borderColor: t.colors.freshLine },
  groupHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.s },
  groupTitle: { flex: 1, fontSize: 13, fontWeight: '600', color: t.colors.muted },
  badge: { fontSize: 12, fontWeight: '700', color: t.colors.onYellow, backgroundColor: t.colors.yellow, borderRadius: 10, paddingHorizontal: space.s, paddingVertical: 2, overflow: 'hidden' },
  chevron: { fontSize: 14, color: t.colors.muted },
  pressed: { opacity: 0.7 },
  quiet: { flexDirection: 'row', alignItems: 'center', gap: space.s, minHeight: touch, paddingHorizontal: space.s, borderRadius: t.shape.radius, backgroundColor: t.colors.chip },
  quietText: { flex: 1, fontSize: 13, color: t.colors.muted },
}));
