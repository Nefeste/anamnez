// «Случай дня» (spec 2026-09-campaign, часть 14): один пациент в сутки, любой из последних 30
// дней — когда угодно, без серии.
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export const daily = {
  title: 'Случай дня',
  menuHint: 'один пациент в день, одинаковый у всех',
  menuToday: (grade: string) => `сегодня сыгран: ${grade}`,
  intro: 'Каждый день — один пациент, одинаковый у всех, у кого та же версия базы. Любой из последних 30 дней можно сыграть когда угодно; засчитывается первая попытка, переиграть можно.',
  base: (n: number) => `База ${n}.`,
  today: 'Сегодня',
  yesterday: 'Вчера',
  date: (d: number, month: number) => `${d} ${MONTHS[month]}`,
  verdict: { correct: 'верно', partly: 'почти', wrong: 'неверно' } as Record<string, string>,
  played: (grade: string, verdict: string) => `Сыгран: ${grade} · ${verdict}`,
  playedBase: (grade: string, verdict: string, base: number) => `Сыгран: ${grade} · ${verdict} · база ${base}`,
  notPlayed: 'можно сыграть',
  firstTry: (grade: string, verdict: string) => `Засчитана первая попытка: ${grade}, ${verdict}.`,
  toList: 'К списку дней',
};
