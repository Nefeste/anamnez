// Звуки и вибрация (03-game-design.md §13, 06-architecture.md §10). В движке звуков нет:
// их вызывает интерфейс по событиям. Короткие звуки загружаются один раз в проигрыватели.
// Громкость и вибрация — из настроек игрока.
import { type AudioPlayer, createAudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';
import { settings } from '@/state/settings';

export type SoundName = 'tap' | 'ready' | 'urgent';

const SOURCES: Record<SoundName | 'ambient', number> = {
  tap: require('../../assets/audio/tap.wav'),
  ready: require('../../assets/audio/ready.wav'),
  urgent: require('../../assets/audio/urgent.wav'),
  ambient: require('../../assets/audio/ambient.wav'),
};

const players: Partial<Record<SoundName | 'ambient', AudioPlayer>> = {};
const volume = { ui: 0.6, events: 0.9, ambient: 0.2 };

function player(name: SoundName | 'ambient'): AudioPlayer {
  let p = players[name];
  if (!p) {
    p = createAudioPlayer(SOURCES[name]);
    players[name] = p;
  }
  return p;
}

export function play(name: SoundName) {
  const level = settings().sound;
  if (level === 0) return;
  const p = player(name);
  p.volume = (name === 'tap' ? volume.ui : volume.events) * level;
  p.seekTo(0).catch(() => undefined);
  p.play();
}

export function setAmbient(on: boolean) {
  const p = player('ambient');
  p.loop = true;
  p.volume = volume.ambient * settings().sound;
  if (on) p.play();
  else p.pause();
}

/** Вибрация на срочное и на готовый результат; в вебе её нет, в настройках её можно выключить. */
export function buzz(kind: 'urgent' | 'ready' | 'tap') {
  if (Platform.OS === 'web' || !settings().vibration) return;
  if (kind === 'urgent') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
  else if (kind === 'ready') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
  else Haptics.selectionAsync().catch(() => undefined);
}
