// Меню: смена (этап 2, в работе) и прототипы этапа 1. Оговорка — при каждом запуске, пока нет
// настроек (11-publishing.md §3).
import { type Href, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { T } from '@/i18n';
import { loadShift, useShift } from '@/state/session';
import { Button, Card, H, P, Screen } from '@/ui/components';

const ITEMS: { href: Href; title: string; hint: string; id: string }[] = [
  { href: '/spikes/engine', title: T.menu.engine, hint: T.menu.engineHint, id: 'engine' },
  { href: '/spikes/map', title: T.menu.map, hint: T.menu.mapHint, id: 'map' },
  { href: '/spikes/patient', title: T.menu.patient, hint: T.menu.patientHint, id: 'patient' },
  { href: '/spikes/imaging', title: T.menu.imaging, hint: T.menu.imagingHint, id: 'imaging' },
  { href: '/spikes/save', title: T.menu.save, hint: T.menu.saveHint, id: 'save' },
];

export default function Menu() {
  const [accepted, setAccepted] = useState(false);
  const shift = useShift();
  useEffect(() => {
    loadShift();
  }, []);
  return (
    <Screen>
      {!accepted && (
        <Card>
          <H>{T.common.disclaimerTitle}</H>
          <P>{T.common.disclaimer}</P>
          <Button testID="accept-disclaimer" title={T.common.understood} onPress={() => setAccepted(true)} />
        </Card>
      )}
      <P muted>{T.menu.subtitle}</P>
      <H>{T.menu.gameTitle}</H>
      <Button
        testID="menu-shift"
        title={T.menu.shift}
        hint={shift.status === 'ready' ? T.menu.shiftContinue(shift.day, shift.clock) : T.menu.shiftNew}
        onPress={() => router.push('/shift')}
      />
      <H>{T.menu.spikesTitle}</H>
      {ITEMS.map(it => (
        <Button key={it.id} testID={`menu-${it.id}`} title={it.title} hint={it.hint} onPress={() => router.push(it.href)} />
      ))}
    </Screen>
  );
}
