// П4 · Карта пациента: приём одного пациента, время идёт делами (ADR 0005).
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { buzz, play } from '@/audio/sounds';
import type { Setting } from '@/content/types';
import { T } from '@/i18n';
import { Portrait } from '@/render/Portrait';
import {
  act, chooseDiagnosis, chooseSetting, conditionChoices, conditionTerm, examInfo, examTerm, examsByAction, findingInfo, finish, nextPatient,
  type TermInfo, toggleTreatment, treatmentTerm, useVisit, waitForResults,
} from '@/state/visit';
import { Button, Card, Chip, Chips, H, P, Screen, Sheet, Tabs } from '@/ui/components';
import { colors, radius, space } from '@/ui/theme';

type Tab = 'ask' | 'examine' | 'order' | 'decide';
const SETTINGS: Setting[] = ['home', 'ward', 'ambulance'];

export default function PatientSpike() {
  const v = useVisit();
  const [tab, setTab] = useState<Tab>('ask');
  const [term, setTerm] = useState<TermInfo | null>(null);
  // подсказка «нажмите, чтобы узнать» — пока игрок ни разу не открыл справку
  const [hinted, setHinted] = useState(false);
  const t = T.spikes.patient;
  const groups = examsByAction();

  useEffect(() => {
    if (v.meanwhile.length > 0) {
      play('ready');
      buzz('ready');
    }
  }, [v.meanwhile]);

  // касание — вибрацией: звук касания на телефоне не понравился (отзыв на 0.0.2)
  const doExam = (id: string) => {
    buzz('tap');
    act(id);
  };
  const explain = (info: TermInfo) => {
    setHinted(true);
    setTerm(info);
  };
  const next = () => {
    setTab('ask');
    nextPatient();
  };

  return (
    <Screen resetKey={v.portrait.key}>
      <Card>
        <View style={styles.row}>
          <Portrait seed={v.portrait.key} sex={v.portrait.sex} age={v.portrait.age} size={64} />
          <View style={styles.headText}>
            <H>{v.title}</H>
            <P muted testID="visit-clock">{`${t.clock(v.clock)} · ${t.spent(v.minutesSpent, T.common.rub(v.money))}`}</P>
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
          {v.meanwhile.map((m, i) => <P key={i}>{m}</P>)}
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
            <Chips>{g.lines.map((r, i) => <Chip key={`${r.f}${i}`} text={r.text} strong={r.shown} onPress={() => explain(findingInfo(r.f))} />)}</Chips>
          </Animated.View>
        ))}
        {v.pending.map((p, i) => <P key={i} muted>{t.pending(p.name, p.at)}</P>)}
        {v.pending.length > 0 && <Button kind="plain" testID="visit-wait" title={t.wait} onPress={waitForResults} />}
        {!hinted && <P muted>{t.tapForHint}</P>}
      </Card>

      {!v.decision && (
        <Card>
          <Text style={styles.label}>{t.likely}</Text>
          {v.hints.map(h => <P key={h.id}>{`${h.name} — ${t.outOf10(h.outOf10)}`}</P>)}
        </Card>
      )}

      {v.decision ? (
        <Card>
          <H>{v.decision.verdict === 'correct' ? t.correct : v.decision.verdict === 'partly' ? t.partly : t.wrong}</H>
          <P testID="visit-truth">{t.truth(v.decision.truthName)}</P>
          <P muted>{t.confidence(v.decision.outOf10)}</P>
          <Text style={styles.label}>{t.outcomeLabel}</Text>
          <P testID="visit-outcome">{v.decision.outcome}</P>
          <Text style={styles.label}>{t.gradesLabel}</Text>
          <View style={styles.grades}>
            {v.decision.grades.map(g => (
              <View key={g.key} style={styles.gradeCell}>
                <Text style={[styles.gradeLetter, gradeColor(g.grade)]}>{g.grade}</Text>
                <Text style={styles.gradeName}>{g.label}</Text>
              </View>
            ))}
            <View style={[styles.gradeCell, styles.gradeTotal]}>
              <Text testID="visit-overall" style={[styles.gradeLetter, gradeColor(v.decision.overall)]}>{v.decision.overall}</Text>
              <Text style={styles.gradeName}>{t.grade.overall}</Text>
            </View>
          </View>
          {v.decision.notes.length > 0 && (
            <>
              <Text style={styles.label}>{t.notesLabel}</Text>
              {v.decision.notes.map((n, i) => <P key={i}>{`• ${n}`}</P>)}
            </>
          )}
          <Text style={styles.label}>{t.yourPlan}</Text>
          {v.decision.plan.length === 0 ? <P muted>{t.noTreatment}</P> : v.decision.plan.map((x, i) => <P key={i}>{`${x.name} — ${x.role}`}</P>)}
          <P muted>{`${t.settingLabel}: ${v.decision.settingName}`}</P>
          <Text style={styles.label}>{t.rationalLabel}</Text>
          <P>{v.decision.rational}</P>
          {v.decision.idle.length > 0 && (
            <>
              <Text style={styles.label}>{t.idleLabel}</Text>
              <P>{v.decision.idle.join(', ')}</P>
            </>
          )}
          <Text style={styles.label}>{t.timelineLabel}</Text>
          {v.decision.timeline.map((x, i) => <P key={i} muted>{`${x.label}: ${x.truth} · ${x.chosen}`}</P>)}
          <Text style={styles.label}>{t.causes}</Text>
          {v.decision.causes.map((c, i) => <P key={i}>{`${c.finding} — ${c.cause}`}</P>)}
          <Text style={styles.label}>{t.pearls}</Text>
          {v.decision.pearls.map((p, i) => <P key={i}>{`• ${p}`}</P>)}
          <Button testID="visit-next" title={t.next} onPress={next} />
        </Card>
      ) : (
        <>
          <Tabs<Tab>
            value={tab}
            onChange={setTab}
            items={[{ key: 'ask', title: t.ask }, { key: 'examine', title: t.examine }, { key: 'order', title: t.order }, { key: 'decide', title: t.decide }]}
          />
          <Card>
            {tab === 'decide'
              ? (
                <>
                  <Text style={styles.label}>{t.diagnosisLabel}</Text>
                  {conditionChoices().map(c => (
                    <Button key={c.id} testID={`dx-${c.id}`} kind={v.draft.diagnosis === c.id ? 'primary' : 'plain'} title={c.name}
                      onPress={() => chooseDiagnosis(c.id)} onInfo={() => explain(conditionTerm(c.id))} infoLabel={t.whatIsIt} />
                  ))}
                  <Text style={styles.label}>{t.treatmentLabel}</Text>
                  {v.treatments.map(x => (
                    <Button key={x.id} testID={`tx-${x.id}`} kind={v.draft.treatments.includes(x.id) ? 'primary' : 'plain'} title={x.name} hint={x.warning}
                      onPress={() => toggleTreatment(x.id)} onInfo={() => explain(treatmentTerm(x.id))} infoLabel={t.whatIsIt} />
                  ))}
                  <Text style={styles.label}>{t.settingLabel}</Text>
                  {/* столбиком: в ряд «В стационар» рвётся посреди слова, а шрифт на телефоне бывает крупнее */}
                  {SETTINGS.map(k => (
                    <Button key={k} testID={`setting-${k}`} kind={v.draft.setting === k ? 'primary' : 'plain'} title={t.setting[k]} onPress={() => chooseSetting(k)} />
                  ))}
                  {/* отступ: выбранное место и «Завершить» — одного цвета */}
                  <View style={styles.finish}>
                    <Button testID="visit-finish" title={t.finish} hint={v.draft.diagnosis ? undefined : t.finishNeedsDx} disabled={!v.draft.diagnosis} onPress={finish} />
                  </View>
                </>
              )
              : groups[tab].map(id => {
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

      <Sheet visible={term !== null} onClose={() => setTerm(null)} closeTitle={t.gotIt} testID="term-sheet">
        {term && (
          <>
            <Text style={styles.label}>{t.whatIsIt}</Text>
            <H>{term.title}</H>
            {term.text.map((x, i) => <P key={i}>{x}</P>)}
            {term.list && (
              <>
                <Text style={styles.label}>{term.list.label}</Text>
                <P>{term.list.items.join(', ')}</P>
              </>
            )}
          </>
        )}
      </Sheet>
    </Screen>
  );
}

function gradeColor(g: string) {
  return { color: g === 'A' ? colors.green : g === 'B' ? colors.accent : g === 'C' ? colors.yellow : colors.red };
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
  grades: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  gradeCell: { width: '30%', minWidth: 90, alignItems: 'center', paddingVertical: space.s, borderRadius: radius, backgroundColor: colors.bg },
  gradeTotal: { backgroundColor: colors.accentSoft },
  gradeLetter: { fontSize: 24, fontWeight: '800' },
  gradeName: { fontSize: 12, color: colors.muted, textAlign: 'center' },
  finish: { marginTop: space.l },
  badge: { fontSize: 12, fontWeight: '700', color: '#fff', backgroundColor: colors.yellow, borderRadius: 10, paddingHorizontal: space.s, paddingVertical: 2, overflow: 'hidden' },
});
