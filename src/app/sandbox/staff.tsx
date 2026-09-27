// Персонал своей больницы (spec 2026-09-own-hospital, часть 8): кто работает и где, свободные
// места, кандидаты дня. Нанятый — сначала в резерве; касание — назначить в помещение (прежний
// с этого места — в резерв), в резерв или уволить. Всё — между сменами (ADR 0016).
import { Stack } from 'expo-router';
import { useState } from 'react';
import { T } from '@/i18n';
import { assign, fire, hire, type PersonView, useStaff } from '@/state/session';
import { Button, Card, H, P, Screen, Sheet } from '@/ui/components';

const rub = (n: number) => T.common.rub(n);

export default function StaffScreen() {
  const v = useStaff();
  const t = T.sandbox;
  const [chosen, setChosen] = useState<string>();
  const [firing, setFiring] = useState(false);
  if (!v) {
    return (
      <Screen>
        <Card>
          <P muted>{T.shift.loading}</P>
        </Card>
      </Screen>
    );
  }
  const person = v.staff.find(m => m.id === chosen);
  const hint = (m: PersonView) => `${t.person(m.roleName, m.skill, m.trait)} · ${t.perShift(rub(m.salary))}`;
  const free = v.posts.filter(x => !x.who);
  const close = () => {
    setChosen(undefined);
    setFiring(false);
  };
  return (
    <Screen>
      <Stack.Screen options={{ title: t.staffTitle }} />
      <Card>
        <H>{t.hired}</H>
        <P muted testID="staff-total">{t.salaries(rub(v.salaries))}</P>
        {v.staff.length === 0 && <P muted>{t.noStaff}</P>}
        {v.staff.map(m => (
          <Button key={m.id} testID={`staff-${m.id}`} kind="plain" title={m.name} hint={`${hint(m)} · ${m.roomName ? t.worksIn(m.roomName) : t.reserve}`} onPress={() => setChosen(m.id)} />
        ))}
      </Card>
      {free.length > 0 && (
        <Card>
          <H>{t.postFreeTitle}</H>
          {free.map(x => <P key={`${x.room}:${x.role}`} testID={`free-${x.room}-${x.role}`}>{t.post(x.roomName, x.roleName)}</P>)}
        </Card>
      )}
      <Card>
        <H>{t.candidates}</H>
        <P muted>{t.candidatesHint}</P>
        {v.candidates.length === 0 && <P muted>{t.noCandidates}</P>}
        {v.candidates.map(c => (
          <Button key={c.id} testID={`candidate-${c.id}`} kind="plain" title={c.name} hint={`${hint(c)} · ${t.hireHint}`} onPress={() => { hire(c.id); setChosen(c.id); }} />
        ))}
      </Card>

      <Sheet visible={!!person} onClose={close} closeTitle={t.close} testID="staff-sheet">
        {person && !firing && (
          <>
            <H>{t.assignTitle(person.name)}</H>
            <P muted>{hint(person)}</P>
            {v.posts.filter(x => x.role === person.role).map(x => {
              const holder = v.staff.find(m => m.id === x.who);
              const here = x.who === person.id;
              return (
                <Button key={x.room} testID={`assign-${x.room}`} kind={here ? 'primary' : 'plain'} title={x.roomName}
                  hint={holder ? (here ? t.here : t.replaces(holder.name)) : t.postFree} onPress={() => { assign(person.id, x.room); close(); }} />
              );
            })}
            {v.posts.every(x => x.role !== person.role) && <P muted>{t.noPosts}</P>}
            <Button testID="assign-reserve" kind="plain" title={t.toReserve} onPress={() => { assign(person.id); close(); }} />
            <Button testID="staff-fire" kind="plain" title={t.fire} onPress={() => setFiring(true)} />
          </>
        )}
        {person && firing && (
          <>
            <H>{t.fireTitle(person.name)}</H>
            <P>{t.fireText}</P>
            <Button testID="staff-fire-confirm" title={t.fire} onPress={() => { fire(person.id); close(); }} />
          </>
        )}
      </Sheet>
    </Screen>
  );
}
