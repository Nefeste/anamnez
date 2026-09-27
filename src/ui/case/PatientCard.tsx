// Карта пациента (03-game-design.md §5): жалобы, что известно, новое сверху, «Похоже на»,
// три действия — «Спросить», «Осмотреть», «Назначить». Решение — отдельный экран, кнопкой
// внизу. Общая для прототипа П4 и смены: вид и действия приходят снаружи.
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { buzz, play } from '@/audio/sounds';
import { T } from '@/i18n';
import { Portrait } from '@/render/Portrait';
import { examInfo, examsByAction, examTerm, findingInfo, type TermInfo, type VisitView } from '@/state/caseView';
import { Button, Card, Chip, Chips, H, P, Screen, Tabs } from '@/ui/components';
import { TermSheet } from '@/ui/TermSheet';
import { colors, radius, space } from '@/ui/theme';
import type { CaseActions } from './actions';
import { ResultPicture } from './ResultPicture';

type Tab = 'ask' | 'examine' | 'order';

export function PatientCard({ view: v, actions }: { view: VisitView; actions: CaseActions }) {
  // вкладка привязана к пациенту: новый начинается с «Спросить»
  const [picked, setPicked] = useState<{ patient: number; tab: Tab }>({ patient: v.portrait.key, tab: 'ask' });
  const tab: Tab = picked.patient === v.portrait.key ? picked.tab : 'ask';
  const setTab = (next: Tab) => setPicked({ patient: v.portrait.key, tab: next });
  const [term, setTerm] = useState<TermInfo | null>(null);
  // подсказка «нажмите, чтобы узнать» — пока игрок ни разу не открыл справку
  const [hinted, setHinted] = useState(false);
  const t = T.spikes.patient;
  const d = T.spikes.decision;
  const groups = examsByAction();

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
  const footer = v.decision
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
        {v.groups.length === 0 ? <P muted>{t.none}</P> : v.groups.map(g => (
          // новые результаты — сверху, выделены и появляются с движением
          <Animated.View key={g.key} entering={FadeInDown.duration(350)} testID={g.fresh ? 'visit-fresh' : undefined} style={[styles.group, g.fresh && styles.groupFresh]}>
            <View style={styles.groupHead}>
              <Text style={styles.groupTitle}>{`${g.name} · ${t.at(g.at)}`}</Text>
              {g.fresh && <Text style={styles.badge}>{t.fresh}</Text>}
            </View>
            {g.image && <ResultPicture image={g.image} />}
            <Chips>{g.lines.map((r, i) => <Chip key={`${r.f}${i}`} text={r.text} strong={r.shown} onPress={() => explain(findingInfo(r.f))} />)}</Chips>
          </Animated.View>
        ))}
        {v.pending.map((p, i) => <P key={i} muted>{t.pending(p.name, p.at)}</P>)}
        {v.pending.length > 0 && !v.decision && (
          <>
            <Button kind="plain" testID="visit-wait" title={t.wait} onPress={actions.waitForResults} />
            {v.canSendAway && actions.sendAway && <Button kind="plain" testID="visit-send-away" title={t.sendAway} hint={t.sendAwayHint} onPress={actions.sendAway} />}
          </>
        )}
        {!hinted && <P muted>{t.tapForHint}</P>}
      </Card>

      {v.decision ? (
        <Card>
          <H>{d.finished}</H>
          <P testID="visit-finished">{v.decision.outcome}</P>
        </Card>
      ) : (
        <>
          <Card>
            <Text style={styles.label}>{t.likely}</Text>
            {v.hints.map(h => <P key={h.id}>{`${h.name} — ${t.outOf10(h.outOf10)}`}</P>)}
          </Card>
          {/* три действия — подписи вмещаются и на узком экране; решение — отдельным шагом внизу */}
          <Tabs<Tab>
            value={tab}
            onChange={setTab}
            items={[{ key: 'ask', title: t.ask }, { key: 'examine', title: t.examine }, { key: 'order', title: t.order }]}
          />
          <Card>
            {groups[tab].map(id => {
              const info = examInfo(id);
              const done = v.done.includes(id);
              return (
                <Button key={id} testID={`exam-${id}`} kind="plain" disabled={done} title={info.name} hint={done ? t.done : t.cost(info.minutes, info.cost)}
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
});
