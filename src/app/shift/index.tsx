// Смена в амбулатории (spec 2026-09-first-shift): сверху — карта амбулатории (коснулись
// человека — под картой, кто это), под ней очередь с часами и скоростями, кто в кабинете,
// кто на обследованиях, что происходит; после закрытия дня — его итоги. Часы идут, только
// пока этот экран на виду и в кабинете никого (ADR 0005). Приглашённый идёт в кабинет, и
// его карта открывается, когда он вошёл.
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { buzz, play } from '@/audio/sounds';
import type { Difficulty, Triage } from '@/engine/shift/types';
import { T } from '@/i18n';
import { ClinicMap } from '@/render/map/ClinicMap';
import { CLINIC } from '@/state/clinicMap';
import {
  callPatient, closeDay, loadShift, nextDay, openCase, pauseClock, type QueueRow, type ShiftView, SPEEDS, type Speed, type SummaryView,
  saveNow, setSpeed, skipIdle, startShift, TICK_MS, tick, useShift, type WhoView,
} from '@/state/session';
import { CaseRow } from '@/ui/case/CaseRow';
import { Button, Card, Chip, Chips, H, P, Screen, Sheet, Tabs } from '@/ui/components';
import { DifficultyChoice } from '@/ui/difficulty';
import { colors, radius, space, touch } from '@/ui/theme';

export default function ShiftScreen() {
  const v = useShift();
  useEffect(() => {
    loadShift();
  }, []);

  if (v.status === 'idle' || v.status === 'loading') {
    return (
      <Screen>
        <Card>
          <P muted>{T.shift.loading}</P>
        </Card>
      </Screen>
    );
  }
  if (v.status === 'none') return <NewPractice />;
  return v.dayOpen ? <Queue v={v} /> : <Summary v={v} />;
}

/** Практики нет: что это и какая сложность (03-game-design.md §14); по умолчанию — «Студент». */
function NewPractice() {
  const [difficulty, setDifficulty] = useState<Difficulty>('student');
  return (
    <Screen footer={<Button testID="shift-start" title={T.shift.start} onPress={() => startShift(undefined, undefined, difficulty)} />}>
      <Card>
        <H>{T.shift.newTitle}</H>
        <P>{T.shift.newText}</P>
        <DifficultyChoice value={difficulty} onChange={setDifficulty} />
      </Card>
    </Screen>
  );
}

type SpeedKey = 'pause' | 'x1' | 'x2' | 'x4';
const speedKey = (s: Speed): SpeedKey => (s === 1 ? 'x1' : s === 2 ? 'x2' : 'x4');

/** Карта пациента открывается один раз, даже если он вошёл и игрок коснулся кнопки разом. */
let enteredAt = 0;
function openVisit() {
  const now = Date.now();
  if (now - enteredAt < 1000) return;
  enteredAt = now;
  router.push('/shift/patient');
}

function Queue({ v }: { v: ShiftView }) {
  const t = T.shift;
  const { width } = useWindowDimensions();
  const [focused, setFocused] = useState(true);
  // кого коснулись на карте; кого пригласили — он идёт в кабинет
  const [selected, setSelected] = useState<string>();
  const [entering, setEntering] = useState<string>();

  // часы — только пока экран на виду: поверх него карта пациента или разбор
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      const id = setInterval(() => {
        const notices = tick(TICK_MS);
        if (notices.some(n => n.kind === 'arrived' && n.triage === 'red')) {
          play('urgent');
          buzz('urgent');
        } else if (notices.some(n => n.kind === 'resultsReady')) {
          play('ready');
          buzz('ready');
        }
      }, TICK_MS);
      return () => {
        clearInterval(id);
        saveNow();
        setFocused(false);
        setEntering(undefined);
      };
    }, []),
  );

  const skip = () => {
    const notices = skipIdle();
    if (notices.some(n => n.kind === 'arrived' && n.triage === 'red')) {
      play('urgent');
      buzz('urgent');
    } else if (notices.some(n => n.kind === 'resultsReady' || n.kind === 'arrived')) {
      buzz('ready');
    }
  };

  // двойное касание не зовёт дважды: второй вызов не проходит — кабинет занят. Карта
  // пациента — когда он дошёл до кабинета (ClinicMap, onArrive) или по кнопке сразу
  const call = (id: string) => {
    buzz('tap');
    if (callPatient(id)) {
      setSelected(undefined);
      setEntering(id);
    }
  };
  const enter = () => {
    setEntering(undefined);
    openVisit();
  };

  const first = v.queue[0];
  const footer = v.inRoom
    ? <Button testID="shift-continue" title={`${entering === v.inRoom.id ? t.entering(v.inRoom.name) : t.continueVisit(v.inRoom.name)} ▶`} onPress={enter} />
    : first
      ? <Button testID="shift-call" title={`${t.call(first.name)} ▶`} hint={v.queue.length > 1 ? t.callHint : undefined} onPress={() => call(first.id)} />
      : v.allDone
        ? <Button testID="shift-close-day" title={t.closeDay} hint={t.closeDayHint(0)} onPress={closeDay} />
        : <Button testID="shift-skip" title={t.skip} hint={t.skipHint(v.away.length)} onPress={skip} />;

  const speed: SpeedKey = v.paused ? 'pause' : speedKey(v.speed);
  const onSpeed = (k: SpeedKey) => (k === 'pause' ? pauseClock() : setSpeed(SPEEDS.find(s => speedKey(s) === k) ?? 1));

  // люди — из вида смены (пересобирается с каждым ходом часов), а не из живого состояния:
  // вызов по изменяемому объекту смены React Compiler запомнил бы, и карта застыла бы
  const who = selected === undefined ? undefined : v.who[selected];
  const map = (
    <>
      <ClinicMap
        layout={CLINIC}
        people={v.people}
        width={Math.min(width, 640)}
        active={focused}
        label={t.map.label(v.queue.length, v.away.length, v.inRoom?.name)}
        selected={who ? selected : undefined}
        awaiting={entering}
        onSelect={setSelected}
        onArrive={enter}
      />
      {who && selected !== undefined ? <WhoStrip who={who} onCall={who.callable ? () => call(selected) : undefined} /> : null}
    </>
  );

  return (
    <Screen header={map} footer={footer}>
      <Card>
        <H>{`${t.day(v.day)} · `}<Text testID="shift-clock">{v.clock}</Text></H>
        <P muted testID="shift-counts">{t.counts(v.counts.seen, v.counts.waiting, v.counts.left)}</P>
        <Tabs<SpeedKey>
          value={speed}
          onChange={onSpeed}
          items={[{ key: 'pause', title: t.speed.pause }, { key: 'x1', title: t.speed.x1 }, { key: 'x2', title: t.speed.x2 }, { key: 'x4', title: t.speed.x4 }]}
        />
        {v.pauseReason ? <P testID="shift-pause-reason">{v.pauseReason}</P> : null}
        {v.restored ? <P>{t.restored}</P> : null}
        {v.afterHours && !v.allDone ? <P muted>{t.afterHours}</P> : null}
      </Card>

      {v.inRoom && (
        <Card style={styles.room}>
          <Text style={styles.label}>{t.inRoom}</Text>
          <P>{v.inRoom.name}</P>
        </Card>
      )}

      <Card>
        <Text style={styles.label}>{t.queue}</Text>
        {v.queue.length === 0 ? <P muted>{t.queueEmpty}</P> : v.queue.map(r => (
          <QueueItem key={r.id} r={r} disabled={v.inRoom !== undefined} onPress={() => call(r.id)} />
        ))}
      </Card>

      {v.away.length > 0 && (
        <Card>
          <Text style={styles.label}>{t.away}</Text>
          {v.away.map(a => <P key={a.id} testID={`away-${a.id}`}>{`${a.name} — ${t.awayReady(a.ready)}`}</P>)}
        </Card>
      )}

      {v.log.length > 0 && (
        <Card>
          <Text style={styles.label}>{t.log}</Text>
          {v.log.slice(0, 6).map(l => (
            <Text key={l.key} style={[styles.log, l.kind === 'red' && styles.logRed]}>{`${l.at}  ${l.text}`}</Text>
          ))}
        </Card>
      )}

      {v.afterHours && !v.allDone && (
        <Button kind="plain" testID="shift-close-day-early" title={t.closeDay} hint={t.closeDayHint(v.counts.unseen)} onPress={closeDay} />
      )}
    </Screen>
  );
}

const TRIAGE_COLOR: Record<Triage, string> = { red: colors.red, yellow: colors.yellow, green: colors.green };

/** Кого коснулись на карте: кто это и что делает; ждущего приёма можно пригласить. */
function WhoStrip({ who, onCall }: { who: WhoView; onCall?: () => void }) {
  return (
    <View testID="map-who" style={styles.who}>
      <View style={styles.itemHead}>
        <Text style={styles.itemName} numberOfLines={1}>{who.title}</Text>
        {who.triage ? <Text style={[styles.pill, styles.whoPill, { backgroundColor: TRIAGE_COLOR[who.triage] }]}>{T.shift.triage[who.triage]}</Text> : null}
      </View>
      {who.complaint ? <Text style={styles.itemText} numberOfLines={1}>{`«${who.complaint}»`}</Text> : null}
      <View style={styles.whoFoot}>
        <Text style={[styles.itemMeta, styles.whoDoing]}>{who.doing}</Text>
        {onCall ? (
          <Pressable testID="map-invite" accessibilityRole="button" onPress={onCall} style={({ pressed }) => [styles.invite, pressed && styles.pressed]}>
            <Text style={styles.inviteText}>{`${T.shift.map.invite} ▶`}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function QueueItem({ r, disabled, onPress }: { r: QueueRow; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      testID={`queue-${r.id}`}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.item, { borderLeftColor: TRIAGE_COLOR[r.triage] }, disabled && styles.itemDisabled, pressed && styles.pressed]}>
      <View style={styles.itemHead}>
        <Text style={styles.itemName}>{`${r.name}, ${r.age}`}</Text>
        <Text style={[styles.pill, { backgroundColor: TRIAGE_COLOR[r.triage] }]}>{T.shift.triage[r.triage]}</Text>
      </View>
      <Text style={styles.itemText}>{`«${r.complaint}»`}</Text>
      <Text style={styles.itemMeta}>{[...r.badges, r.waits].join(' · ')}</Text>
    </Pressable>
  );
}

function Summary({ v }: { v: ShiftView }) {
  const t = T.shift.summary;
  const [confirm, setConfirm] = useState(false);
  const s = v.summary;
  if (!s) return null;
  const open = (id: string) => {
    openCase(id);
    router.push('/shift/outcome');
  };
  return (
    <Screen footer={<Button testID="shift-next-day" title={t.nextDay} onPress={nextDay} />}>
      <Card>
        <H>{t.title(s.day)}</H>
        <P testID="summary-seen">{t.seen(s.seen, s.arrived)}</P>
        {s.left > 0 && <P>{t.left(s.left)}</P>}
        {s.unseen > 0 && <P>{t.unseen(s.unseen)}</P>}
        {s.seen > 0 && <P>{t.verdicts(s.correct, s.partly, s.wrong)}</P>}
        {s.confidence !== undefined && <P>{t.confidence(s.confidence)}</P>}
        {s.seen > 0 && <P>{t.money(T.common.rub(s.money), T.common.rub(s.rationalMoney))}</P>}
        <P>{t.returns(s.returnsPlanned, s.returnsToday)}</P>
        <P muted>{t.moneyNote}</P>
      </Card>

      {s.seen > 0 && <Grades s={s} />}

      <Card>
        <Text style={styles.label}>{t.cases}</Text>
        {s.cases.length === 0 ? <P muted>{t.noCases}</P> : s.cases.map(c => (
          <CaseRow key={c.id} testID={`case-${c.id}`} verdict={c.verdict} title={c.name} subtitle={c.diagnosis} grade={c.overall} onPress={() => open(c.id)} />
        ))}
      </Card>

      {s.news.length > 0 && (
        <Card>
          <Text style={styles.label}>{t.news}</Text>
          {s.news.map(n => <P key={n.id}>{n.text}</P>)}
        </Card>
      )}

      <Button kind="plain" testID="shift-restart" title={t.restart} onPress={() => setConfirm(true)} />
      <Sheet visible={confirm} onClose={() => setConfirm(false)} closeTitle={t.cancel} testID="restart-sheet">
        <P>{t.restartConfirm}</P>
        <Button testID="restart-yes" title={t.restartYes} onPress={() => {
          setConfirm(false);
          startShift();
        }} />
      </Sheet>
    </Screen>
  );
}

function Grades({ s }: { s: SummaryView }) {
  return (
    <Card>
      <Text style={styles.label}>{T.shift.summary.grades}</Text>
      <Chips>
        {(['A', 'B', 'C', 'D'] as const).map(g => <Chip key={g} text={`${g}: ${s.grades[g]}`} strong={s.grades[g] > 0} />)}
      </Chips>
    </Card>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 13, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', marginTop: space.s },
  room: { backgroundColor: colors.accentSoft },
  item: { borderLeftWidth: 5, borderRadius: radius, backgroundColor: colors.bg, paddingVertical: space.s, paddingHorizontal: space.m, gap: 2 },
  itemDisabled: { opacity: 0.6 },
  pressed: { opacity: 0.8 },
  itemHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.s },
  itemName: { flexShrink: 1, fontSize: 15, fontWeight: '600', color: colors.ink },
  itemText: { fontSize: 14, color: colors.ink },
  itemMeta: { fontSize: 13, color: colors.muted },
  pill: { fontSize: 12, fontWeight: '700', color: '#fff', borderRadius: 10, paddingHorizontal: space.s, paddingVertical: 2, overflow: 'hidden' },
  who: { gap: 2, width: '100%', maxWidth: 640, paddingHorizontal: space.l, paddingVertical: space.s, borderTopWidth: 1, borderTopColor: colors.line },
  whoPill: { flexShrink: 0 },
  whoFoot: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  whoDoing: { flex: 1 },
  invite: { minHeight: touch, justifyContent: 'center', paddingHorizontal: space.l, borderRadius: radius, backgroundColor: colors.accent },
  inviteText: { fontSize: 15, fontWeight: '700', color: '#fff' },
  log: { fontSize: 14, lineHeight: 20, color: colors.ink },
  logRed: { color: colors.red, fontWeight: '600' },
});
