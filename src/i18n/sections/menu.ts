export const menu = {
  subtitle: (version: string) => `Симулятор врача · версия ${version}`,
  // обложка «Медкарты»: под названием — курсивом, под двойной чертой — версия
  tag: 'симулятор врача',
  versionLine: (version: string) => `версия ${version}`,
  continue: 'Продолжить',
  continueHint: (day: number, hh: string, level: string) => `практика в амбулатории: день ${day}, ${hh} · ${level}`,
  practice: 'Практика в амбулатории',
  practiceHint: 'быстрая игра: смена 08:00–14:00, день за днём',
  practiceAgainHint: 'начать заново, с первого дня',
  practiceSavedHint: (day: number, hh: string) => `день ${day}, ${hh} — продолжить или начать заново`,
  restartTitle: 'Начать практику заново?',
  restartText: (day: number) => `Сохранение одно: нынешняя практика — день ${day} — сотрётся.`,
  restart: 'Начать заново',
  cancel: 'Отмена',
  campaign: 'Кампания',
  encyclopedia: 'Энциклопедия',
  encyclopediaHint: 'болезни, признаки, обследования, лечение',
  profile: 'Профиль',
  soon: 'скоро',
  settings: 'Настройки',
  // бейдж врача (вопрос 47, ответ владельца 17.10.2026 — вариант А): портрет в халате, имя, звание, сколько принято и
  // доля верных диагнозов; касание — профиль
  badgeStats: (cases: number, pct: number) => `принято ${cases} · верно ${pct}\u00a0%`,
  badgeEmpty: 'пока ни одного приёма',
  badgeLabel: (name: string, rank: string, stats: string) => `Профиль: ${name}, ${rank.toLowerCase()}; ${stats}`,
  // личная печать врача на бейдже «Медкарты» — оттиск, для чтения с экрана не нужен
  stamp: (last: string, first: string) => `врач\n${last} ${first.slice(0, 1)}.`,
  // цифры бейджа «Монитора» — как на мониторе у постели
  readCases: 'Принято',
  readCorrect: 'Верный диагноз',
  // имя и числа — на бейдже, у пункта «Профиль» — что внутри
  profileHint: 'итоги, достижения, архив приёмов',
};
