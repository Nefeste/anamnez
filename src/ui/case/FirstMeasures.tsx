// Первые меры у скорой (spec 2026-10-first-measures, часть 95): монитор у койки и кнопки мер — в листе передачи и в карте
// больного, пока он лежит в смотровой приёмного. Делает медсестра смотровой; данная мера — флажок с временем. В карте, на
// «Карте», — коротко (`compact`): строка монитора и «Первые меры», а кнопки — в листе по касанию.
import { Fragment, useState } from 'react';
import { View } from 'react-native';
import type { Id } from '@/content/types';
import { T } from '@/i18n';
import type { FirstMeasuresView } from '@/state/caseView';
import { Button, Sheet } from '@/ui/components';
import { makeStyles, space } from '@/ui/theme';
import { Text } from '../text';

export function FirstMeasures({ v, onGive, testID = 'measures', compact }: {
  v: FirstMeasuresView; onGive?: (tx: Id) => void; testID?: string; compact?: boolean;
}) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const t = T.shift.ambulance;
  if (compact) {
    const given = v.buttons.filter(b => b.state !== 'give').map(b => `${b.name}: ${b.note}`);
    const worse = v.code === true || v.lines.some(l => l.worse);
    return (
      <View testID={testID} style={styles.box}>
        <Text testID={`${testID}-monitor`} style={styles.line}>
          <Text style={styles.inline}>{v.title}</Text>
          {v.lines.map((l, i) => (
            <Fragment key={i}>
              {i > 0 ? ' · ' : '  '}
              <Text style={l.worse && styles.worse}>{l.text}</Text>
            </Fragment>
          ))}
        </Text>
        {v.code ? <Text testID={`${testID}-code`} style={[styles.line, styles.worse]}>{t.code}</Text> : null}
        <Button testID={`${testID}-open`} kind="plain" lamp={worse} title={t.measures}
          hint={given.length > 0 ? given.join(' · ') : (v.hints?.[0] ?? t.measuresAll)} onPress={() => setOpen(true)} />
        <Sheet visible={open} onClose={() => setOpen(false)} closeTitle={t.measuresClose} testID={`${testID}-sheet`}>
          <FirstMeasures v={v} onGive={onGive} testID={`${testID}-full`} />
        </Sheet>
      </View>
    );
  }
  return (
    <View testID={testID} style={styles.box}>
      <Text style={styles.label}>{v.title}</Text>
      {v.code ? <Text testID={`${testID}-code`} style={[styles.line, styles.worse]}>{t.code}</Text> : null}
      <View style={styles.lines}>
        {v.lines.map((l, i) => (
          <Text key={i} testID={`${testID}-line-${i}`} style={[styles.line, l.worse && styles.worse]}>{l.text}</Text>
        ))}
      </View>
      {v.hints ? (
        <View testID={`${testID}-hints`}>
          <Text style={styles.label}>{t.hintLabel}</Text>
          {v.hints.map(h => <Text key={h} style={styles.line}>{h}</Text>)}
        </View>
      ) : null}
      <Text style={styles.label}>{t.measures}</Text>
      <Text style={styles.muted}>{t.measuresHint}</Text>
      {v.buttons.map(b => (
        <Button key={b.tx} testID={`measure-${b.tx}`} kind="plain" title={b.state === 'give' ? b.name : `✓ ${b.name}`} hint={b.note} checked={b.state !== 'give'}
          disabled={b.state !== 'give' || v.code === true || !onGive} onPress={() => onGive?.(b.tx)} />
      ))}
    </View>
  );
}

const useStyles = makeStyles(t => ({
  box: { gap: space.xs },
  label: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', color: t.colors.muted, marginTop: space.xs },
  inline: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', color: t.colors.muted },
  lines: { flexDirection: 'row', flexWrap: 'wrap', columnGap: space.s },
  line: { fontSize: 15, lineHeight: 21, color: t.colors.ink },
  worse: { color: t.colors.danger, fontWeight: '700' },
  muted: { fontSize: 13, lineHeight: 18, color: t.colors.muted },
}));
