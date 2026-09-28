// П6 · Сохранение 60 пациентов (атомарно, с копиями) и звук с вибрацией.
import { useState } from 'react';
import { buzz, play, setAmbient } from '@/audio/sounds';
import { db } from '@/content';
import { spikePatients } from '@/state/spikeData';
import { loadSlot, saveSlot } from '@/state/saves';
import { corrupt, rawStore } from '@/state/storage';
import { T } from '@/i18n';
import { Button, Card, H, P, Screen } from '@/ui/components';

export default function SaveSpike() {
  const [status, setStatus] = useState('');
  const [ambient, setAmbientOn] = useState(false);
  const save = async () => {
    const data = spikePatients(db, 60);
    const t0 = Date.now();
    const cost = await saveSlot(rawStore, 'spike', data, 1, new Date().toISOString());
    setStatus(T.spikes.save.saved(Math.round(cost.bytes / 1024), Date.now() - t0, cost.jsonMs, cost.writeMs));
  };
  const load = async () => {
    const r = await loadSlot<unknown[]>(rawStore, 'spike');
    if (!r) return setStatus(T.spikes.save.nothing);
    setStatus(T.spikes.save.loaded(r.envelope.data.length, r.from === 'current' ? T.spikes.save.fromCurrent : T.spikes.save.fromBackup));
  };
  return (
    <Screen>
      <Card>
        <Button testID="save-save" title={T.spikes.save.saveBtn} onPress={save} />
        <Button testID="save-load" kind="plain" title={T.spikes.save.loadBtn} onPress={load} />
        <Button testID="save-corrupt" kind="plain" title={T.spikes.save.corruptBtn} onPress={() => corrupt('spike.json').then(load)} />
        <P testID="save-status">{status}</P>
      </Card>
      <Card>
        <H>{T.spikes.save.sounds}</H>
        <Button kind="plain" title={T.spikes.save.tap} onPress={() => { play('tap'); buzz('tap'); }} />
        <Button kind="plain" title={T.spikes.save.ready} onPress={() => { play('ready'); buzz('ready'); }} />
        <Button kind="plain" title={T.spikes.save.urgent} onPress={() => { play('urgent'); buzz('urgent'); }} />
        <Button kind="plain" title={T.spikes.save.arrived} onPress={() => play('arrived')} />
        <Button kind="plain" title={ambient ? T.spikes.save.ambientOn : T.spikes.save.ambientOff} onPress={() => { setAmbient(!ambient); setAmbientOn(!ambient); }} />
      </Card>
    </Screen>
  );
}
