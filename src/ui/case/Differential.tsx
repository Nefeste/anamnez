// Дифференциальный ряд игрока (FR-DX-7, spec 2026-10-differential, 0.5.8; 09-game-design.md §5 «Гипотезы»): болезни,
// которые подозревает врач, по порядку добавления. Карточка гипотезы — что за неё и против, что типичное не проверено и
// чем подтвердить; уверенность — по уровню сложности (§14): у «Врача» её нет. Добавить — из «Похоже на» или поиском по
// болезням больницы; из карточки — сразу к решению с этим диагнозом; «Обновить гипотезы» (часть 105) убирает из ряда то,
// чего больше нет в «Похоже на». У доводов — значки признаков (0.6.8, вопрос 49):
// что есть — красным, чего нет — синим, что не проверено — серым пунктиром с «?»; у гипотез ряда — система органов.
import { router } from 'expo-router';
import { type ReactNode, useState } from 'react';
import { View } from 'react-native';
import { T } from '@/i18n';
import { type Evidence, type HypothesisView, staleHypotheses, type VisitView } from '@/state/caseView';
import { matchesQuery } from '@/state/encyclopedia';
import { Button, Card, H, P, Sheet } from '@/ui/components';
import { conditionIcon, examIcon, findingIcon } from '@/ui/itemIcons';
import { RowIcon } from '@/ui/RowIcon';
import { makeStyles, space, touch } from '@/ui/theme';
import { Text, TextInput } from '../text';
import type { CaseActions } from './actions';

/** Строка ряда: уверенность (если уровень её показывает) и сколько доводов за и против. */
function rowHint(h: HypothesisView): string {
  const t = T.spikes.differential;
  return [h.outOf10 !== undefined ? t.outOf10(h.outOf10) : h.word, t.count(h.pro.length, h.con.length)].filter(Boolean).join(' · ');
}

/** Довод строкой со значком признака: значок — сверху строки, длинный довод переносится рядом с ним. */
function Line({ children, icon }: { children: string; icon: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={styles.line}>
      {icon}
      <View style={styles.lineText}><P>{children}</P></View>
    </View>
  );
}

function Lines({ title, lines, testID }: { title: string; lines: readonly Evidence[]; testID: string }) {
  const styles = useStyles();
  return (
    <View testID={testID} style={styles.lines}>
      <Text style={styles.label}>{title}</Text>
      {lines.length === 0 ? <P muted>{T.spikes.differential.none}</P> : lines.map(l => (
        <Line key={l.text} icon={<RowIcon icon={findingIcon(l.f)} state={l.state} size={22} testID={`ic-${l.state}`} />}>{l.text}</Line>
      ))}
    </View>
  );
}

function HypothesisCard({ h, actions, close }: { h: HypothesisView; actions: CaseActions; close: () => void }) {
  const t = T.spikes.differential;
  const styles = useStyles();
  return (
    <>
      <H>{h.name}</H>
      {h.outOf10 !== undefined || h.word ? <P muted testID="hyp-confidence">{h.outOf10 !== undefined ? t.outOf10(h.outOf10) : h.word}</P> : null}
      <Lines title={t.proTitle} lines={h.pro} testID="hyp-pro" />
      <Lines title={t.conTitle} lines={h.con} testID="hyp-con" />
      <Lines title={t.uncheckedTitle} lines={h.unchecked} testID="hyp-unchecked" />
      <View testID="hyp-confirm" style={styles.lines}>
        <Text style={styles.label}>{t.confirmTitle}</Text>
        {h.clinical ? <P>{t.clinical}</P> : h.confirm.map(x => (
          <Line key={x.name} icon={<RowIcon icon={examIcon(x.exam)} state={x.state} size={22} testID={`ic-${x.state}`} />}>
            {x.done ? `${x.name} — ${t.done}` : x.name}
          </Line>
        ))}
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
  // «Обновить гипотезы» (часть 105): что выпало из «Похоже на» — убрать разом; есть что убирать — кнопка видна
  const stale = staleHypotheses(v);
  const staleNames = v.differential.filter(h => stale.includes(h.id)).map(h => h.name).join(', ');
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
        <Button key={h.id} testID={`hyp-${h.id}`} kind="plain" title={h.name} hint={rowHint(h)} onPress={() => setOpen(h.id)}
          picture={<RowIcon icon={conditionIcon(h.id)} state="neutral" size={30} />} />
      ))}
      {stale.length > 0 ? (
        <Button testID="hyp-refresh" kind="plain" title={t.refresh} hint={t.refreshHint(staleNames)}
          onPress={() => stale.forEach(id => actions.toggleHypothesis(id))} />
      ) : null}
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
  lines: { gap: space.xs },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: space.s },
  lineText: { flex: 1 },
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
