// Глава кампании (spec 2026-09-campaign): название и место, письма наставника и главврача,
// задания с ходом. Между сменами — над своей больницей; касание письма — лист с портретом.
// В первую смену главы — подсказки наставника листом поверх приёма.
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { T } from '@/i18n';
import { Portrait } from '@/render/Portrait';
import { type CampaignView, type CareerNumbers, type MissionView, moveToNextChapter, readLetter, seenTip, tipsOff, useTip } from '@/state/session';
import type { TipScreen } from '@/state/tips';
import { StatTile } from './charts';
import { Button, Card, H, P, Sheet } from './components';
import { Icon } from './Icon';
import { AWARD_ICON } from './iconShapes';
import { Text } from './text';
import { makeStyles, space, useTheme } from './theme';

/** Первые слова письма — подпись под именем в списке. */
const opening = (text: string) => (text.length > 60 ? `${text.slice(0, 60).replace(/\s+\S*$/, '')}…` : text);

/**
 * Карьера пройдена (часть 99, ответ владельца на вопрос 66): медаль, путь по главам, числа всей карьеры плитками и что
 * дальше — «Работать дальше» сворачивает карточку, «В меню» — в меню.
 */
export function CareerDone({ career, after, onFold }: { career: CareerNumbers; after: string; onFold: () => void }) {
  const styles = useStyles();
  const theme = useTheme();
  const t = T.campaign;
  const n = T.shift.summary;
  const correct = career.seen > 0 ? n.pct(Math.round((100 * career.correct) / career.seen)) : n.none;
  return (
    <View testID="career-done" style={styles.done}>
      <View style={styles.doneHead}>
        <Icon shape={AWARD_ICON} size={30} color={theme.colors.green} />
        <Text accessibilityRole="header" style={styles.doneTitle}>{t.careerTitle}</Text>
      </View>
      <P muted testID="career-path">{t.careerPath(career.path)}</P>
      <View style={styles.tiles}>
        <StatTile testID="career-days" label={t.careerDays} value={String(career.days)} />
        <StatTile testID="career-seen" label={t.careerSeen} value={String(career.seen)} />
        <StatTile label={t.careerCorrect} value={correct} />
        <StatTile label={t.careerChapters} value={n.of(career.chapters, career.chapters)} />
      </View>
      <P testID="chapter-complete">{after}</P>
      <Button testID="career-on" title={t.careerOn} onPress={onFold} />
      <Button testID="career-menu" kind="plain" title={t.careerMenu} onPress={() => router.replace('/')} />
    </View>
  );
}

/** `careerShown` — экран уже показал «Карьера пройдена» наверху (итоги дня): здесь — строкой. */
export function ChapterCard({ c, careerShown }: { c: CampaignView; careerShown?: boolean }) {
  const styles = useStyles();
  const theme = useTheme();
  const t = T.campaign;
  const [open, setOpen] = useState<string>();
  const [move, setMove] = useState(false);
  // «Работать дальше» (часть 99): большая карточка карьеры сворачивается в строку; не в вечер завершения — строкой сразу
  const [folded, setFolded] = useState(!c.career?.fresh || careerShown === true);
  const letter = c.letters.find(l => l.id === open);
  const next = c.next;
  const read = (id: string) => {
    setOpen(id);
    readLetter(id);
  };
  return (
    <>
      {/* карьера пройдена (часть 99, spec 2026-10-publish-ready) — числами, пока не свернули */}
      {c.career && c.after && !folded && <CareerDone career={c.career} after={c.after} onFold={() => setFolded(true)} />}
      {/* глава пройдена (spec 2026-10-premium-polish) — своей карточкой над главой */}
      {c.after && (!c.career || folded) && (
        <View testID="chapter-done" style={styles.done}>
          <View style={styles.doneHead}>
            <Icon shape={AWARD_ICON} size={26} color={theme.colors.green} />
            <Text accessibilityRole="header" style={styles.doneTitle}>{c.career ? t.careerTitle : t.completeTitle}</Text>
          </View>
          <P testID="chapter-complete">{c.after}</P>
        </View>
      )}
      <Card testID="chapter">
        <H>{c.title}</H>
        <P muted testID="chapter-day">{`${c.place} · ${t.day(c.day)}`}</P>
        {next && (
          <Button
            testID="chapter-next"
            title={next.move}
            hint={next.ready ? `${next.title} · ${next.place}` : t.moveHint}
            disabled={!next.ready}
            onPress={() => setMove(true)}
          />
        )}
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
      {/* переход в следующую главу (spec 2026-09-chapter-2, часть 34): что останется, что будет новым */}
      <Sheet visible={move && !!next} onClose={() => setMove(false)} closeTitle={t.cancel} testID="chapter-next-sheet">
        {next && (
          <>
            <H>{t.moveTitle(next.move)}</H>
            <P muted>{`${next.title} · ${next.place}`}</P>
            <P testID="chapter-next-text">{next.text}</P>
            <Button
              testID="chapter-next-yes"
              title={t.move}
              onPress={() => {
                setMove(false);
                moveToNextChapter();
              }}
            />
          </>
        )}
      </Sheet>
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
  // «Глава пройдена»: карточка мягкого цвета выделения с отметкой
  done: { backgroundColor: t.colors.accentSoft, borderRadius: t.shape.card, borderWidth: 1, borderColor: t.colors.accent, padding: space.l, gap: space.s },
  doneHead: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  doneTitle: { fontFamily: t.fonts.title, fontSize: 21, lineHeight: 26, fontWeight: '700', color: t.colors.ink },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  headText: { flex: 1, gap: 2 },
  mission: { flexDirection: 'row', gap: space.s, alignItems: 'flex-start', paddingVertical: 2 },
  mark: { width: 20, fontSize: 16, lineHeight: 22, color: t.colors.muted },
  markDone: { color: t.colors.green, fontWeight: '700' },
  missionText: { flex: 1, gap: 1 },
  missionTitle: { fontSize: 15, lineHeight: 21, color: t.colors.ink },
  missionMeta: { fontSize: 13, lineHeight: 18, color: t.colors.muted },
}));
