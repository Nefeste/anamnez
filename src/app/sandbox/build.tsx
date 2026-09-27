// Экран стройки своей больницы (spec 2026-09-own-hospital, часть 7; ADR 0016): план участка с
// камерой; внизу, под большим пальцем, — касса, «Отменить», инструменты. Помещение: тип и
// размер → призрак посреди участка, его тянут пальцем → «Повернуть» → «Построить». Коридор —
// кистью, снос — касанием помещения или кистью по коридору. Касание помещения — карточка: что
// в нём и чего не хватает, дверь, аппараты, снос. «Готово» — отменять больше нечего.
import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { db } from '@/content';
import type { Cell, Id, RoomSizeId } from '@/content/types';
import { sizeOf } from '@/engine/hospital/build';
import { T } from '@/i18n';
import { BuildMap, type Tool } from '@/render/map/BuildMap';
import { buildAction, type BuildView, endBuild, undoBuild, useBuild, useStaff } from '@/state/session';
import { buildErrorText, centered, type GhostSpec, ghostOf, rotated, statusText } from '@/state/sandboxView';
import { Button, Card, H, P, Screen, Sheet } from '@/ui/components';
import { Text } from '@/ui/text';
import { colors, radius, space, touch } from '@/ui/theme';

const rub = (n: number) => T.common.rub(n);

export default function BuildScreen() {
  const b = useBuild();
  if (!b) {
    return (
      <Screen>
        <Card>
          <P muted>{T.shift.loading}</P>
        </Card>
      </Screen>
    );
  }
  return <Builder b={b} />;
}

function Builder({ b }: { b: BuildView }) {
  const t = T.sandbox;
  const [area, setArea] = useState({ w: 0, h: 0 });
  const [tool, setTool] = useState<Tool>('look');
  const [picking, setPicking] = useState<Id | 'types'>();
  const [spec, setSpec] = useState<GhostSpec>();
  const [selected, setSelected] = useState<string>();
  const [demolish, setDemolish] = useState<string>();
  const [why, setWhy] = useState<string>();

  const ghost = spec ? ghostOf(db, b.hospital, spec) : undefined;
  const cost = spec ? sizeOf(db, spec.type, spec.size)!.cost : 0;
  const labels = b.plan.rooms.map(r => ({ id: r.id, name: db.rooms[r.type].name.ru, x: r.x, y: r.y, w: r.w, down: b.problems[r.id].length > 0 }));
  const roomAt = (x: number, y: number) => b.plan.rooms.find(r => x > r.x && y > r.y && x < r.x + r.w - 1 && y < r.y + r.h - 1)
    ?? b.plan.rooms.find(r => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h);

  const act = (cmd: Parameters<typeof buildAction>[0]) => {
    const e = buildAction(cmd);
    setWhy(e ? buildErrorText(db, e, b.plan) : undefined);
    return !e;
  };
  const choose = (type: Id, size: RoomSizeId) => {
    setPicking(undefined);
    setSelected(undefined);
    setWhy(undefined);
    setSpec(centered(db, b.hospital, type, size));
    setTool('room');
  };
  const place = () => {
    if (spec && act({ kind: 'room', ...spec })) {
      setSpec(undefined);
      setTool('look');
    }
  };
  const cancelRoom = () => {
    setSpec(undefined);
    setWhy(undefined);
    setTool('look');
  };
  const onStroke = (cells: Cell[]) => {
    if (tool === 'corridor') act({ kind: 'corridor', cells });
    else if (tool === 'erase') act({ kind: 'erase', cells });
  };
  const onTapCell = (x: number, y: number) => {
    const r = roomAt(x, y);
    if (tool === 'look') setSelected(r?.id);
    else if (tool === 'erase' && r) setDemolish(r.id);
  };
  const done = () => {
    endBuild();
    router.back();
  };

  const status = ghost?.error ? buildErrorText(db, ghost.error, b.plan) : spec && b.cash < cost ? t.why.money(rub(cost - b.cash)) : undefined;
  const hint = tool === 'room' ? status ?? t.ghostHint : tool === 'corridor' ? t.brushHint(rub(db.economy.corridor.cost)) : tool === 'erase' ? t.eraseHint : t.lookHint;

  const panel = (
    <View style={styles.panel}>
      <View style={styles.row}>
        <Text testID="build-cash" style={styles.cash}>{t.cash(rub(b.cash))}</Text>
        <Small testID="build-undo" title={t.undo(b.undo)} disabled={b.undo === 0} onPress={undoBuild} />
      </View>
      <Text testID="build-hint" style={[styles.hint, (why || (tool === 'room' && status)) && styles.warn]}>{why ?? hint}</Text>
      {tool === 'room' ? (
        <View style={styles.row}>
          <Small testID="build-rotate" title={t.rotate} onPress={() => spec && setSpec(rotated(db, spec))} />
          <Small testID="build-cancel" title={t.cancel} onPress={cancelRoom} />
          <Small testID="build-place" title={t.place(rub(cost))} strong disabled={!ghost?.ok || b.cash < cost} onPress={place} />
        </View>
      ) : tool === 'look' ? (
        <>
          <View style={styles.row}>
            <Small testID="build-tool-room" title={t.tools.room} onPress={() => setPicking('types')} />
            <Small testID="build-tool-corridor" title={t.tools.corridor} onPress={() => { setTool('corridor'); setWhy(undefined); setSelected(undefined); }} />
            <Small testID="build-tool-erase" title={t.tools.erase} onPress={() => { setTool('erase'); setWhy(undefined); setSelected(undefined); }} />
          </View>
          <Button testID="build-done" title={t.done} onPress={done} />
        </>
      ) : (
        <Button testID="build-tool-done" title={t.done} onPress={() => { setTool('look'); setWhy(undefined); }} />
      )}
    </View>
  );

  return (
    <Screen scroll={false} footer={panel}>
      <Stack.Screen options={{ title: t.build }} />
      <View style={styles.fill} onLayout={e => setArea({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
        {area.w > 0 && (
          <BuildMap
            plan={b.plan}
            width={area.w}
            height={area.h}
            tool={tool}
            ghost={ghost}
            selected={selected}
            labels={labels}
            label={t.mapLabel}
            onGhostMove={(x, y) => spec && setSpec({ ...spec, x, y })}
            onStroke={onStroke}
            onTapCell={onTapCell}
          />
        )}
      </View>
      <RoomPicker picking={picking} onPick={setPicking} onChoose={choose} />
      {selected && <RoomCard b={b} id={selected} onClose={() => setSelected(undefined)} onDemolish={() => setDemolish(selected)} act={act} />}
      <Sheet visible={!!demolish} onClose={() => setDemolish(undefined)} closeTitle={t.cancel} testID="demolish-sheet">
        {demolish && <Demolish b={b} id={demolish} onDone={() => { act({ kind: 'demolish', room: demolish }); setDemolish(undefined); setSelected(undefined); }} />}
      </Sheet>
    </Screen>
  );
}

/** Выбор помещения: тип (что открывает и почём), потом размер. */
function RoomPicker({ picking, onPick, onChoose }: { picking?: Id | 'types'; onPick: (p?: Id | 'types') => void; onChoose: (type: Id, size: RoomSizeId) => void }) {
  const t = T.sandbox;
  const type = picking && picking !== 'types' ? db.rooms[picking] : undefined;
  return (
    <Sheet visible={!!picking} onClose={() => onPick(undefined)} closeTitle={t.cancel} testID="room-picker">
      {type ? (
        <>
          <H>{type.name.ru}</H>
          <P muted>{type.texts.hint.ru}</P>
          <P>{t.pickSize}</P>
          {type.sizes.map(z => (
            <Button key={z.id} testID={`room-size-${z.id}`} kind="plain" title={t.sizeLine(z.id, z.w, z.h, rub(z.cost), z.seats)} onPress={() => onChoose(type.id, z.id)} />
          ))}
        </>
      ) : (
        <>
          <H>{t.pickRoom}</H>
          {Object.values(db.rooms).map(r => (
            <Button
              key={r.id}
              testID={`room-type-${r.id}`}
              kind="plain"
              title={r.name.ru}
              hint={`${t.fromPrice(rub(Math.min(...r.sizes.map(z => z.cost))))} · ${r.texts.hint.ru}`}
              onPress={() => (r.sizes.length === 1 ? onChoose(r.id, r.sizes[0].id) : onPick(r.id))}
            />
          ))}
        </>
      )}
    </Sheet>
  );
}

/** Карточка помещения: работает ли и чего не хватает, дверь, аппараты, снос. */
function RoomCard({ b, id, onClose, onDemolish, act }: {
  b: BuildView; id: string; onClose: () => void; onDemolish: () => void; act: (cmd: Parameters<typeof buildAction>[0]) => boolean;
}) {
  const t = T.sandbox;
  const staff = useStaff();
  const [buying, setBuying] = useState(false);
  const room = b.hospital.rooms.find(r => r.id === id);
  if (!room) return null;
  const type = db.rooms[room.type];
  const z = sizeOf(db, room.type, room.size)!;
  const refund = (n: number) => Math.floor((n * db.economy.refund) / 100);
  // дверь — к ближайшему месту в ту сторону, где за ней коридор
  const moveDoor = (dir: 1 | -1) => {
    for (let at = room.door + dir; at >= 1 && at + z.door.width - 1 <= z.w - 2; at += dir) if (act({ kind: 'door', room: id, at })) return;
  };
  const back = refund(z.cost) + room.equipment.reduce((m, e) => m + (e ? refund(db.equipment[e].price) : 0), 0);
  return (
    <Sheet visible onClose={onClose} closeTitle={t.close} testID="room-card">
      <H>{t.size(type.name.ru, room.size)}</H>
      <P testID="room-status">{statusText(db, b.problems[id] ?? [])}</P>
      <View style={styles.row}>
        <Small testID="door-prev" title={t.doorPrev} onPress={() => moveDoor(-1)} />
        <Small testID="door-next" title={t.doorNext} onPress={() => moveDoor(1)} />
      </View>
      {z.slots.length > 0 && (
        <>
          <P>{t.equipment}</P>
          {room.equipment.map((e, i) => (e
            ? <Button key={i} testID={`room-sell-${i}`} kind="plain" title={db.equipment[e].name.ru} hint={t.sell(rub(refund(db.equipment[e].price)))} onPress={() => act({ kind: 'sell', room: id, slot: i })} />
            : <P key={i} muted>{t.emptySlot}</P>))}
          {room.equipment.includes(null) && !buying && <Button testID="room-buy" kind="plain" title={t.buy} onPress={() => setBuying(true)} />}
          {buying && type.equipment.map(e => {
            const eq = db.equipment[e];
            return (
              <Button key={e} testID={`eq-${e}`} kind="plain" title={eq.name.ru} hint={`${t.eqLine(rub(eq.price), rub(eq.upkeep))} · ${eq.texts.hint.ru}`}
                onPress={() => { if (act({ kind: 'buy', room: id, equipment: e })) setBuying(false); }} />
            );
          })}
        </>
      )}
      {staff && type.staff.some(r => db.roles[r].hire) && (
        <>
          <P>{t.staffTitle}</P>
          {staff.posts.filter(x => x.room === id).map(x => {
            const who = staff.staff.find(m => m.id === x.who);
            return <P key={x.role} muted testID={`post-${x.role}`}>{who ? t.postWho(x.roleName, who.name, who.skill, who.trait) : `${x.roleName}: ${t.postFree}`}</P>;
          })}
          <Button testID="room-staff" kind="plain" title={t.staffTitle} hint={t.staffHint} onPress={() => { onClose(); router.push('/sandbox/staff'); }} />
        </>
      )}
      <Button testID="room-demolish" kind="plain" title={t.demolish(rub(back))} onPress={onDemolish} />
    </Sheet>
  );
}

function Demolish({ b, id, onDone }: { b: BuildView; id: string; onDone: () => void }) {
  const t = T.sandbox;
  const room = b.hospital.rooms.find(r => r.id === id);
  if (!room) return null;
  return (
    <>
      <H>{t.demolishTitle(db.rooms[room.type].name.ru)}</H>
      <P>{t.demolishText}</P>
      <Button testID="demolish-confirm" title={T.sandbox.tools.erase} onPress={onDone} />
    </>
  );
}

/** Кнопка панели стройки: в ряд по нескольку, не меньше 48 dp. */
function Small({ title, onPress, disabled, strong, testID }: { title: string; onPress: () => void; disabled?: boolean; strong?: boolean; testID?: string }) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.small, strong && styles.strong, disabled && styles.disabled, pressed && styles.pressed]}>
      <Text numberOfLines={2} style={[styles.smallText, strong && styles.strongText]}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  panel: { gap: space.s },
  row: { flexDirection: 'row', gap: space.s, alignItems: 'center' },
  cash: { flex: 1, fontSize: 16, fontWeight: '700', color: colors.ink },
  hint: { fontSize: 13, color: colors.muted },
  warn: { color: colors.danger },
  small: {
    flex: 1, minHeight: touch, borderRadius: radius, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.s,
  },
  strong: { backgroundColor: colors.accent, borderColor: colors.accent },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.7 },
  smallText: { fontSize: 14, fontWeight: '600', color: colors.ink, textAlign: 'center' },
  strongText: { color: '#FFFFFF' },
});
