// Звуки, музыка и вибрация (03-game-design.md §13, 06-architecture.md §10). В движке звуков нет:
// их вызывает интерфейс по событиям. Короткие звуки загружаются один раз в проигрыватели.
// Громкость, фон и вибрация — из настроек игрока. Приход пациента, фон амбулатории и музыка (часть 62) — из
// наборов CC0 (tools/audio/clinic.ts, tools/audio/music.mjs, assets/audio/LICENSES.md).
import { type AudioPlayer, createAudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { AppState, Platform } from 'react-native';
import { settings } from '@/state/settings';

export type SoundName = 'tap' | 'ready' | 'urgent' | 'arrived';

const SOURCES: Record<SoundName | 'ambient', number> = {
  tap: require('../../assets/audio/tap.wav'),
  ready: require('../../assets/audio/ready.wav'),
  urgent: require('../../assets/audio/urgent.wav'),
  arrived: require('../../assets/audio/arrived.wav'),
  ambient: require('../../assets/audio/ambient.wav'),
};

const players: Partial<Record<SoundName | 'ambient', AudioPlayer>> = {};
// приход пациента — тише сигналов: он частый и ничего не требует
const volume = { ui: 0.6, events: 0.9, arrived: 0.6, ambient: 0.25 };

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
  p.volume = (name === 'tap' ? volume.ui : name === 'arrived' ? volume.arrived : volume.events) * level;
  p.seekTo(0).catch(() => undefined);
  p.play();
}

/** Фон нужен экрану, который сейчас на виду: смене. */
let ambientWanted = false;

/**
 * Фон амбулатории: петля, пока открыт экран смены. Выключен в настройках, звук на нуле или
 * игра свёрнута — не играет; развернули — играет дальше. В вебе — стенде для сценариев —
 * фона нет.
 */
export function setAmbient(on: boolean) {
  ambientWanted = on;
  applyAmbient(AppState.currentState === 'active');
}

function applyAmbient(active: boolean) {
  if (Platform.OS === 'web') return;
  const s = settings();
  const audible = ambientWanted && active && s.ambience && s.sound > 0;
  if (!audible && !players.ambient) return;
  const p = player('ambient');
  p.loop = true;
  p.volume = volume.ambient * s.sound;
  if (audible) p.play();
  else p.pause();
}

/** Где музыка: в меню — спокойная, на смене — своя и тише, под фоном амбулатории (часть 62). */
export type MusicScene = 'menu' | 'shift';

const MUSIC: Record<MusicScene, number> = {
  menu: require('../../assets/audio/music-menu.mp3'),
  shift: require('../../assets/audio/music-shift.mp3'),
};
// музыка — подложка: тише сигналов; на смене — вдвое тише, чем в меню
const musicVolume: Record<MusicScene, number> = { menu: 0.5, shift: 0.25 };
const music: Partial<Record<MusicScene, AudioPlayer>> = {};
let scene: MusicScene = 'menu';
/** настройки прочитаны: до того громкость музыки неизвестна, и выключившему её она не заиграет на миг */
let musicReady = false;

/** Сцена по экрану, который на виду; заиграет, когда настройки прочитаны (`startMusic`). */
export function setMusicScene(next: MusicScene) {
  scene = next;
  applyMusic(AppState.currentState === 'active');
}

/** Настройки прочитаны — музыка может играть. */
export function startMusic() {
  musicReady = true;
  applyMusic(AppState.currentState === 'active');
}

/**
 * Музыка: петля сцены, что на виду, другая — на паузе; громкость или сцену сменили — сразу. Музыка на нуле или игра
 * свёрнута — не играет. В вебе — стенде для сценариев — музыки нет, как и фона.
 */
export function applyMusic(active = AppState.currentState === 'active') {
  if (Platform.OS === 'web' || !musicReady) return;
  const level = settings().music;
  for (const k of ['menu', 'shift'] as const) {
    const audible = active && level > 0 && k === scene;
    if (!audible) {
      music[k]?.pause();
      continue;
    }
    const p = (music[k] ??= createAudioPlayer(MUSIC[k]));
    p.loop = true;
    p.volume = musicVolume[k] * level;
    p.play();
  }
}

AppState.addEventListener('change', state => {
  applyAmbient(state === 'active');
  applyMusic(state === 'active');
});

/** Вибрация на срочное и на готовый результат; в вебе её нет, в настройках её можно выключить. */
export function buzz(kind: 'urgent' | 'ready' | 'tap') {
  if (Platform.OS === 'web' || !settings().vibration) return;
  if (kind === 'urgent') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
  else if (kind === 'ready') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
  else Haptics.selectionAsync().catch(() => undefined);
}
