// Настройки (09-game-design.md §12, spec 2026-09-first-shift): звук и музыка (часть 62), вибрация, автопауза
// смены, мягкий режим, больные — реализм или разнообразие (spec 2026-10-variety), тема (spec
// 2026-09-own-look) и размер текста; перенос на другой телефон; «Сообщить об ошибке»; «Об игре»; прототипы первого этапа — ими на телефоне меряют отпечаток движка,
// кадры карты и запись сохранения.
import { type Href, router } from 'expo-router';
import { useEffect } from 'react';
import { Platform, useColorScheme } from 'react-native';
import { applyMusic, play } from '@/audio/sounds';
import { T } from '@/i18n';
import { SYSTEMS } from '@/content/types';
import { loadSettings, TEXT_SCALES, THEME_CHOICES, type ThemeChoice, updateSettings, useSettings, VOLUMES } from '@/state/settings';
import { Button, Card, Choice, H, P, Screen, Tabs, Toggle } from '@/ui/components';
import { SystemTiles } from '@/ui/SystemTiles';

type Level = '0' | '1' | '2' | '3';
type Size = '0' | '1' | '2';
type Patients = 'real' | 'varied';
const PATIENTS: readonly Patients[] = ['real', 'varied'];

/** Ближайшая ступень громкости — файл могла записать и другая версия игры. */
const levelOf = (volume: number): Level => {
  let best = 0;
  VOLUMES.forEach((v, i) => {
    if (Math.abs(v - volume) < Math.abs(VOLUMES[best] - volume)) best = i;
  });
  return String(best) as Level;
};

export default function SettingsScreen() {
  const s = useSettings();
  const scheme = useColorScheme();
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
    { href: '/spikes/bones', title: t.bones, hint: t.bonesHint, id: 'bones' },
  ];
  const setVolume = (k: Level) => {
    updateSettings({ sound: VOLUMES[Number(k)] });
    // услышать новую громкость; веб — стенд для сценариев, там звук не нужен
    if (Platform.OS !== 'web') play('ready');
  };
  // музыка (часть 62) — сразу новой громкостью; в вебе её нет
  const setMusic = (k: Level) => {
    updateSettings({ music: VOLUMES[Number(k)] });
    applyMusic();
  };

  return (
    <Screen>
      <Card>
        <H>{t.sound}</H>
        <P muted>{t.volume}</P>
        <Tabs<Level> testPrefix="sound" value={levelOf(s.sound)} onChange={setVolume} items={t.volumes.map((title, i) => ({ key: String(i) as Level, title }))} />
        <P muted>{t.music}</P>
        <Tabs<Level> testPrefix="music" value={levelOf(s.music)} onChange={setMusic} items={t.volumes.map((title, i) => ({ key: String(i) as Level, title }))} />
        <Toggle testID="settings-ambience" title={t.ambience} hint={t.ambienceHint} value={s.ambience} onChange={v => updateSettings({ ambience: v })} />
        <Toggle testID="settings-vibration" title={t.vibration} hint={t.vibrationHint} value={s.vibration} onChange={v => updateSettings({ vibration: v })} />
      </Card>
      <Card>
        <H>{t.shift}</H>
        <Toggle testID="settings-pause-red" title={t.pauseOnRed} hint={t.pauseHint} value={s.pauseOnRed} onChange={v => updateSettings({ pauseOnRed: v })} />
        <Toggle testID="settings-pause-results" title={t.pauseOnResults} value={s.pauseOnResults} onChange={v => updateSettings({ pauseOnResults: v })} />
        <Toggle testID="settings-soft" title={t.softMode} hint={t.softModeHint} value={s.softMode} onChange={v => updateSettings({ softMode: v })} />
        <P muted>{t.patients}</P>
        <Choice<Patients>
          testPrefix="patients"
          value={s.variety ? 'varied' : 'real'}
          onChange={k => updateSettings({ variety: k === 'varied' })}
          items={PATIENTS.map(key => ({ key, title: t.patientChoices[key], hint: t.patientHints[key] }))}
        />
        <P muted>{t.patientsNote}</P>
        <Toggle testID="settings-skills" title={t.skills} hint={t.skillsHint} value={s.skills} onChange={v => updateSettings({ skills: v })} />
      </Card>
      {/* «свои больные» (spec 2026-10-own-patients, часть 76) — своей карточкой, плитками со значками (0.5.20): группы —
          как в выборе диагноза */}
      <Card testID="settings-mine">
        <H>{t.mine}</H>
        <P muted>{t.mineLead}</P>
        <SystemTiles testPrefix="mine" value={s.mine} onChange={mine => updateSettings({ mine })} />
        <P testID="settings-mine-status">{s.mine.length === 0 ? t.mineNone : t.mineSome(s.mine.length, SYSTEMS.length)}</P>
        {s.mine.length > 0 && <Button testID="settings-mine-clear" kind="plain" title={t.mineClear} onPress={() => updateSettings({ mine: [] })} />}
        <P muted>{t.mineNote}</P>
      </Card>
      <Card>
        <H>{t.screen}</H>
        <P muted>{t.theme}</P>
        <Choice<ThemeChoice>
          testPrefix="theme"
          value={s.theme}
          onChange={k => updateSettings({ theme: k })}
          items={THEME_CHOICES.map(key => ({ key, title: t.themes[key], hint: key === 'system' ? t.themeHints.system(scheme === 'dark') : t.themeHints[key] }))}
        />
        <P muted>{t.textSize}</P>
        <Tabs<Size>
          testPrefix="text-size"
          value={String(Math.max(0, TEXT_SCALES.findIndex(k => k === s.textScale))) as Size}
          onChange={k => updateSettings({ textScale: TEXT_SCALES[Number(k)] })}
          items={t.textSizes.map((title, i) => ({ key: String(i) as Size, title }))}
        />
      </Card>
      <Button testID="settings-transfer" kind="plain" title={T.transfer.title} hint={T.transfer.menuHint} onPress={() => router.push('/transfer')} />
      <Button testID="settings-report" kind="plain" title={t.report} hint={t.reportHint} onPress={() => router.push('/report')} />
      <Button testID="settings-about" kind="plain" title={t.about} hint={t.aboutHint} onPress={() => router.push('/about')} />
      {/* режим разработчика (0.6.3, просьба владельца 17.10.2026): проверки первого этапа — только в нём; включают семь
          касаний строки версии в «Об игре», выключатель — здесь */}
      {s.devMode ? (
        <>
          <H>{t.checks}</H>
          <Toggle testID="settings-dev" title={t.devMode} hint={t.devModeHint} value onChange={() => updateSettings({ devMode: false })} />
          <P muted>{t.checksHint}</P>
          {checks.map(it => (
            <Button key={it.id} testID={`check-${it.id}`} kind="plain" title={it.title} hint={it.hint} onPress={() => router.push(it.href)} />
          ))}
        </>
      ) : null}
    </Screen>
  );
}
