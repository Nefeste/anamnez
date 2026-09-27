// Настройки (03-game-design.md §12, spec 2026-09-first-shift): звук, вибрация, автопауза
// смены; «Об игре»; прототипы первого этапа — ими на телефоне меряют отпечаток движка,
// кадры карты и запись сохранения.
import { type Href, router } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { play } from '@/audio/sounds';
import { T } from '@/i18n';
import { loadSettings, updateSettings, useSettings, VOLUMES } from '@/state/settings';
import { Button, Card, H, P, Screen, Tabs, Toggle } from '@/ui/components';

type Level = '0' | '1' | '2' | '3';

/** Ближайшая ступень громкости — файл могла записать и другая версия игры. */
const levelOf = (sound: number): Level => {
  let best = 0;
  VOLUMES.forEach((v, i) => {
    if (Math.abs(v - sound) < Math.abs(VOLUMES[best] - sound)) best = i;
  });
  return String(best) as Level;
};

export default function SettingsScreen() {
  const s = useSettings();
  useEffect(() => {
    loadSettings();
  }, []);
  const t = T.settings;
  const checks: { href: Href; title: string; hint: string; id: string }[] = [
    { href: '/spikes/engine', title: t.engine, hint: t.engineHint, id: 'engine' },
    { href: '/spikes/map', title: t.map, hint: t.mapHint, id: 'map' },
    { href: '/spikes/patient', title: t.patient, hint: t.patientHint, id: 'patient' },
    { href: '/spikes/imaging', title: t.imaging, hint: t.imagingHint, id: 'imaging' },
    { href: '/spikes/save', title: t.save, hint: t.saveHint, id: 'save' },
  ];
  const setVolume = (k: Level) => {
    updateSettings({ sound: VOLUMES[Number(k)] });
    // услышать новую громкость; веб — стенд для сценариев, там звук не нужен
    if (Platform.OS !== 'web') play('ready');
  };

  return (
    <Screen>
      <Card>
        <H>{t.sound}</H>
        <P muted>{t.volume}</P>
        <Tabs<Level> testPrefix="sound" value={levelOf(s.sound)} onChange={setVolume} items={t.volumes.map((title, i) => ({ key: String(i) as Level, title }))} />
        <Toggle testID="settings-vibration" title={t.vibration} hint={t.vibrationHint} value={s.vibration} onChange={v => updateSettings({ vibration: v })} />
      </Card>
      <Card>
        <H>{t.shift}</H>
        <Toggle testID="settings-pause-red" title={t.pauseOnRed} hint={t.pauseHint} value={s.pauseOnRed} onChange={v => updateSettings({ pauseOnRed: v })} />
        <Toggle testID="settings-pause-results" title={t.pauseOnResults} value={s.pauseOnResults} onChange={v => updateSettings({ pauseOnResults: v })} />
      </Card>
      <Button testID="settings-about" kind="plain" title={t.about} hint={t.aboutHint} onPress={() => router.push('/about')} />
      <H>{t.checks}</H>
      <P muted>{t.checksHint}</P>
      {checks.map(it => (
        <Button key={it.id} testID={`check-${it.id}`} kind="plain" title={it.title} hint={it.hint} onPress={() => router.push(it.href)} />
      ))}
    </Screen>
  );
}
