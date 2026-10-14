// Дифференциальный ряд игрока (FR-DX-7, spec 2026-10-differential, 0.5.8; 03-game-design.md §5 «Гипотезы»): болезни,
// которые подозревает врач, по порядку добавления. Карточка гипотезы — что за неё и против, что типичное не проверено и
// чем подтвердить; уверенность — по уровню сложности (§14): у «Врача» её нет. Добавить — из «Похоже на» или поиском по
// болезням больницы; из карточки — сразу к решению с этим диагнозом.
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { T } from '@/i18n';
import type { HypothesisView, VisitView } from '@/state/caseView';
import { matchesQuery } from '@/state/encyclopedia';
import { Button, Card, H, P, Sheet } from '@/ui/components';
import { makeStyles, space, touch } from '@/ui/theme';
import { Text, TextInput } from '../text';
import type { CaseActions } from './actions';

/** Строка ряда: уверенность (если уровень её показывает) и сколько доводов за и против. */
function rowHint(h: HypothesisView): string {
  const t = T.spikes.differential;
  return [h.outOf10 !== undefined ? t.outOf10(h.outOf10) : undefined, t.count(h.pro.length, h.con.length)].filter(Boolean).join(' · ');
}

function Lines({ title, lines, testID }: { title: string; lines: readonly string[]; testID: string }) {
  const styles = useStyles();
  return (
    <View testID={testID}>
      <Text style={styles.label}>{title}</Text>
      {lines.length === 0 ? <P muted>{T.spikes.differential.none}</P> : lines.map(l => <P key={l}>{l}</P>)}
    </View>
  );
}

function HypothesisCard({ h, actions, close }: { h: HypothesisView; actions: CaseActions; close: () => void }) {
  const t = T.spikes.differential;
  const styles = useStyles();
  return (
    <>
      <H>{h.name}</H>
      {h.outOf10 !== undefined ? <P muted testID="hyp-confidence">{t.outOf10(h.outOf10)}</P> : null}
      <Lines title={t.proTitle} lines={h.pro} testID="hyp-pro" />
      <Lines title={t.conTitle} lines={h.con} testID="hyp-con" />
      <Lines title={t.uncheckedTitle} lines={h.unchecked} testID="hyp-unchecked" />
      <View testID="hyp-confirm">
        <Text style={styles.label}>{t.confirmTitle}</Text>
        {h.clinical ? <P>{t.clinical}</P> : h.confirm.map(x => <P key={x.name}>{x.done ? `${x.name} — ${t.done}` : x.name}</P>)}
      </View>
      <Button testID="hyp-diagnose" title={t.diagnose} onPress={() => {
        actions.chooseDiagnosis(h.id);
        close();
        router.push(actions.routes.decision);
      }} />
      <Button testID="hyp-remove" kind="plain" title={t.remove} onPress={() => {
        actions.toggleHypothesis(h.id);
        close();
      }} />
    </>
  );
}

export function Differential({ v, actions }: { v: VisitView; actions: CaseActions }) {
  const t = T.spikes.differential;
  const styles = useStyles();
  const [open, setOpen] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const card = v.differential.find(h => h.id === open);
  const inRow = new Set(v.differential.map(h => h.id));
  const groups = v.diagnoses
    .map(g => ({ ...g, items: g.items.filter(c => matchesQuery(query, c.name)) }))
    .filter(g => g.items.length > 0);
  const stopAdding = () => {
    setAdding(false);
    setQuery('');
  };
  return (
    <Card testID="differential">
      <Text style={styles.label}>{t.title}</Text>
      {v.differential.length === 0 ? <P muted testID="differential-empty">{t.empty}</P> : null}
      {v.differential.map(h => (
        <Button key={h.id} testID={`hyp-${h.id}`} kind="plain" title={h.name} hint={rowHint(h)} onPress={() => setOpen(h.id)} />
      ))}
      <Button testID="hyp-add" kind="plain" title={t.add} onPress={() => setAdding(true)} />

      <Sheet visible={!!card} onClose={() => setOpen(undefined)} closeTitle={t.close} testID="hyp-sheet">
        {card ? <HypothesisCard h={card} actions={actions} close={() => setOpen(undefined)} /> : null}
      </Sheet>
      <Sheet visible={adding} onClose={stopAdding} closeTitle={t.close} testID="hyp-add-sheet">
        <H>{t.addTitle}</H>
        <TextInput testID="hyp-search" value={query} onChangeText={setQuery} placeholder={t.search} autoCorrect={false} returnKeyType="search" style={styles.search} />
        {groups.length === 0 ? <P muted>{t.nothing}</P> : null}
        {groups.map(g => (
          <View key={g.key}>
            <Text style={styles.label}>{g.title}</Text>
            {g.items.map(c => (
              <Button key={c.id} testID={`hyp-pick-${c.id}`} kind={inRow.has(c.id) ? 'primary' : 'plain'} title={c.name}
                hint={inRow.has(c.id) ? t.inRow : undefined} onPress={() => actions.toggleHypothesis(c.id)} />
            ))}
          </View>
        ))}
      </Sheet>
    </Card>
  );
}

const useStyles = makeStyles(t => ({
  label: { fontSize: 13, fontWeight: '700', letterSpacing: 1.2, color: t.colors.muted, textTransform: 'uppercase', marginTop: space.s },
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
