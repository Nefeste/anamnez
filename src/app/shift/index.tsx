// Смена в амбулатории (spec 2026-09-first-shift): сверху — карта амбулатории (коснулись
// человека — под картой, кто это), под ней очередь с часами и скоростями, кто в кабинете,
// кто на обследованиях, что происходит; после закрытия дня — его итоги. Часы идут, только
// пока этот экран на виду и в кабинете никого (ADR 0005). Приглашённый идёт в кабинет, и
// его карта открывается, когда он вошёл.
import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, useWindowDimensions, View } from 'react-native';
import { Text } from '@/ui/text';
import { buzz, play, setAmbient } from '@/audio/sounds';
import { db } from '@/content';
import type { Difficulty } from '@/engine/shift/types';
import { T } from '@/i18n';
import { BuildMap } from '@/render/map/BuildMap';
import { ClinicMap } from '@/render/map/ClinicMap';
import { CLINIC } from '@/state/clinicMap';
import { blockText, type CashView } from '@/state/sandboxView';
import {
  type AmbulanceRow, callPatient, closeDay, leaveCase, loadShift, nextDay, openCase, openColleagueCase, pauseClock, type QueueRow, type ShiftView, SPEEDS, type Speed, type SummaryView,
  type RoomView, saveNow, setSpeed, skipIdle, sortAmbulance, startSandbox, startShift, TICK_MS, tick, useBuild, useCampaign, useShift, type WhoView,
} from '@/state/session';
import { CaseRow } from '@/ui/case/CaseRow';
import { gradeColor } from '@/ui/case/OutcomeScreen';
import { Button, Card, Chip, Chips, H, Lamp, P, Screen, Sheet, Tabs, Urgency } from '@/ui/components';
import { DifficultyChoice } from '@/ui/difficulty';
import { ChapterCard } from '@/ui/campaign';
import { NewSandbox } from '@/ui/sandbox';
import { makeStyles, space, touch, useTheme } from '@/ui/theme';

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
  if (v.status === 'none') {
    if (v.mode === 'sandbox') return <NewSandbox onStart={opts => startSandbox(opts)} />;
    if (v.mode === 'campaign') return <NoCareer />;
    return v.mode === 'single' ? <NoSingle /> : <NewPractice />;
  }
  // своя больница между сменами — песочница и глава кампании: стройка, персонал, «Открыть
  // смену» (spec 2026-09-own-hospital, 2026-09-campaign)
  const own = v.mode === 'sandbox' || v.mode === 'campaign';
  if (own && !v.dayOpen && v.day === 0) return <Evening v={v} />;
  return (
    <>
      {own && <OwnTitle mode={v.mode} />}
      {v.mode === 'single' && <Stack.Screen options={{ title: T.single.title }} />}
      {v.dayOpen ? <Queue v={v} /> : <Summary v={v} />}
    </>
  );
}

/** «Смены» нет — к выбору больницы. */
function NoSingle() {
  return (
    <Screen footer={<Button testID="to-single" title={T.single.title} onPress={() => router.replace('/single')} />}>
      <Card>
        <P>{T.single.noSave}</P>
      </Card>
    </Screen>
  );
}

/** Заголовок своей больницы: в песочнице — «Своя больница», в кампании — глава. */
function OwnTitle({ mode }: { mode: ShiftView['mode'] }) {
  const c = useCampaign();
  return <Stack.Screen options={{ title: mode === 'campaign' ? (c?.title ?? T.campaign.title) : T.sandbox.title }} />;
}

/** Кампания без сохранения в этом слоте — к списку карьер. */
function NoCareer() {
  return (
    <Screen footer={<Button testID="to-campaign" title={T.campaign.title} onPress={() => router.replace('/campaign')} />}>
      <Card>
        <P>{T.campaign.careersHint}</P>
      </Card>
    </Screen>
  );
}

/** Своя больница между сменами: план, касса, «Стройка»; смена в ней — следующая часть этапа. */
function Evening({ v }: { v: ShiftView }) {
  const t = T.sandbox;
  const b = useBuild();
  const c = useCampaign();
  const { width } = useWindowDimensions();
  if (!b) return null;
  const w = Math.min(width, 640) - 32;
  const h = Math.round((w * b.plan.grid.h) / b.plan.grid.w);
  const labels = b.plan.rooms.map(r => ({ id: r.id, name: db.rooms[r.type].name.ru, x: r.x, y: r.y, w: r.w, h: r.h, door: r.door, down: b.problems[r.id].length > 0 }));
  return (
    <Screen footer={<Button testID="sandbox-build" title={t.build} hint={t.buildHint} onPress={() => router.push('/sandbox/build')} />}>
      <Stack.Screen options={{ title: v.mode === 'campaign' ? (c?.title ?? T.campaign.title) : t.title }} />
      {v.mode === 'campaign' && c && <ChapterCard c={c} />}
      <Card>
        <H>{v.day === 0 ? t.beforeOpening : t.day(v.day)}</H>
        <P testID="sandbox-summary">{`${t.cash(T.common.rub(v.cash ?? 0))} · ${t.rooms(b.plan.rooms.length)}`}</P>
        <P muted testID="sandbox-reputation">{t.reputation(b.reputation)}</P>
        <P muted testID="sandbox-level">{b.level}</P>
      </Card>
      <BuildMap testID="sandbox-plan" plan={b.plan} width={w} height={h} tool="look" labels={labels} label={t.mapLabel} still onGhostMove={() => undefined} onStroke={() => undefined} onTapCell={() => undefined} />
      <OwnHospital />
    </Screen>
  );
}

/** Между сменами в песочнице: персонал, чего не хватает, «Открыть смену». */
function OwnHospital({ next }: { next?: boolean }) {
  const t = T.sandbox;
  const b = useBuild();
  if (!b) return null;
  const ready = b.open.length === 0;
  return (
    <Card>
      {next && <Button testID="sandbox-build-evening" kind="plain" title={t.build} hint={t.buildHint} onPress={() => router.push('/sandbox/build')} />}
      <Button testID="sandbox-staff" kind="plain" title={t.staffTitle} hint={t.staffHint} onPress={() => router.push('/sandbox/staff')} />
      {!next && <Button testID="sandbox-open" disabled={!ready} title={t.openShift} hint={ready ? t.openHint : undefined} onPress={nextDay} />}
      {!ready && <P muted testID="sandbox-open-needs">{`${t.needToOpen} ${b.open.map(x => blockText(db, x)).join(', ')}`}</P>}
    </Card>
  );
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

/** Звук двери при приходе пациента — не чаще, чем раз в столько миллисекунд. */
const DOOR_GAP_MS = 6000;

/** Карта пациента открывается один раз, даже если он вошёл и игрок коснулся кнопки разом. */
let enteredAt = 0;
function openVisit() {
  const now = Date.now();
  if (now - enteredAt < 1000) return;
  enteredAt = now;
  router.push('/shift/patient');
}

function Queue({ v }: { v: ShiftView }) {
  const styles = useStyles();
  const theme = useTheme();
  const t = T.shift;
  const { width } = useWindowDimensions();
  // план — в рамке: в «Мониторе» — зелёной, как снимок на негатоскопе (spec 2026-09-own-look)
  const frame = theme.shape.ruled ? 1 : 2;
  const mapWidth = Math.min(width, 640) - 2 * (space.s + frame);
  const [focused, setFocused] = useState(true);
  // кого или какое помещение коснулись на карте; кого пригласили — он идёт в кабинет
  const [selected, setSelected] = useState<string>();
  const [room, setRoom] = useState<string>();
  const [entering, setEntering] = useState<string>();
  // лист передачи скорой, открытый для сортировки (spec 2026-09-chapter-2, часть 27)
  const [handover, setHandover] = useState<string>();

  // часы — только пока экран на виду: поверх него карта пациента или разбор. Пока на виду —
  // и фон амбулатории; в кабинете, за закрытой дверью, тихо
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      setAmbient(true);
      let door = 0;
      const id = setInterval(() => {
        const notices = tick(TICK_MS);
        if (notices.some(n => (n.kind === 'arrived' && n.triage === 'red') || n.kind === 'ambulance')) {
          play('urgent');
          buzz('urgent');
        } else if (notices.some(n => n.kind === 'resultsReady')) {
          play('ready');
          buzz('ready');
        } else if (notices.some(n => n.kind === 'arrived')) {
          // дверь — не чаще раза в несколько секунд: на ×4 приходят часто
          const now = Date.now();
          if (now - door > DOOR_GAP_MS) {
            door = now;
            play('arrived');
          }
        }
      }, TICK_MS);
      return () => {
        clearInterval(id);
        setAmbient(false);
        saveNow();
        setFocused(false);
        setEntering(undefined);
      };
    }, []),
  );

  const skip = () => {
    const notices = skipIdle();
    if (notices.some(n => (n.kind === 'arrived' && n.triage === 'red') || n.kind === 'ambulance')) {
      play('urgent');
      buzz('urgent');
    } else if (notices.some(n => n.kind === 'resultsReady' || n.kind === 'arrived')) {
      buzz('ready');
      if (notices.some(n => n.kind === 'arrived')) play('arrived');
    }
  };

  // двойное касание не зовёт дважды: второй вызов не проходит — кабинет занят. Карта
  // пациента — когда он дошёл до кабинета (ClinicMap, onArrive) или по кнопке сразу
  const call = (id: string) => {
    buzz('tap');
    if (callPatient(id)) {
      setSelected(undefined);
      // привезённого скорой смотрят в смотровой приёмного: карта — сразу (часть 27)
      if (v.queue.some(r => r.id === id && r.ambulance)) enter();
      else setEntering(id);
    }
  };
  const enter = () => {
    setEntering(undefined);
    leaveCase(); // карта — вашего пациента, а не открытого приёма врача
    openVisit();
  };
  // приём нанятого врача — только для чтения, оттуда «Забрать себе» (spec 2026-09-hired-doctors, часть 19)
  const openColleague = (id: string) => {
    buzz('tap');
    setSelected(undefined);
    openColleagueCase(id);
    router.push('/shift/colleague');
  };

  const first = v.queue[0];
  const footer = v.inRoom
    ? <Button testID="shift-continue" title={`${entering === v.inRoom.id ? t.entering(v.inRoom.name) : t.continueVisit(v.inRoom.name)} ▶`} onPress={enter} />
    : v.ambulance.length > 0
      // привезённого скорой — сначала сортировать (spec 2026-09-chapter-2, часть 27)
      ? <Button testID="shift-sort" lamp title={`${t.ambulance.next(v.ambulance[0].name)} ▶`} onPress={() => setHandover(v.ambulance[0].id)} />
      : first
      ? <Button testID="shift-call" lamp title={`${t.call(first.name)} ▶`} hint={v.queue.length > 1 ? t.callHint : undefined} onPress={() => call(first.id)} />
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
      <View style={[styles.mapFrame, { borderWidth: frame }]}>
      <ClinicMap
        layout={v.layout ?? CLINIC}
        people={v.people}
        signs={v.signs}
        width={mapWidth}
        active={focused}
        label={t.map.label(v.queue.length, v.away.length, v.inRoom?.name)}
        selected={who ? selected : undefined}
        awaiting={entering}
        onSelect={setSelected}
        onArrive={enter}
        room={v.rooms && room ? room : undefined}
        onRoom={v.rooms ? setRoom : undefined}
      />
      </View>
      {who && selected !== undefined ? (
        <WhoStrip who={who} onCall={who.callable ? () => call(selected) : undefined} onOpen={who.colleague ? () => openColleague(selected) : undefined} />
      ) : null}
      {!who && room && v.rooms?.[room] ? <RoomStrip room={v.rooms[room]} /> : null}
    </>
  );

  return (
    <Screen header={map} footer={footer}>
      <Card>
        {/* часы — крупно, моноширинным; скорости — рядом, на узком экране — под ними */}
        <View style={styles.clockRow}>
          <View>
            <Text style={styles.day}>{t.day(v.day)}</Text>
            <Text testID="shift-clock" style={styles.clock}>{v.clock}</Text>
          </View>
          <View style={styles.speeds}>
            <Tabs<SpeedKey>
              value={speed}
              onChange={onSpeed}
              items={[{ key: 'pause', title: t.speed.pause }, { key: 'x1', title: t.speed.x1 }, { key: 'x2', title: t.speed.x2 }, { key: 'x4', title: t.speed.x4 }]}
            />
          </View>
        </View>
        <P muted testID="shift-counts">{t.counts(v.counts.seen, v.counts.waiting, v.counts.left)}</P>
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

      {v.ambulance.length > 0 && (
        <Card testID="shift-ambulance">
          <Text style={styles.label}>{t.ambulance.title}</Text>
          {v.ambulance.map(a => <Button key={a.id} testID={`ambulance-${a.id}`} kind="plain" title={a.name} hint={a.line} onPress={() => setHandover(a.id)} />)}
        </Card>
      )}

      <Card>
        <Text style={styles.label}>{t.queue}</Text>
        {v.queue.length === 0 ? <P muted>{t.queueEmpty}</P> : v.queue.map((r, i) => (
          <QueueItem key={r.id} r={r} n={i + 1} disabled={v.inRoom !== undefined} onPress={() => call(r.id)} />
        ))}
      </Card>

      {v.away.length > 0 && (
        <Card>
          <Text style={styles.label}>{t.away}</Text>
          {v.away.map(a => <P key={a.id} testID={`away-${a.id}`}>{`${a.name} — ${t.awayReady(a.ready)}`}</P>)}
        </Card>
      )}

      {v.inpatients > 0 && v.dayOpen && (
        <Card testID="shift-rounds">
          <Button testID="rounds-open" kind="plain" title={T.shift.ward.open(v.inpatients)} hint={T.shift.ward.openHint} onPress={() => router.push('/shift/rounds')} />
        </Card>
      )}

      {v.colleagues.length > 0 && (
        <Card testID="shift-colleagues">
          <Text style={styles.label}>{t.colleagueCase.list}</Text>
          {v.colleagues.map(c => <Button key={c.id} testID={`colleague-${c.id}`} kind="plain" title={c.name} hint={c.hint} onPress={() => openColleague(c.id)} />)}
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

      <Handover row={v.ambulance.find(a => a.id === handover)} onClose={() => setHandover(undefined)} />
    </Screen>
  );
}

/** Лист передачи скорой: повод, что измерил фельдшер, на «Студенте» — NEWS2 и тревожный признак; три цвета — сортировка врачом. */
function Handover({ row, onClose }: { row?: AmbulanceRow; onClose: () => void }) {
  const styles = useStyles();
  const t = T.shift.ambulance;
  return (
    <Sheet visible={row !== undefined} onClose={onClose} closeTitle={t.close} testID="handover-sheet">
      {row ? (
        <>
          <H>{row.name}</H>
          <Text style={styles.label}>{t.sheet}</Text>
          <P testID="handover-reason">{row.handover.reason}</P>
          <Text style={styles.label}>{t.measured}</Text>
          {row.handover.measured.map(m => <P key={m}>{m}</P>)}
          {row.handover.news2 ? <P muted testID="handover-news2">{row.handover.news2}</P> : null}
          {row.handover.flag ? <P muted testID="handover-flag">{row.handover.flag}</P> : null}
          <Text style={styles.label}>{t.sortLabel}</Text>
          {(['red', 'yellow', 'green'] as const).map(c => (
            <Button key={c} testID={`sort-${c}`} kind="plain" title={t.sort[c]} onPress={() => {
              buzz('tap');
              sortAmbulance(row.id, c);
              onClose();
            }} />
          ))}
          <P muted>{t.sortHint}</P>
        </>
      ) : null}
    </Sheet>
  );
}


/** Кого коснулись на карте: кто это и что делает; ждущего приёма можно пригласить, приём нанятого врача — открыть. */
function WhoStrip({ who, onCall, onOpen }: { who: WhoView; onCall?: () => void; onOpen?: () => void }) {
  const styles = useStyles();
  return (
    <View testID="map-who" style={styles.who}>
      <View style={styles.itemHead}>
        <Text style={styles.itemName} numberOfLines={1}>{who.title}</Text>
        {who.triage ? <Urgency level={who.triage} label={T.shift.triage[who.triage]} /> : null}
      </View>
      {who.complaint ? <Text style={styles.itemText} numberOfLines={1}>{`«${who.complaint}»`}</Text> : null}
      <View style={styles.whoFoot}>
        <Text style={[styles.itemMeta, styles.whoDoing]}>{who.doing}</Text>
        {onCall ? (
          <Pressable testID="map-invite" accessibilityRole="button" onPress={onCall} style={({ pressed }) => [styles.invite, styles.inviteLamp, pressed && styles.pressed]}>
            <Lamp />
            <Text style={styles.inviteText}>{`${T.shift.map.invite} ▶`}</Text>
          </Pressable>
        ) : onOpen ? (
          <Pressable testID="map-open-colleague" accessibilityRole="button" onPress={onOpen} style={({ pressed }) => [styles.invite, pressed && styles.pressed]}>
            <Text style={styles.inviteText}>{`${T.shift.colleagueCase.open} ▶`}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/** Какого помещения коснулись на карте своей больницы: что это, работает ли, кто в нём и что там сейчас. */
function RoomStrip({ room }: { room: RoomView }) {
  const styles = useStyles();
  return (
    <View testID="map-room" style={styles.who}>
      <Text style={styles.itemName} numberOfLines={1}>{room.title}</Text>
      <Text testID="map-room-status" style={styles.itemMeta}>{room.status}</Text>
      {room.lines.map((l, i) => <Text key={i} style={styles.itemText} numberOfLines={1}>{l}</Text>)}
    </View>
  );
}

/**
 * Строка очереди: в «Медкарте» — запись журнала, номер на поле за красной линией; в «Мониторе»
 * — панель с полосой цвета срочности. Срочность — ещё и словом со значком.
 */
function QueueItem({ r, n, disabled, onPress }: { r: QueueRow; n: number; disabled: boolean; onPress: () => void }) {
  const styles = useStyles();
  const t = useTheme();
  const journal = t.shape.ruled;
  return (
    <Pressable
      testID={`queue-${r.id}`}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [journal ? styles.entry : [styles.item, { borderLeftColor: t.colors[r.triage] }], disabled && styles.itemDisabled, pressed && styles.pressed]}>
      {journal && (
        <View style={styles.entryMargin} aria-hidden importantForAccessibility="no-hide-descendants">
          <Text style={styles.entryNumber}>{n}</Text>
        </View>
      )}
      <View style={styles.entryBody}>
        <View style={styles.itemHead}>
          <Text style={styles.itemName}>{`${r.name}, ${r.age}`}</Text>
          <Urgency level={r.triage} label={T.shift.triage[r.triage]} />
        </View>
        <Text style={[styles.itemText, journal && styles.said]}>{`«${r.complaint}»`}</Text>
        <Text style={styles.itemMeta}>{[...r.badges, r.waits].join(' · ')}</Text>
      </View>
    </Pressable>
  );
}

function Summary({ v }: { v: ShiftView }) {
  const styles = useStyles();
  const t = T.shift.summary;
  const [confirm, setConfirm] = useState(false);
  const s = v.summary;
  if (!s) return null;
  const own = v.mode === 'sandbox' || v.mode === 'campaign';
  const open = (id: string) => {
    openCase(id);
    router.push('/shift/outcome');
  };
  const footer = v.mode === 'single'
    ? <Button testID="single-again" title={T.single.again} onPress={() => router.replace('/single')} />
    : <Button testID="shift-next-day" title={t.nextDay} onPress={nextDay} />;
  return (
    <Screen footer={footer}>
      {s.single && <SingleCard r={s.single} />}
      <Card>
        <H>{t.title(s.day)}</H>
        <P testID="summary-seen">{s.theirs > 0 ? t.seenAll(s.seen, s.theirs, s.arrived) : t.seen(s.seen, s.arrived)}</P>
        {s.left > 0 && <P>{t.left(s.left)}</P>}
        {s.unseen > 0 && <P>{t.unseen(s.unseen)}</P>}
        {s.seen > 0 && <P>{t.verdicts(s.correct, s.partly, s.wrong)}</P>}
        {s.confidence !== undefined && <P>{t.confidence(s.confidence)}</P>}
        {s.seen > 0 && <P>{t.money(T.common.rub(s.money), T.common.rub(s.rationalMoney))}</P>}
        <P>{t.returns(s.returnsPlanned, s.returnsToday)}</P>
        {!own && <P muted>{t.moneyNote}</P>}
      </Card>

      {s.achievements.length > 0 && (
        <Card testID="summary-achievements">
          {s.achievements.map(a => <P key={a}>{T.profile.achievementLine(a)}</P>)}
        </Card>
      )}

      {s.chapterDay && <CampaignDay d={s.chapterDay} />}

      {s.cash && <Cash c={s.cash} />}

      {own && <OwnHospital next />}

      {s.seen > 0 && <Grades s={s} />}

      {s.colleagues.length > 0 && (
        <Card testID="summary-colleagues">
          <Text style={styles.label}>{t.colleagues}</Text>
          {s.colleagues.map(c => (
            <View key={c.id} style={styles.colleague}>
              <P>{c.title}</P>
              <P muted>{c.line}</P>
              {/* его приёмы — к разбору, как ваши (часть 19) */}
              {c.cases.map(r => (
                <CaseRow key={r.id} testID={`case-${r.id}`} verdict={r.verdict} title={r.name} subtitle={r.diagnosis} grade={r.overall} onPress={() => open(r.id)} />
              ))}
            </View>
          ))}
        </Card>
      )}

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

      {s.ambulanceLines && (
        <Card testID="summary-ambulance">
          <Text style={styles.label}>{t.ambulance.title}</Text>
          {s.ambulanceLines.map(line => <P key={line}>{line}</P>)}
        </Card>
      )}

      {s.wardLines && (
        <Card testID="summary-ward">
          <Text style={styles.label}>{t.ward.title}</Text>
          {s.wardLines.map(line => <P key={line}>{line}</P>)}
        </Card>
      )}

      {v.mode === 'shift' && <Button kind="plain" testID="shift-restart" title={t.restart} onPress={() => setConfirm(true)} />}
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

/** «Смена»: оценки по категориям, общая, кого приняли и сколько минут на приём, лучший здесь. */
function SingleCard({ r }: { r: NonNullable<SummaryView['single']> }) {
  const styles = useStyles();
  const theme = useTheme();
  const t = T.single;
  return (
    <Card testID="single-result">
      <H>{t.resultTitle(r.venue)}</H>
      {r.grades.length > 0 && (
        <View style={styles.grades}>
          {r.grades.map(g => (
            <View key={g.key} style={styles.gradeCell}>
              <Text testID={`single-${g.key}`} style={[styles.gradeLetter, gradeColor(theme, g.grade)]}>{g.grade}</Text>
              <Text style={styles.gradeName}>{g.label}</Text>
            </View>
          ))}
          {r.overall && (
            <View style={[styles.gradeCell, styles.gradeTotal]}>
              <Text testID="single-overall" style={[styles.gradeLetter, gradeColor(theme, r.overall)]}>{r.overall}</Text>
              <Text style={styles.gradeName}>{t.overall}</Text>
            </View>
          )}
        </View>
      )}
      {r.lines.map(l => <P key={l}>{l}</P>)}
      {r.best && <P muted testID="single-best">{r.best}</P>}
    </Card>
  );
}

/** Кампания в итогах дня: что выполнено сегодня, сколько пришло писем, и вся глава. */
function CampaignDay({ d }: { d: NonNullable<SummaryView['chapterDay']> }) {
  const c = useCampaign();
  return (
    <>
      {(d.done.length > 0 || d.letters > 0) && (
        <Card testID="summary-campaign">
          {d.done.map(x => <P key={x}>{T.campaign.todayDone(x)}</P>)}
          {d.letters > 0 && <P muted>{T.campaign.todayLetters(d.letters)}</P>}
        </Card>
      )}
      {c && <ChapterCard c={c} />}
    </>
  );
}

/** Песочница: касса за день и репутация — из чего сложились (spec 2026-09-own-hospital, часть 9). */
function Cash({ c }: { c: CashView }) {
  const styles = useStyles();
  const t = T.sandbox;
  return (
    <>
      <Card testID="summary-cash">
        <H>{t.cashTitle}</H>
        <Text style={styles.label}>{t.income}</Text>
        {c.income.map(x => <Line key={x.key} testID={`cash-${x.key}`} title={x.title} sum={x.sum} />)}
        {c.wardNote && <P muted testID="cash-ward-note">{c.wardNote}</P>}
        {c.audit && <P muted testID="cash-audit">{c.audit.why ? `${c.audit.sum}: ${c.audit.why}` : c.audit.sum}</P>}
        <P muted testID="cash-level">{c.level}</P>
        <Text style={styles.label}>{t.expensesTitle}</Text>
        {c.expenses.map(x => <Line key={x.key} title={x.title} sum={x.sum} />)}
        <P testID="cash-net">{c.net}</P>
        <P testID="cash-now">{c.cash}</P>
        {c.debt && <P testID="cash-debt">{c.debt}</P>}
      </Card>
      <Card testID="summary-reputation">
        <H>{t.repTitle}</H>
        <P testID="rep-line">{c.reputation.line}</P>
        {c.reputation.score && <P>{c.reputation.score}</P>}
        {c.reputation.reasons.map(r => <Line key={r.key} title={r.text} sum={r.delta} />)}
        <P muted>{c.reputation.hint}</P>
      </Card>
    </>
  );
}

/** Строка кассы: название слева, сумма справа. */
function Line({ title, sum, testID }: { title: string; sum: string; testID?: string }) {
  const styles = useStyles();
  return (
    <View testID={testID} style={styles.line}>
      <Text style={styles.lineTitle}>{title}</Text>
      <Text style={styles.lineSum}>{sum}</Text>
    </View>
  );
}

function Grades({ s }: { s: SummaryView }) {
  const styles = useStyles();
  return (
    <Card>
      <Text style={styles.label}>{T.shift.summary.grades}</Text>
      <Chips>
        {(['A', 'B', 'C', 'D'] as const).map(g => <Chip key={g} text={`${g}: ${s.grades[g]}`} strong={s.grades[g] > 0} />)}
      </Chips>
    </Card>
  );
}

const useStyles = makeStyles(t => ({
  label: { fontSize: 13, fontWeight: '700', letterSpacing: 1.2, color: t.colors.muted, textTransform: 'uppercase', marginTop: space.s },
  room: { backgroundColor: t.colors.accentSoft },
  colleague: { gap: 2 },
  item: { borderLeftWidth: 5, borderRadius: t.shape.radius, backgroundColor: t.colors.bg, paddingHorizontal: space.m },
  entry: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: t.colors.line },
  entryMargin: { width: 28, alignItems: 'center', paddingTop: space.s + 2, borderRightWidth: 1.5, borderRightColor: t.colors.margin },
  entryNumber: { fontSize: 15, color: t.colors.margin },
  entryBody: { flex: 1, gap: 2, paddingVertical: space.s, paddingLeft: t.shape.ruled ? space.m : 0 },
  said: { fontFamily: t.fonts.title, fontStyle: 'italic' },
  clockRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: space.m },
  day: { fontSize: 13, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase', color: t.colors.muted },
  clock: {
    fontFamily: t.fonts.mono, fontWeight: '500', fontVariant: ['tabular-nums'],
    fontSize: t.shape.ruled ? 32 : 40, lineHeight: t.shape.ruled ? 38 : 46, color: t.shape.ruled ? t.colors.ink : t.colors.accent,
  },
  // скорости — рядом с часами, если помещаются все четыре подписи; иначе — строкой ниже
  speeds: { flex: 1, minWidth: t.shape.ruled ? 220 : 250 },
  mapFrame: { margin: space.s, borderColor: t.shape.ruled ? t.colors.edge : t.colors.accent, borderRadius: t.shape.ruled ? 2 : 8, overflow: 'hidden' },
  itemDisabled: { opacity: 0.6 },
  pressed: { opacity: 0.8 },
  itemHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.s },
  itemName: { flexShrink: 1, fontSize: 15, fontWeight: '600', color: t.colors.ink },
  itemText: { fontSize: 14, color: t.colors.ink },
  itemMeta: { fontSize: 13, color: t.colors.muted },
  who: { gap: 2, width: '100%', maxWidth: 640, paddingHorizontal: space.l, paddingVertical: space.s, borderTopWidth: 1, borderTopColor: t.colors.line },
  whoFoot: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  whoDoing: { flex: 1 },
  invite: { minHeight: touch, justifyContent: 'center', paddingHorizontal: space.l, borderRadius: t.shape.radius, backgroundColor: t.colors.accent },
  inviteLamp: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  inviteText: { fontSize: 15, fontWeight: '700', color: t.colors.onAccent },
  log: { fontSize: 14, lineHeight: 20, color: t.colors.ink },
  line: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: space.m },
  grades: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  gradeCell: { width: '30%', minWidth: 90, alignItems: 'center', paddingVertical: space.s, borderRadius: t.shape.radius, backgroundColor: t.colors.bg },
  gradeTotal: { backgroundColor: t.colors.accentSoft },
  gradeLetter: { fontSize: 24, fontWeight: '800' },
  gradeName: { fontSize: 12, color: t.colors.muted, textAlign: 'center' },
  lineTitle: { flexShrink: 1, fontSize: 15, lineHeight: 22, color: t.colors.ink },
  lineSum: { fontSize: 15, lineHeight: 22, fontWeight: '600', color: t.colors.ink, fontVariant: ['tabular-nums'] },
  logRed: { color: t.colors.red, fontWeight: '600' },
}));
