// П4 · Карта пациента: приём одного пациента, время идёт делами (ADR 0005).
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { buzz, play } from '@/audio/sounds';
import { T } from '@/i18n';
import { Portrait } from '@/render/Portrait';
import { act, conditionChoices, diagnose, examInfo, examsByAction, nextPatient, useVisit, waitForResults } from '@/state/visit';
import { Button, Card, Chip, Chips, H, P, Screen, Tabs } from '@/ui/components';
import { colors, space } from '@/ui/theme';

type Tab = 'ask' | 'examine' | 'order' | 'decide';

export default function PatientSpike() {
  const v = useVisit();
  const [tab, setTab] = useState<Tab>('ask');
  const t = T.spikes.patient;
  const groups = examsByAction();

  useEffect(() => {
    if (v.meanwhile.length > 0) {
      play('ready');
      buzz('ready');
    }
  }, [v.meanwhile]);

  const doExam = (id: string) => {
    play('tap');
    act(id);
  };

  return (
    <Screen>
      <Card>
        <View style={styles.row}>
          <Portrait seed={v.portrait.key} sex={v.portrait.sex} age={v.portrait.age} size={64} />
          <View style={styles.headText}>
            <H>{v.title}</H>
            <P muted testID="visit-clock">{`${t.clock(v.clock)} · ${t.spent(v.minutesSpent, T.common.rub(v.money))}`}</P>
          </View>
        </View>
        <Text style={styles.label}>{t.complaints}</Text>
        <Chips>{v.complaints.map(c => <Chip key={c.f} text={`«${c.text}»`} strong />)}</Chips>
      </Card>

      {v.meanwhile.length > 0 && (
        <Card style={styles.notice}>
          <Text style={styles.label}>{t.meanwhile}</Text>
          {v.meanwhile.map((m, i) => <P key={i}>{m}</P>)}
        </Card>
      )}

      <Card>
        <Text style={styles.label}>{t.known}</Text>
        {v.results.length === 0 ? <P muted>{t.none}</P> : (
          <Chips>{v.results.map((r, i) => <Chip key={`${r.f}${i}`} text={r.text} strong={r.shown} />)}</Chips>
        )}
        {v.pending.map((p, i) => <P key={i} muted>{t.pending(p.name, p.at)}</P>)}
        {v.pending.length > 0 && <Button kind="plain" testID="visit-wait" title={t.wait} onPress={waitForResults} />}
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
          <Text style={styles.label}>{t.causes}</Text>
          {v.decision.causes.map((c, i) => <P key={i}>{`${c.finding} — ${c.cause}`}</P>)}
          <Text style={styles.label}>{t.pearls}</Text>
          {v.decision.pearls.map((p, i) => <P key={i}>{`• ${p}`}</P>)}
          <Button testID="visit-next" title={t.next} onPress={nextPatient} />
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
              ? (<><P muted>{t.choose}</P>{conditionChoices().map(c => <Button key={c.id} testID={`dx-${c.id}`} kind="plain" title={c.name} onPress={() => diagnose(c.id)} />)}</>)
              : groups[tab].map(id => {
                const info = examInfo(id);
                const done = v.done.includes(id);
                return <Button key={id} testID={`exam-${id}`} kind="plain" disabled={done} title={info.name} hint={done ? t.done : t.cost(info.minutes, info.cost)} onPress={() => doExam(id)} />;
              })}
          </Card>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.m, alignItems: 'center' },
  headText: { flex: 1, gap: 2 },
  label: { fontSize: 13, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', marginTop: space.s },
  notice: { backgroundColor: colors.accentSoft },
});
