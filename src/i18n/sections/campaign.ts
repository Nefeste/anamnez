import { pluralRu } from '../plural';

// Кампания (spec 2026-09-campaign): карьеры, глава, письма, задания; «Быстрая игра».
export const campaign = {
  menuHint: 'карьера врача: главы, задания, письма наставника',
  title: 'Кампания',
  careers: 'Карьеры',
  careersHint: 'Три карьеры — у каждой своё сохранение.',
  career: (n: number) => `Карьера ${n}`,
  newCareer: 'Новая карьера',
  newCareerHint: 'с главы 1 «Участок»',
  careerLine: (chapter: string, day: number, done: number, of: number) =>
    `${chapter} · день ${day} · основные задания: ${done} из ${of}`,
  continue: 'Продолжить',
  restart: 'Начать заново',
  restartTitle: (n: number) => `Начать карьеру ${n} заново?`,
  restartText: 'Её сохранение сотрётся. Две другие карьеры останутся как были.',
  newTitle: 'Новая карьера',
  newText:
    'Вы — молодой врач в посёлке Заречный. Глава за главой: участок, приёмное отделение, большая больница. Сроков нет: глава идёт, пока не выполнены основные задания.',
  begin: 'Начать',
  cancel: 'Отмена',

  // глава между сменами
  chapter: (order: number, name: string) => `Глава ${order}. ${name}`,
  day: (day: number) => (day === 0 ? 'перед первой сменой' : `день ${day}`),
  letters: 'Письма',
  noLetters: 'Писем пока нет.',
  unread: 'новое',
  letterDay: (day: number) => (day === 0 ? 'в начале главы' : `день ${day}`),
  missions: 'Задания',
  main: 'Основные',
  optional: 'Дополнительные',
  seenProgress: (seen: number, of: number, accuracy: number) => `${seen} из ${of}, точность ${accuracy}\u00a0%`,
  dayProgress: (n: number, of: number) => `${n} из ${of}\u00a0${pluralRu(of, 'дня', 'дней', 'дней')}`,
  notYet: 'пока нет',
  doneOn: (day: number) => `выполнено, день ${day}`,
  complete: 'Основные задания главы выполнены. Глава 2 — в следующей версии; работать здесь можно и дальше.',
  close: 'Закрыть',

  // подсказки наставника в первую смену главы
  tipGotIt: 'Понятно',
  tipsOff: 'Без подсказок',
  tipsOffHint: 'в этой карьере наставник больше не подсказывает',
  tipFrom: (who: string) => `Подсказывает ${who}`,

  // итоги дня
  todayDone: (text: string) => `Выполнено: ${text}`,
  todayLetters: (n: number) => `${n}\u00a0${pluralRu(n, 'новое письмо', 'новых письма', 'новых писем')} — в главе`,

  // быстрая игра
  quick: 'Быстрая игра',
  quickHint: 'практика, песочница',
};
