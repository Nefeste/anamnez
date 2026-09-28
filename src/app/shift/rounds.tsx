// Смена · обход (spec 2026-09-chapter-2, часть 26): лежащие в палатах — сутки в стационаре и
// обычный срок, как идёт болезнь, витальные по суткам, лечение; выписать, сменить лечение,
// перевести. Выписанный рано вернётся хуже, лишние сутки — койка занята.
import { router } from 'expo-router';
import { Text } from '@/ui/text';
import { T } from '@/i18n';
import { dischargePatient, transferPatient, useRounds } from '@/state/session';
import { Button, Card, H, P, Screen } from '@/ui/components';
import { makeStyles, space } from '@/ui/theme';

export default function Rounds() {
  const cards = useRounds();
  const styles = useStyles();
  const t = T.shift.ward;
  return (
    <Screen>
      {cards.length === 0 ? (
        <Card>
          <P testID="rounds-empty">{t.empty}</P>
        </Card>
      ) : null}
      {cards.map(c => (
        <Card key={c.id} testID={`round-${c.id}`}>
          <H>{c.title}</H>
          <P>{c.diagnosis}</P>
          <P muted>{c.day}</P>
          <Text testID={`round-state-${c.id}`} style={[styles.state, c.state === 'worse' || c.state === 'reaction' ? styles.bad : c.state === 'ready' ? styles.good : null]}>
            {c.stateText}
            {c.readyHint ? ` · ${c.readyHint}` : ''}
          </Text>
          {c.vitals.map(v => (
            <Text key={v.label} style={styles.vital}>{`${v.label}: ${v.values}`}</Text>
          ))}
          <P muted>{t.treatments(c.treatments)}</P>
          <Button testID={`round-discharge-${c.id}`} title={t.discharge} onPress={() => dischargePatient(c.id)} />
          <Button testID={`round-replan-${c.id}`} kind="plain" title={t.replan} onPress={() => router.push({ pathname: '/shift/replan', params: { id: c.id } })} />
          <Button testID={`round-transfer-${c.id}`} kind="plain" title={t.transfer} onPress={() => transferPatient(c.id)} />
        </Card>
      ))}
    </Screen>
  );
}

const useStyles = makeStyles(t => ({
  state: { fontSize: 15, fontWeight: '700', color: t.colors.ink, marginTop: space.xs },
  bad: { color: t.colors.red },
  good: { color: t.colors.green },
  vital: { fontFamily: t.fonts.mono, fontSize: 13, lineHeight: 19, color: t.colors.ink, marginTop: space.xs },
}));
