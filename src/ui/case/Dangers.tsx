// Подсказка «Практиканту» (часть 94, spec 2026-10-trainee-hint, вопрос 57): опасные причины жалобы на доске гипотез —
// не исключённые и чем проверить их важное, ниже — исключённые. Считает их вид приёма (`dangerHint`) — по базе и тому, что
// врач уже узнал; правды здесь нет: есть ли болезнь у пациента, подсказка не говорит.
import { View } from 'react-native';
import { T } from '@/i18n';
import { type DangerHint, examTerm, type TermInfo, type VisitView } from '@/state/caseView';
import { Card, Chip, Chips, P } from '@/ui/components';
import { conditionIcon, examIcon } from '@/ui/itemIcons';
import { RowIcon } from '@/ui/RowIcon';
import { makeStyles, space } from '@/ui/theme';
import { Text } from '../text';
import type { CaseActions } from './actions';

/** Подсказка строкой — полосой под «Похоже на» и в карточке: сколько важного проверено и сколько опасного не исключено. */
export function dangerLine(d: DangerHint): string {
  const t = T.spikes.patient;
  return d.causes.length === 0 ? t.dangerNone : t.danger(d.checked, d.important, d.causes.filter(x => !x.excluded).length, d.causes.length);
}

/** Карточка доски гипотез: опасная причина — в ряд гипотез, как из «Похоже на»; касание обследования — что это. */
export function Dangers({ v, actions, explain }: { v: VisitView; actions: CaseActions; explain: (info: TermInfo) => void }) {
  const t = T.spikes.patient;
  const styles = useStyles();
  const d = v.danger;
  if (!d) return null;
  const open = d.causes.filter(x => !x.excluded);
  const gone = d.causes.filter(x => x.excluded);
  const inRow = new Set(v.differential.map(h => h.id));
  return (
    <Card testID="danger-card">
      <Text style={styles.label}>{t.dangerTitle}</Text>
      <P testID="danger-line">{dangerLine(d)}</P>
      {d.causes.length > 0 ? <P muted>{t.dangerAbout}</P> : null}
      {open.length > 0 ? <Text style={styles.label}>{t.dangerOpen(open.length)}</Text> : null}
      {open.map(x => (
        <View key={x.id} testID={`danger-${x.id}`} style={styles.cause}>
          <View style={styles.row}>
            <RowIcon icon={conditionIcon(x.id)} state="neutral" size={26} />
            <View style={styles.name}><P>{x.name}</P></View>
            <Chip testID={`danger-add-${x.id}`} strong={inRow.has(x.id)} text={inRow.has(x.id) ? T.spikes.differential.inRow : T.spikes.differential.toRow}
              onPress={() => actions.toggleHypothesis(x.id)} />
          </View>
          {x.check.length > 0 ? (
            <>
              <P muted>{t.dangerCheck}</P>
              <Chips>
                {x.check.map(e => (
                  <Chip key={e.exam} testID={`danger-check-${e.exam}`} text={e.name} icon={{ icon: examIcon(e.exam), state: 'unknown' }} onPress={() => explain(examTerm(e.exam))} />
                ))}
              </Chips>
            </>
          ) : <P muted testID={`danger-checked-${x.id}`}>{t.dangerChecked}</P>}
        </View>
      ))}
      {gone.length > 0 ? <P muted testID="danger-excluded">{t.dangerExcluded(gone.length, gone.map(x => x.name).join(', '))}</P> : null}
    </Card>
  );
}

const useStyles = makeStyles(t => ({
  label: { fontSize: 13, fontWeight: '700', letterSpacing: 1.2, color: t.colors.muted, textTransform: 'uppercase', marginTop: space.s },
  cause: { gap: space.xs, paddingVertical: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  name: { flex: 1 },
}));
