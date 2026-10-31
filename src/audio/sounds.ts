// Звуки, музыка и вибрация (09-game-design.md §13, 02-architecture.md §10). В движке звуков нет:
// их вызывает интерфейс по событиям. Короткие звуки загружаются один раз в проигрыватели.
// Громкость, фон и вибрация — из настроек игрока. Приход пациента, фон амбулатории и музыка (часть 62) — из
// наборов CC0, далёкие голоса в фоне и телефон регистратуры (0.6.6) — из записей под CC BY, авторы — в «Лицензиях»
// (ADR 0019; tools/audio/clinic.ts, tools/audio/music.mjs, assets/audio/LICENSES.md). Тревога монитора при остановке
// сердца (0.5.7) — синтезирована, как касание и сигналы (tools/audio/gen.ts). Приборы и процедуры (spec
// 2026-10-premium-polish): манжета, монитор, рентген, пробирки — тоже синтез; какой звук у какого обследования —
// src/ui/case/sounds.ts.
import { type AudioPlayer, createAudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { AppState, Platform } from 'react-native';
import { settings } from '@/state/settings';
import type { MusicScene } from './scene';

export type SoundName = 'tap' | 'ready' | 'urgent' | 'arrived' | 'alarm' | DeviceSound;
/** Звуки приборов и процедур: играют по действию врача, тише сигналов. */
export type DeviceSound = 'cuff' | 'monitor' | 'xray' | 'tubes';
const DEVICES: readonly DeviceSound[] = ['cuff', 'monitor', 'xray', 'tubes'];
/** Звуки фона: петля амбулатории и телефон регистратуры, что звонит в ней изредка. */
type Background = 'ambient' | 'phone';

const SOURCES: Record<SoundName | Background, number> = {
  tap: require('../../assets/audio/tap.wav'),
  ready: require('../../assets/audio/ready.wav'),
  urgent: require('../../assets/audio/urgent.wav'),
  arrived: require('../../assets/audio/arrived.wav'),
  alarm: require('../../assets/audio/alarm.wav'),
  ambient: require('../../assets/audio/ambient.wav'),
  phone: require('../../assets/audio/phone.wav'),
  cuff: require('../../assets/audio/cuff.wav'),
  monitor: require('../../assets/audio/monitor.wav'),
  xray: require('../../assets/audio/xray.wav'),
  tubes: require('../../assets/audio/tubes.wav'),
};

const players: Partial<Record<SoundName | Background, AudioPlayer>> = {};
// приход пациента — тише сигналов: он частый и ничего не требует; приборы — ещё тише: звучат на каждое действие
const volume = { ui: 0.6, events: 0.9, arrived: 0.6, device: 0.5, ambient: 0.25 };

function player(name: SoundName | Background): AudioPlayer {
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
  const base = name === 'tap' ? volume.ui : name === 'arrived' ? volume.arrived : (DEVICES as readonly string[]).includes(name) ? volume.device : volume.events;
  p.volume = base * level;
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

/**
 * Телефон регистратуры (0.6.6): пока играет фон, звонит изредка — первый раз через одну-две минуты, дальше раз в
 * 2–5 минут; три звонка, и трубку сняли. Не в петле фона: звонок каждые 40 с надоел бы.
 */
const PHONE_FIRST_MS: [number, number] = [45_000, 120_000];
const PHONE_EVERY_MS: [number, number] = [120_000, 300_000];
let phoneTimer: ReturnType<typeof setTimeout> | null = null;

function ringLater([from, to]: [number, number]) {
  phoneTimer = setTimeout(() => {
    phoneTimer = null;
    const p = player('phone');
    p.volume = volume.ambient * settings().sound;
    p.seekTo(0).catch(() => undefined);
    p.play();
    ringLater(PHONE_EVERY_MS);
  }, from + Math.random() * (to - from));
}

function applyAmbient(active: boolean) {
  if (Platform.OS === 'web') return;
  const s = settings();
  const audible = ambientWanted && active && s.ambience && s.sound > 0;
  if (!audible && !players.ambient) return;
  const p = player('ambient');
  p.loop = true;
  p.volume = volume.ambient * s.sound;
  if (audible) {
    p.play();
    if (!phoneTimer) ringLater(PHONE_FIRST_MS);
  } else {
    p.pause();
    if (phoneTimer) clearTimeout(phoneTimer);
    phoneTimer = null;
    players.phone?.pause();
  }
}

export type { MusicScene } from './scene';

const MUSIC: Record<MusicScene, number> = {
  menu: require('../../assets/audio/music-menu.mp3'),
  shift: require('../../assets/audio/music-shift.mp3'),
};
// музыка — подложка: тише сигналов; на смене — вдвое тише, чем в меню
const musicVolume: Record<MusicScene, number> = { menu: 0.5, shift: 0.25 };
const music: Partial<Record<MusicScene, AudioPlayer>> = {};
let scene: MusicScene = 'menu';
/** Сцена, что играет или заиграет. */
export const musicScene = () => scene;
/** настройки прочитаны: до того громкость музыки неизвестна, и выключившему её она не заиграет на миг */
let musicReady = false;

/** Сцену сменили — плавно (0.5.12, отзыв на 0.5.11): прежняя петля затихает, новая нарастает за столько миллисекунд. */
const FADE_MS = 1000;
const FADE_STEP_MS = 50;
let fade: ReturnType<typeof setInterval> | null = null;

/** Сцена по экрану, который на виду; заиграет, когда настройки прочитаны (`startMusic`). Сменилась — плавно. */
export function setMusicScene(next: MusicScene) {
  if (next === scene) return;
  scene = next;
  applyMusic(AppState.currentState === 'active', true);
}

/** Настройки прочитаны — музыка может играть. */
export function startMusic() {
  musicReady = true;
  applyMusic(AppState.currentState === 'active');
}

/**
 * Музыка: петля сцены, что на виду, другая — на паузе; громкость сменили — сразу, сцену — плавно (`smooth`). Музыка на
 * нуле или игра свёрнута — не играет. В вебе — стенде для сценариев — музыки нет, как и фона.
 */
export function applyMusic(active = AppState.currentState === 'active', smooth = false) {
  if (Platform.OS === 'web' || !musicReady) return;
  if (fade) {
    clearInterval(fade);
    fade = null;
  }
  const level = settings().music;
  const scenes = ['menu', 'shift'] as const;
  const target = (k: MusicScene) => (active && level > 0 && k === scene ? musicVolume[k] * level : 0);
  if (!smooth) {
    for (const k of scenes) {
      if (target(k) === 0) {
        music[k]?.pause();
        continue;
      }
      const p = (music[k] ??= createAudioPlayer(MUSIC[k]));
      p.loop = true;
      p.volume = target(k);
      p.play();
    }
    return;
  }
  // прежняя затихает с той громкости, что есть; новая начинает с тишины
  const from: Record<MusicScene, number> = { menu: 0, shift: 0 };
  for (const k of scenes) {
    const p = music[k];
    if (p?.playing) from[k] = p.volume;
    if (target(k) === 0) continue;
    const q = (music[k] ??= createAudioPlayer(MUSIC[k]));
    q.loop = true;
    if (!q.playing) {
      q.volume = 0;
      q.play();
    }
  }
  const t0 = Date.now();
  const step = () => {
    const x = Math.min(1, (Date.now() - t0) / FADE_MS);
    for (const k of scenes) {
      const p = music[k];
      if (p) p.volume = from[k] + (target(k) - from[k]) * x;
    }
    if (x < 1) return;
    if (fade) clearInterval(fade);
    fade = null;
    for (const k of scenes) if (target(k) === 0) music[k]?.pause();
  };
  fade = setInterval(step, FADE_STEP_MS);
}

AppState.addEventListener('change', state => {
  applyAmbient(state === 'active');
  applyMusic(state === 'active');
});

/** Вибрация на срочное, тревогу и готовый результат; в вебе её нет, в настройках её можно выключить. */
export function buzz(kind: 'alarm' | 'urgent' | 'ready' | 'tap') {
  if (Platform.OS === 'web' || !settings().vibration) return;
  if (kind === 'alarm') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
  else if (kind === 'urgent') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
  else if (kind === 'ready') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
  else Haptics.selectionAsync().catch(() => undefined);
}
