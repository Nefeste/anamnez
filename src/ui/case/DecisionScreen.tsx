// Решение по пациенту — отдельный экран в два шага (09-game-design.md §5): сначала диагноз,
// потом лечение и место. На одной вкладке с осмотром это было тесно (отзыв на 0.0.5).
// Выбор — черновик приёма: можно вернуться, дообследовать и продолжить. Лечение — листом назначений (вопросы 34 и 45,
// 0.6.0): сверху — выбор при поставленном диагнозе, остальное — группами, свёрнуто, с поиском по названию; галочки, как в
// бланке направления; место лечения — внизу листа.
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { Text, TextInput } from '../text';
import { T } from '@/i18n';
import { conditionTerm, type TermInfo, treatmentTerm, type VisitView } from '@/state/caseView';
import { matchesQuery } from '@/state/encyclopedia';
import { Button, Card, Chip, Chips, H, P, Screen } from '@/ui/components';
import { Icon } from '@/ui/Icon';
import { SYSTEM_ICONS } from '@/ui/iconShapes';
import { TermSheet } from '@/ui/TermSheet';
import { makeStyles, space, touch, useTheme } from '@/ui/theme';
import type { CaseActions } from './actions';
import { CheckRow, SectionHead } from './FormRow';

type Step = 'diagnosis' | 'plan';

export function DecisionScreen({ view: v, actions }: { view: VisitView; actions: CaseActions }) {
  const styles = useStyles();
  const theme = useTheme();
  const [step, setStep] = useState<Step>('diagnosis');
  const [term, setTerm] = useState<TermInfo | null>(null);
  // лист назначений: раскрытые группы («Выбор при этом диагнозе» — раскрыт, пока его не свернули) и поиск
  const [opened, setOpened] = useState<string[]>([]);
  const isOpen = (key: string) => opened.includes(key) !== (key === 'suggested');
  const toggle = (key: string) => setOpened(opened.includes(key) ? opened.filter(k => k !== key) : [...opened, key]);
  const [query, setQuery] = useState('');
  const t = T.spikes.patient;
  const d = T.spikes.decision;

  if (v.decision) {
    return (
      <Screen footer={<Button testID="decision-to-outcome" title={d.toOutcome} onPress={() => router.replace(actions.routes.outcome)} />}>
        <Card>
          <H>{d.finished}</H>
          <P>{v.decision.outcome}</P>
        </Card>
      </Screen>
    );
  }

  const done = () => {
    actions.finish();
    router.replace(actions.routes.outcome);
  };

  const top = new Set(v.suggested.map(x => x.id));
  const rest = v.treatmentGroups.map(g => ({ ...g, items: g.items.filter(x => !top.has(x.id)) })).filter(g => g.items.length > 0);
  const found = query.trim() ? v.treatments.filter(x => matchesQuery(query, x.name)) : undefined;
  const chosen = (items: VisitView['treatments']) => items.filter(x => v.draft.treatments.includes(x.id)).length;
  // строка листа — с галочкой; противопоказание, о котором врач знает, и почему здесь не назначить — под названием
  const txRow = (x: VisitView['treatments'][number]) => (
    <CheckRow key={x.id} testID={`tx-${x.id}`} title={x.name} hint={x.warning} on={v.draft.treatments.includes(x.id)}
      disabled={x.disabled && !v.draft.treatments.includes(x.id)} onPress={() => actions.toggleTreatment(x.id)}
      onInfo={() => setTerm(treatmentTerm(x.id))} infoLabel={t.whatIsIt} indent={!found} />
  );

  const footer = step === 'diagnosis'
    ? <Button testID="decision-to-plan" title={d.toPlan} hint={v.draft.diagnosis ? undefined : d.needDiagnosis} disabled={!v.draft.diagnosis} onPress={() => setStep('plan')} />
    : <Button testID="visit-finish" title={t.finish} hint={d.summary(v.draft.treatments.length, v.settings.find(o => o.key === v.draft.setting)?.title ?? t.setting[v.draft.setting])} onPress={done} />;

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
          {/* дифференциальный ряд игрока (spec 2026-10-differential) — первым: из него и выбирают */}
          {v.differential.length > 0 && (
            <Card testID="decision-row">
              <Text style={styles.label}>{T.spikes.differential.fromRow}</Text>
              <Chips>
                {v.differential.map(h => (
                  <Chip key={h.id} testID={`row-${h.id}`} strong={v.draft.diagnosis === h.id}
                    text={h.outOf10 !== undefined ? `${h.name} · ${t.outOf10(h.outOf10)}` : h.word ? `${h.name} · ${h.word}` : h.name}
                    onPress={() => actions.chooseDiagnosis(h.id)} />
                ))}
              </Chips>
            </Card>
          )}
          {v.hints.length > 0 && (
            <Card>
              <Text style={styles.label}>{d.likely}</Text>
              <Chips>
                {v.hints.map(h => (
                  <Chip key={h.id} testID={`hint-${h.id}`} strong={v.draft.diagnosis === h.id} text={`${h.name} · ${h.word ?? t.outOf10(h.outOf10)}`} onPress={() => actions.chooseDiagnosis(h.id)} />
                ))}
              </Chips>
            </Card>
          )}
          {v.diagnoses.map(g => (
            <Card key={g.key}>
              {/* группа — со значком, как плитки «Своих больных» в настройках (0.5.20) */}
              <View style={styles.groupHead}>
                <Icon shape={SYSTEM_ICONS[g.key]} size={22} color={theme.colors.muted} />
                <Text style={[styles.label, styles.groupLabel]}>{g.title}</Text>
              </View>
              {g.items.map(c => (
                <Button key={c.id} testID={`dx-${c.id}`} kind={v.draft.diagnosis === c.id ? 'primary' : 'plain'} title={c.name}
                  onPress={() => actions.chooseDiagnosis(c.id)} onInfo={() => setTerm(conditionTerm(c.id))} infoLabel={t.whatIsIt} />
              ))}
            </Card>
          ))}
        </>
      ) : (
        <>
          <TextInput testID="tx-search" value={query} onChangeText={setQuery} placeholder={d.search} autoCorrect={false} returnKeyType="search"
            clearButtonMode="while-editing" style={styles.search} />
          {found ? (found.length > 0 ? found.map(txRow) : <P muted>{d.nothing}</P>) : (
            <>
              {v.suggested.length > 0 && (
                <View testID="tx-suggested" style={styles.sheet}>
                  <SectionHead testID="tx-sec-suggested" title={d.suggested} state={d.sheetState(chosen(v.suggested), v.suggested.length)}
                    marked={chosen(v.suggested) > 0} open={isOpen('suggested')} onPress={() => toggle('suggested')} />
                  {isOpen('suggested') && (
                    <>
                      <P muted>{d.suggestedNote}</P>
                      {v.suggested.map(txRow)}
                    </>
                  )}
                </View>
              )}
              {rest.map(g => (
                <View key={g.key} style={styles.sheet}>
                  <SectionHead testID={`tx-sec-${g.key}`} title={g.title} state={d.sheetState(chosen(g.items), g.items.length)} marked={chosen(g.items) > 0}
                    open={isOpen(g.key)} onPress={() => toggle(g.key)} />
                  {isOpen(g.key) && g.items.map(txRow)}
                </View>
              ))}
            </>
          )}
          {/* место лечения — внизу листа, одно из нескольких; столбиком: в ряд «В стационар» рвётся посреди слова */}
          <View style={styles.sheet}>
            <Text style={styles.label}>{t.settingLabel}</Text>
            {v.settings.map(o => (
              <CheckRow key={o.key} radio testID={`setting-${o.key}`} title={o.title} hint={o.hint} on={v.draft.setting === o.key} disabled={o.disabled}
                onPress={() => actions.chooseSetting(o.key)} />
            ))}
          </View>
        </>
      )}

      <TermSheet term={term} onClose={() => setTerm(null)} label={t.whatIsIt} closeTitle={t.gotIt} />
    </Screen>
  );
}

const useStyles = makeStyles(t => ({
  label: { fontSize: 13, fontWeight: '700', letterSpacing: 1.2, color: t.colors.muted, textTransform: 'uppercase', marginTop: space.s },
  sheet: { gap: space.s },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: space.s, marginTop: space.s },
  groupLabel: { flex: 1, marginTop: 0 },
  search: {
    minHeight: touch,
    backgroundColor: t.colors.card,
    borderRadius: t.shape.radius,
    borderWidth: 1,
    borderColor: t.colors.line,
    paddingHorizontal: space.l,
    fontSize: 16,
    color: t.colors.ink,
  },
}));
