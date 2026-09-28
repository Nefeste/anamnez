// Карта пациента (03-game-design.md §5): жалобы, что известно, новое сверху, «Похоже на»,
// три действия — «Спросить», «Осмотреть», «Назначить». Решение — отдельный экран, кнопкой
// внизу. Общая для прототипа П4 и смены: вид и действия приходят снаружи.
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../text';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { buzz, play } from '@/audio/sounds';
import { T } from '@/i18n';
import { Portrait } from '@/render/Portrait';
import { examInfo, examsByAction, examTerm, findingInfo, type Line, type ResultGroup, type TermInfo, type VisitView } from '@/state/caseView';
import { Button, Card, Chip, Chips, H, P, Screen, Tabs } from '@/ui/components';
import { TermSheet } from '@/ui/TermSheet';
import { colors, radius, space } from '@/ui/theme';
import type { CaseActions, FooterAction } from './actions';
import { ResultPicture } from './ResultPicture';

type Tab = 'ask' | 'examine' | 'order';

/**
 * `readOnly` — приём ведёт нанятый врач (spec 2026-09-hired-doctors, часть 19): видно, что он
 * узнал, но действий и решения нет; внизу — своя кнопка («Забрать себе»).
 */
export function PatientCard({ view: v, actions, readOnly }: { view: VisitView; actions: CaseActions; readOnly?: { note: string; footer: FooterAction & { hint?: string } } }) {
  // вкладка привязана к пациенту: новый начинается с «Спросить»
  const [picked, setPicked] = useState<{ patient: number; tab: Tab }>({ patient: v.portrait.key, tab: 'ask' });
  const tab: Tab = picked.patient === v.portrait.key ? picked.tab : 'ask';
  const setTab = (next: Tab) => setPicked({ patient: v.portrait.key, tab: next });
  const [term, setTerm] = useState<TermInfo | null>(null);
  // что раскрыл игрок — у этого пациента; новый пациент начинается свёрнутым
  const [opened, setOpened] = useState<{ patient: number; keys: string[] }>({ patient: v.portrait.key, keys: [] });
  const openKeys = opened.patient === v.portrait.key ? opened.keys : [];
  const isOpen = (key: string) => openKeys.includes(key);
  const toggle = (key: string) => setOpened({ patient: v.portrait.key, keys: isOpen(key) ? openKeys.filter(k => k !== key) : [...openKeys, key] });
  // подсказка «нажмите, чтобы узнать» — пока игрок ни разу не открыл справку
  const [hinted, setHinted] = useState(false);
  const t = T.spikes.patient;
  const d = T.spikes.decision;
  const groups = examsByAction(v.portrait);
  // «Известно»: новое, то, где что-то нашли, и снимки — на виду; где ничего не нашли — одной строкой
  const loud = v.groups.filter(g => g.fresh || found(g) || g.image);
  const quiet = v.groups.filter(g => !loud.includes(g));

  useEffect(() => {
    if (v.meanwhile.length > 0) {
      const kind = v.urgent ? 'urgent' : 'ready';
      play(kind);
      buzz(kind);
    }
  }, [v.meanwhile, v.urgent]);

  // касание — вибрацией: звук касания на телефоне не понравился (отзыв на 0.0.2)
  const doExam = (id: string) => {
    buzz('tap');
    actions.act(id);
  };
  const explain = (info: TermInfo) => {
    setHinted(true);
    setTerm(info);
  };

  // внизу, под большим пальцем: до решения — «Решение», после — итог и разбор
  const footer = readOnly
    ? <Button testID={readOnly.footer.testID} title={readOnly.footer.title} hint={readOnly.footer.hint} onPress={readOnly.footer.run} />
    : v.decision
      ? <Button testID="visit-to-outcome" title={d.toOutcome} onPress={() => router.push(actions.routes.outcome)} />
      : <Button testID="visit-decide" title={`${d.open} ▶`} hint={v.draft.diagnosis ? d.diagnosis(v.draftDiagnosisName ?? '') : undefined} onPress={() => router.push(actions.routes.decision)} />;

  return (
    <Screen resetKey={v.portrait.key} footer={footer}>
      <Card>
        <View style={styles.row}>
          <Portrait seed={v.portrait.key} sex={v.portrait.sex} age={v.portrait.age} size={64} />
          <View style={styles.headText}>
            <H>{v.title}</H>
            <P muted testID="visit-clock">{`${t.clock(v.clock)} · ${t.spent(v.minutesSpent, T.common.rub(v.money))}`}</P>
            {v.returnNote ? <P testID="visit-return">{v.returnNote}</P> : null}
            {readOnly ? <P testID="visit-colleague">{readOnly.note}</P> : null}
            {v.payerNote ? <P muted testID="visit-payer">{v.payerNote}</P> : null}
          </View>
        </View>
        <Text style={styles.label}>{t.complaints}</Text>
        {v.complaints.length > 0
          ? <Chips>{v.complaints.map(c => <Chip key={c.f} testID={`complaint-${c.f}`} text={`«${c.text}»`} strong onPress={() => explain(findingInfo(c.f))} />)}</Chips>
          : <P muted testID="visit-checkup">{t.checkup(v.portrait.sex === 'f')}</P>}
      </Card>

      {v.meanwhile.length > 0 && (
        <Card style={styles.notice}>
          <Text style={styles.label}>{t.meanwhile}</Text>
          {v.meanwhile.map((m, i) => <P key={i} testID={`meanwhile-${i}`}>{m}</P>)}
        </Card>
      )}

      <Card>
        <View style={styles.knownHead}>
          <Text style={styles.label}>{t.known}</Text>
          {v.freshCount > 0 && <Text testID="visit-fresh-count" style={styles.freshCount}>{t.freshCount(v.freshCount)}</Text>}
        </View>
        {v.groups.length === 0 ? <P muted>{t.none}</P> : (
          <>
            {/* новые результаты — сверху, выделены и целиком; прежние — что нашли, остальное свёрнуто */}
            {loud.map(g => <KnownGroup key={g.key} g={g} open={g.fresh || isOpen(g.key)} onToggle={() => toggle(g.key)} explain={explain} />)}
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
        {v.pending.map((p, i) => <P key={i} muted>{t.pending(p.name, p.at)}</P>)}
        {v.pending.length > 0 && !v.decision && !readOnly && (
          <>
            <Button kind="plain" testID="visit-wait" title={t.wait} onPress={actions.waitForResults} />
            {v.canSendAway && actions.sendAway && <Button kind="plain" testID="visit-send-away" title={t.sendAway} hint={t.sendAwayHint} onPress={actions.sendAway} />}
          </>
        )}
        {!hinted && <P muted>{t.tapForHint}</P>}
      </Card>

      {readOnly ? null : v.decision ? (
        <Card>
          <H>{d.finished}</H>
          <P testID="visit-finished">{v.decision.outcome}</P>
        </Card>
      ) : (
        <>
          {v.hints.length > 0 && (
            <Card>
              <Text style={styles.label}>{t.likely}</Text>
              {v.hints.map(h => <P key={h.id} testID={`likely-${h.id}`}>{`${h.name} — ${t.similar(h.outOf10)}`}</P>)}
            </Card>
          )}
          {/* три действия — подписи вмещаются и на узком экране; решение — отдельным шагом внизу */}
          <Tabs<Tab>
            value={tab}
            onChange={setTab}
            items={[{ key: 'ask', title: t.ask }, { key: 'examine', title: t.examine }, { key: 'order', title: t.order }]}
          />
          <Card>
            {groups[tab].map(id => {
              const info = examInfo(id);
              // сделанное — с ответом на месте: не нужно листать вверх к «Известно» (отзыв на 0.0.37);
              // только что пришедшее — целиком, прежнее — строкой «что нашли», касание раскрывает
              if (v.done.includes(id)) {
                const g = v.groups.find(x => x.exam === id);
                const wait = v.pending.find(x => x.exam === id);
                const key = `done:${id}`;
                const open = !!g && (g.fresh || isOpen(key));
                const summary = g ? g.lines.filter(l => l.shown).map(l => l.text).join('; ') || t.nothingFound : wait ? t.readyAt(wait.at) : t.done;
                return (
                  <Animated.View key={id} entering={FadeInDown.duration(250)} testID={`done-${id}`} style={[styles.done, g?.fresh && styles.groupFresh]}>
                    <Pressable accessibilityRole="button" aria-expanded={open} accessibilityLabel={`${info.name}: ${open ? t.collapse : t.expand}`} disabled={!g || g.fresh}
                      onPress={() => toggle(key)} style={({ pressed }) => [styles.groupHead, pressed && styles.pressed]}>
                      <Text style={styles.groupTitle}>{`✓ ${info.name}`}</Text>
                      {g?.fresh ? <Text style={styles.badge}>{t.fresh}</Text> : g ? <Text style={styles.chevron}>{open ? '▴' : '▾'}</Text> : null}
                    </Pressable>
                    {open ? <Chips>{g!.lines.map((r, i) => <Chip key={`${r.f}${i}`} text={r.text} strong={r.shown} onPress={() => explain(findingInfo(r.f))} />)}</Chips>
                      : <Text numberOfLines={2} style={styles.summary}>{summary}</Text>}
                  </Animated.View>
                );
              }
              // своя больница: нет помещения, аппарата или человека — серым, с причиной
              const why = v.unavailable[id];
              return (
                <Button key={id} testID={`exam-${id}`} kind="plain" disabled={!!why} title={info.name} hint={why ?? t.cost(info.minutes, info.cost)}
                  onPress={() => doExam(id)} onInfo={() => explain(examTerm(id))} infoLabel={t.whatIsIt} />
              );
            })}
          </Card>
        </>
      )}

      <TermSheet term={term} onClose={() => setTerm(null)} label={t.whatIsIt} closeTitle={t.gotIt} />
    </Screen>
  );
}

/** Выявил ли обследование хоть что-то: признак показан (в том числе ложно). */
const found = (g: ResultGroup) => g.lines.some((l: Line) => l.shown);

/**
 * Результаты одного обследования в «Известно». Раскрытое — все строки; свёрнутое — только то,
 * что нашли, и «ещё N без особенностей», касание раскрывает (отзыв на 0.0.37: меньше листать).
 */
function KnownGroup({ g, open, onToggle, explain }: { g: ResultGroup; open: boolean; onToggle?: () => void; explain: (info: TermInfo) => void }) {
  const t = T.spikes.patient;
  const lines = open ? g.lines : g.lines.filter(l => l.shown);
  const hidden = g.lines.length - lines.length;
  return (
    <Animated.View entering={FadeInDown.duration(350)} testID={g.fresh ? 'visit-fresh' : undefined} style={[styles.group, g.fresh && styles.groupFresh]}>
      <View style={styles.groupHead}>
        <Text style={styles.groupTitle}>{`${g.name} · ${t.at(g.at)}`}</Text>
        {g.fresh && <Text style={styles.badge}>{t.fresh}</Text>}
      </View>
      {g.image && <ResultPicture image={g.image} />}
      <Chips>
        {lines.map((r, i) => <Chip key={`${r.f}${i}`} text={r.text} strong={r.shown} onPress={() => explain(findingInfo(r.f))} />)}
        {hidden > 0 && onToggle && <Chip testID={`more-${g.exam}`} text={t.moreQuiet(hidden)} onPress={onToggle} />}
        {open && !g.fresh && onToggle && found(g) && g.lines.some(l => !l.shown) && <Chip text={t.collapse} onPress={onToggle} />}
      </Chips>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.m, alignItems: 'center' },
  headText: { flex: 1, gap: 2 },
  label: { fontSize: 13, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', marginTop: space.s },
  notice: { backgroundColor: colors.accentSoft },
  knownHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space.s },
  freshCount: { fontSize: 13, fontWeight: '700', color: colors.accent },
  group: { gap: space.s, paddingVertical: space.s, paddingHorizontal: space.s, borderRadius: radius, borderWidth: 1, borderColor: 'transparent' },
  groupFresh: { backgroundColor: '#FFF6DE', borderColor: colors.yellow },
  groupHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.s },
  groupTitle: { flex: 1, fontSize: 13, fontWeight: '600', color: colors.muted },
  badge: { fontSize: 12, fontWeight: '700', color: '#fff', backgroundColor: colors.yellow, borderRadius: 10, paddingHorizontal: space.s, paddingVertical: 2, overflow: 'hidden' },
  done: { gap: space.xs, padding: space.m, borderRadius: radius, borderWidth: 1, borderColor: colors.line },
  summary: { fontSize: 14, color: colors.ink },
  chevron: { fontSize: 14, color: colors.muted },
  pressed: { opacity: 0.7 },
  quiet: { flexDirection: 'row', alignItems: 'center', gap: space.s, minHeight: 44, paddingHorizontal: space.s, borderRadius: radius, backgroundColor: '#EEF1F1' },
  quietText: { flex: 1, fontSize: 13, color: colors.muted },
});
