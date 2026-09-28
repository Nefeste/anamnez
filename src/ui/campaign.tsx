// Глава кампании (spec 2026-09-campaign): название и место, письма наставника и главврача,
// задания с ходом. Между сменами — над своей больницей; касание письма — лист с портретом.
// В первую смену главы — подсказки наставника листом поверх приёма.
import { useState } from 'react';
import { View } from 'react-native';
import { T } from '@/i18n';
import { Portrait } from '@/render/Portrait';
import { type CampaignView, type MissionView, readLetter, seenTip, tipsOff, useTip } from '@/state/session';
import type { TipScreen } from '@/state/tips';
import { Button, Card, H, P, Sheet } from './components';
import { Text } from './text';
import { makeStyles, space } from './theme';

/** Первые слова письма — подпись под именем в списке. */
const opening = (text: string) => (text.length > 60 ? `${text.slice(0, 60).replace(/\s+\S*$/, '')}…` : text);

export function ChapterCard({ c }: { c: CampaignView }) {
  const styles = useStyles();
  const t = T.campaign;
  const [open, setOpen] = useState<string>();
  const letter = c.letters.find(l => l.id === open);
  const read = (id: string) => {
    setOpen(id);
    readLetter(id);
  };
  return (
    <>
      <Card testID="chapter">
        <H>{c.title}</H>
        <P muted testID="chapter-day">{`${c.place} · ${t.day(c.day)}`}</P>
        {c.complete && <P testID="chapter-complete">{t.complete}</P>}
        <Text style={styles.label}>{t.letters}</Text>
        {c.letters.length === 0 && <P muted>{t.noLetters}</P>}
        {c.letters.map(l => (
          <Button
            key={l.id}
            testID={`letter-${l.id}`}
            kind="plain"
            title={l.read ? l.from : `● ${l.from}`}
            hint={`${t.letterDay(l.day)}${l.read ? '' : ` · ${t.unread}`} · ${opening(l.text)}`}
            onPress={() => read(l.id)}
          />
        ))}
        <Text style={styles.label}>{t.main}</Text>
        {c.missions.filter(m => m.main).map(m => <Mission key={m.id} m={m} />)}
        {c.missions.some(m => !m.main) && <Text style={styles.label}>{t.optional}</Text>}
        {c.missions.filter(m => !m.main).map(m => <Mission key={m.id} m={m} />)}
      </Card>
      <Sheet visible={!!letter} onClose={() => setOpen(undefined)} closeTitle={t.close} testID="letter-sheet">
        {letter && (
          <>
            <View style={styles.head}>
              <Portrait seed={letter.portrait.seed} sex={letter.portrait.sex} age={letter.portrait.age} size={64} />
              <View style={styles.headText}>
                <H>{letter.from}</H>
                <P muted>{letter.role}</P>
              </View>
            </View>
            <P testID="letter-text">{letter.text}</P>
          </>
        )}
      </Sheet>
    </>
  );
}

/**
 * Подсказка наставника поверх экрана приёма: по одной, «Понятно» внизу, под пальцем. В первой
 * за карьеру — ещё «Без подсказок».
 */
export function MentorTip({ screen }: { screen: TipScreen }) {
  const styles = useStyles();
  const t = T.campaign;
  const tip = useTip(screen);
  return (
    <Sheet visible={!!tip} onClose={() => tip && seenTip(tip.id, screen)} closeTitle={t.tipGotIt} testID="tip-sheet">
      {tip && (
        <>
          <View style={styles.head}>
            <Portrait seed={tip.portrait.seed} sex={tip.portrait.sex} age={tip.portrait.age} size={48} />
            <View style={styles.headText}>
              <H>{tip.title}</H>
              <P muted>{t.tipFrom(tip.from)}</P>
            </View>
          </View>
          <P testID="tip-text">{tip.text}</P>
          {tip.first && <Button testID="tip-off" kind="plain" title={t.tipsOff} hint={t.tipsOffHint} onPress={tipsOff} />}
        </>
      )}
    </Sheet>
  );
}

function Mission({ m }: { m: MissionView }) {
  const styles = useStyles();
  return (
    <View testID={`mission-${m.id}`} style={styles.mission}>
      <Text style={[styles.mark, m.done !== undefined && styles.markDone]}>{m.done !== undefined ? '✓' : '○'}</Text>
      <View style={styles.missionText}>
        <Text style={styles.missionTitle}>{m.text}</Text>
        <Text style={styles.missionMeta}>{m.progress}</Text>
      </View>
    </View>
  );
}

const useStyles = makeStyles(t => ({
  label: { fontSize: 13, fontWeight: '700', letterSpacing: 1.2, color: t.colors.muted, textTransform: 'uppercase', marginTop: space.s },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  headText: { flex: 1, gap: 2 },
  mission: { flexDirection: 'row', gap: space.s, alignItems: 'flex-start', paddingVertical: 2 },
  mark: { width: 20, fontSize: 16, lineHeight: 22, color: t.colors.muted },
  markDone: { color: t.colors.green, fontWeight: '700' },
  missionText: { flex: 1, gap: 1 },
  missionTitle: { fontSize: 15, lineHeight: 21, color: t.colors.ink },
  missionMeta: { fontSize: 13, lineHeight: 18, color: t.colors.muted },
}));
