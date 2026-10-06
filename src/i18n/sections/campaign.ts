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
  // глава 2 (spec 2026-09-chapter-2, часть 34)
  triageProgress: (n: number, of: number) => `лучшая смена: ${n} из ${of}\u00a0${pluralRu(of, 'пациента', 'пациентов', 'пациентов')} скорой`,
  operationsProgress: (n: number, of: number) => `${n} из ${of}\u00a0${pluralRu(of, 'операции', 'операций', 'операций')}`,
  stayProgress: (n: number, of: number, stay?: { days: number; norm: number }) =>
    `${n} из ${of}\u00a0${pluralRu(of, 'выписанного', 'выписанных', 'выписанных')} подряд${stay ? ` · в среднем ${String(stay.days).replace('.', ',')}\u00a0сут. при обычных ${String(stay.norm).replace('.', ',')}` : ''}`,
  // глава 3 (spec 2026-10-chapter-3, часть 45а): срок у больных подряд, тромболизисы в окне
  deadlineProgress: (n: number, of: number) => `${n} из ${of}\u00a0${pluralRu(of, 'больного', 'больных', 'больных')} подряд`,
  lysisProgress: (n: number, of: number) => `${n} из ${of}`,
  notYet: 'пока нет',
  doneOn: (day: number) => `выполнено, день ${day}`,
  completeLater: (next: number) => `Основные задания главы выполнены. Глава ${next} — в следующей версии; работать здесь можно и дальше.`,
  completeNext: 'Основные задания главы выполнены. Работать здесь можно и дальше — или перейти в следующую главу.',
  moveTo: (order: number) => `Перейти в главу ${order}`,
  moveHint: 'между сменами',
  moveTitle: (move: string) => `${move}?`,
  moveText: (from: string) =>
    `Больница, штат и касса будут новыми; врач, сложность, достижения и энциклопедия — прежними. Прежняя больница — ${from} — останется в «Смене» быстрой игры.`,
  // глава с крылом (часть 45а): та же больница
  moveWingText: (budget: string) =>
    `Больница остаётся та же: штат, касса, построенное и лежащие — прежние. Участок прирастает крылом справа, а на стройку в кассу придёт ${budget}. Больница без крыла останется в «Смене» быстрой игры.`,
  move: 'Перейти',
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
