// Итог приёма и разбор (03-game-design.md §5): что было на самом деле, что было дальше,
// оценки по категориям, затем разбор. Главная кнопка — внизу, под большим пальцем: у
// прототипа «Следующий пациент», у смены — к очереди или к итогам дня.
import { View } from 'react-native';
import { Text } from '../text';
import { db } from '@/content';
import { T } from '@/i18n';
import type { VisitView } from '@/state/caseView';
import { Button, Card, H, P, Screen } from '@/ui/components';
import { openArticle } from '@/ui/encyclopedia';
import { makeStyles, space, type Theme, useTheme } from '@/ui/theme';
import type { FooterAction } from './actions';

export function OutcomeScreen({ view, next, back }: { view: VisitView | undefined; next: FooterAction; back: FooterAction }) {
  const styles = useStyles();
  const theme = useTheme();
  const t = T.spikes.patient;
  const d = T.spikes.decision;
  const x = view?.decision;

  if (!x) {
    return (
      <Screen footer={<Button testID={back.testID} title={back.title} onPress={back.run} />}>
        <Card>
          <P muted>{d.noDecision}</P>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen footer={<Button testID={next.testID} title={next.title} onPress={next.run} />}>
      <Card>
        {view.byDoctor ? <P testID="visit-by-doctor">{view.byDoctor}</P> : null}
        <H>{x.verdict === 'correct' ? t.correct : x.verdict === 'partly' ? t.partly : t.wrong}</H>
        <P testID="visit-truth">{t.truth(x.truthName)}</P>
        <P muted>{view.byDoctor ? t.doctorConfidence(x.outOf10) : t.confidence(x.outOf10)}</P>
        <Text style={styles.label}>{t.outcomeLabel}</Text>
        <P testID="visit-outcome">{x.outcome}</P>
        {view.firstTry && <P muted testID="visit-first-try">{view.firstTry}</P>}
      </Card>

      {view.achievements && (
        <Card testID="visit-achievements">
          {view.achievements.map(a => <P key={a}>{T.profile.achievementLine(a)}</P>)}
        </Card>
      )}

      {view.payment && (
        <Card testID="visit-payment">
          <Text style={styles.label}>{T.sandbox.payment}</Text>
          {view.payment.map((line, i) => <P key={i} muted={i > 0}>{line}</P>)}
        </Card>
      )}

      <Card>
        <Text style={styles.label}>{t.gradesLabel}</Text>
        <View style={styles.grades}>
          {x.grades.map(g => (
            <View key={g.key} style={styles.gradeCell}>
              <Text style={[styles.gradeLetter, gradeColor(theme, g.grade)]}>{g.grade}</Text>
              <Text style={styles.gradeName}>{g.label}</Text>
            </View>
          ))}
          <View style={[styles.gradeCell, styles.gradeTotal]}>
            <Text testID="visit-overall" style={[styles.gradeLetter, gradeColor(theme, x.overall)]}>{x.overall}</Text>
            <Text style={styles.gradeName}>{t.grade.overall}</Text>
          </View>
        </View>
        {x.notes.length > 0 && (
          <>
            <Text style={styles.label}>{t.notesLabel}</Text>
            {x.notes.map((n, i) => <P key={i}>{`• ${n}`}</P>)}
          </>
        )}
        <Text style={styles.label}>{view.byDoctor ? t.doctorPlan : t.yourPlan}</Text>
        {x.plan.length === 0 ? <P muted>{t.noTreatment}</P> : x.plan.map((p, i) => <P key={i}>{`${p.name} — ${p.role}`}</P>)}
        <P muted>{`${t.settingLabel}: ${x.settingName}`}</P>
      </Card>

      <Card>
        <H>{d.reviewLabel}</H>
        <Text style={styles.label}>{t.rationalLabel}</Text>
        <P>{x.rational}</P>
        {x.idle.length > 0 && (
          <>
            <Text style={styles.label}>{t.idleLabel}</Text>
            <P>{x.idle.join(', ')}</P>
          </>
        )}
        <Text style={styles.label}>{view.byDoctor ? t.doctorTimeline : t.timelineLabel}</Text>
        {x.timeline.map((p, i) => <P key={i} muted>{`${p.label}: ${p.truth} · ${p.chosen}`}</P>)}
        <Text style={styles.label}>{t.causes}</Text>
        {x.causes.map((c, i) => <P key={i}>{`${c.finding} — ${c.cause}`}</P>)}
        <Text style={styles.label}>{t.pearls}</Text>
        {x.pearls.map((p, i) => <P key={i}>{`• ${p}`}</P>)}
        {/* разбор → энциклопедия: настоящая болезнь и, если ошиблись, та, что поставили */}
        <Button testID="visit-truth-article" kind="plain" title={T.encyclopedia.truthArticle(x.truthName)} onPress={() => openArticle(x.truth)} />
        {x.diagnosis !== x.truth && (
          <Button testID="visit-chosen-article" kind="plain" title={T.encyclopedia.truthArticle(db.conditions[x.diagnosis].name.ru)} onPress={() => openArticle(x.diagnosis)} />
        )}
      </Card>
    </Screen>
  );
}

/** Цвет буквы оценки: A — зелёный, B — синий, C — жёлтый, D — красный. */
export function gradeColor(t: Theme, g: string) {
  return { color: g === 'A' ? t.colors.green : g === 'B' ? t.colors.info : g === 'C' ? t.colors.yellowText : t.colors.red };
}

const useStyles = makeStyles(t => ({
  label: { fontSize: 13, fontWeight: '700', letterSpacing: 1.2, color: t.colors.muted, textTransform: 'uppercase', marginTop: space.s },
  grades: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  gradeCell: { width: '30%', minWidth: 90, alignItems: 'center', paddingVertical: space.s, borderRadius: t.shape.radius, backgroundColor: t.colors.bg },
  gradeTotal: { backgroundColor: t.colors.accentSoft },
  gradeLetter: { fontSize: 24, fontWeight: '800' },
  gradeName: { fontSize: 12, color: t.colors.muted, textAlign: 'center' },
}));
