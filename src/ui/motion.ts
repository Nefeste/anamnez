// «Меньше движения» (ADR 0023 устава, правило 6; 09-game-design.md §13): выключатель в настройках, а пока игрок его не
// трогал — как в телефоне («уменьшить движение» Android). Декоративные анимации — выезд экранов, появление строк карты
// пациента, бег отрезка по ЭКГ загрузки, плавный зум плана — при нём не играются. Люди на карте ходят как прежде: где
// кто — это сведения о смене, а не украшение.
import { ReduceMotion, useReducedMotion } from 'react-native-reanimated';
import { lessMotionOf, useSettings } from '@/state/settings';

/** Меньше ли движения сейчас — для экранов и выключателя в настройках. */
export function useLessMotion(): boolean {
  const { lessMotion } = useSettings();
  // флаг телефона Reanimated читает при запуске приложения
  return lessMotionOf(lessMotion, useReducedMotion());
}

/**
 * То же — для анимаций Reanimated: `FadeInDown.reduceMotion(…)`, `withTiming(…, { reduceMotion })`. Всегда явно: по
 * умолчанию Reanimated смотрит только на телефон, а выбор игрока главнее.
 */
export function useReduceMotion(): ReduceMotion {
  return useLessMotion() ? ReduceMotion.Always : ReduceMotion.Never;
}
