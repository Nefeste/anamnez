// Решение по пациенту — отдельный экран в два шага (03-game-design.md §5): сначала диагноз,
// потом лечение и место. На одной вкладке с осмотром это было тесно (отзыв на 0.0.5).
// Выбор — черновик в state/visit: можно вернуться к приёму, дообследовать и продолжить.
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import type { Setting } from '@/content/types';
import { T } from '@/i18n';
import {
  chooseDiagnosis, chooseSetting, conditionTerm, diagnosisGroups, finish, type TermInfo, toggleTreatment, treatmentTerm, useVisit,
} from '@/state/visit';
import { Button, Card, Chip, Chips, H, P, Screen } from '@/ui/components';
import { TermSheet } from '@/ui/TermSheet';
import { colors, space } from '@/ui/theme';

type Step = 'diagnosis' | 'plan';
const SETTINGS: Setting[] = ['home', 'ward', 'ambulance'];

export default function Decision() {
  const v = useVisit();
  const router = useRouter();
  const [step, setStep] = useState<Step>('diagnosis');
  const [term, setTerm] = useState<TermInfo | null>(null);
  const t = T.spikes.patient;
  const d = T.spikes.decision;

  if (v.decision) {
    return (
      <Screen footer={<Button testID="decision-to-outcome" title={d.toOutcome} onPress={() => router.replace('/spikes/outcome')} />}>
        <Card>
          <H>{d.finished}</H>
          <P>{v.decision.outcome}</P>
        </Card>
      </Screen>
    );
  }

  const done = () => {
    finish();
    router.replace('/spikes/outcome');
  };

  const footer = step === 'diagnosis'
    ? <Button testID="decision-to-plan" title={d.toPlan} hint={v.draft.diagnosis ? undefined : d.needDiagnosis} disabled={!v.draft.diagnosis} onPress={() => setStep('plan')} />
    : <Button testID="visit-finish" title={t.finish} hint={d.summary(v.draft.treatments.length, t.setting[v.draft.setting])} onPress={done} />;

  return (
    <Screen resetKey={step} footer={footer}>
      <Card>
        <Text style={styles.label}>{step === 'diagnosis' ? d.stepDiagnosis : d.stepPlan}</Text>
        <H>{v.title}</H>
        {step === 'plan' && (
          <>
            <P testID="decision-diagnosis">{d.diagnosis(v.draftDiagnosisName ?? '')}</P>
            <Button kind="plain" testID="decision-change" title={d.change} onPress={() => setStep('diagnosis')} />
          </>
        )}
      </Card>

      {step === 'diagnosis' ? (
        <>
          <Card>
            <Text style={styles.label}>{d.likely}</Text>
            <Chips>
              {v.hints.map(h => (
                <Chip key={h.id} testID={`hint-${h.id}`} strong={v.draft.diagnosis === h.id} text={`${h.name} · ${t.outOf10(h.outOf10)}`} onPress={() => chooseDiagnosis(h.id)} />
              ))}
            </Chips>
          </Card>
          {diagnosisGroups().map(g => (
            <Card key={g.key}>
              <Text style={styles.label}>{g.title}</Text>
              {g.items.map(c => (
                <Button key={c.id} testID={`dx-${c.id}`} kind={v.draft.diagnosis === c.id ? 'primary' : 'plain'} title={c.name}
                  onPress={() => chooseDiagnosis(c.id)} onInfo={() => setTerm(conditionTerm(c.id))} infoLabel={t.whatIsIt} />
              ))}
            </Card>
          ))}
        </>
      ) : (
        <>
          {v.treatmentGroups.map(g => (
            <Card key={g.key}>
              <Text style={styles.label}>{g.title}</Text>
              {g.items.map(x => (
                <Button key={x.id} testID={`tx-${x.id}`} kind={v.draft.treatments.includes(x.id) ? 'primary' : 'plain'} title={x.name} hint={x.warning}
                  onPress={() => toggleTreatment(x.id)} onInfo={() => setTerm(treatmentTerm(x.id))} infoLabel={t.whatIsIt} />
              ))}
            </Card>
          ))}
          <Card>
            <Text style={styles.label}>{t.settingLabel}</Text>
            {/* столбиком: в ряд «В стационар» рвётся посреди слова, а шрифт на телефоне бывает крупнее */}
            {SETTINGS.map(k => (
              <Button key={k} testID={`setting-${k}`} kind={v.draft.setting === k ? 'primary' : 'plain'} title={t.setting[k]} onPress={() => chooseSetting(k)} />
            ))}
          </Card>
        </>
      )}

      <TermSheet term={term} onClose={() => setTerm(null)} label={t.whatIsIt} closeTitle={t.gotIt} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 13, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', marginTop: space.s },
});
