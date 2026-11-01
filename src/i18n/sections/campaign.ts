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
  careerLine: (chapter: string, day: number, done: number, of: number, short = false) =>
    `${chapter} · день ${day} · основные задания: ${done} из ${of}${short ? ' · главы короче' : ''}`,
  continue: 'Продолжить',
  restart: 'Начать заново',
  restartTitle: (n: number) => `Начать карьеру ${n} заново?`,
  restartText: 'Её сохранение сотрётся. Две другие карьеры останутся как были.',
  newTitle: 'Новая карьера',
  newText:
    'Вы — молодой врач в посёлке Заречный. Глава за главой: участок, приёмное отделение, большая больница. Сроков нет: глава идёт, пока не выполнены основные задания.',
  begin: 'Начать',
  cancel: 'Отмена',
  // «Главы короче» (часть 93, spec 2026-10-short-chapters, ответ владельца на вопрос 54)
  chapters: 'Главы',
  chapterChoices: { asis: 'Как есть', short: 'Короче' },
  chapterHints: {
    asis: 'глава 1 — 40\u00a0пациентов, глава 3 — по пять больных с ЭКГ и КТ в срок; больные — как в жизни',
    short: 'глава 1 — 25\u00a0пациентов, глава 3 — по три больных в срок; каждый день один-два — с более редкой болезнью',
  },
  chaptersNote: 'Выбирается при начале карьеры. Подсказки и разбор — по частотам жизни.',

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
  // с 0.5.15 — без «подряд» (spec 2026-10-rules)
  deadlineProgress: (n: number, of: number) => `${n} из ${of}\u00a0${pluralRu(of, 'больного', 'больных', 'больных')}`,
  lysisProgress: (n: number, of: number) => `${n} из ${of}`,
  // глава 4 (spec 2026-10-chapter-4, часть 60а): приёмы специалистов; дни подряд, когда тяжёлых умерло и выписано раньше
  // срока не больше порога (с 0.5.15, spec 2026-10-rules)
  staffProgress: (seen: number, of: number, accuracy: number, doctors: number, need: number) =>
    `${seen} из ${of}, точность ${accuracy}\u00a0%, специалистов ${doctors} из ${need}`,
  mortalityProgress: (days: number, of: number, x: { died: number; early: number; lying: number } | undefined, min: number) => {
    if (days < of || !x) return `${days} из ${of}\u00a0${pluralRu(of, 'дня', 'дней', 'дней')}`;
    const last = `за ${pluralRu(of, 'последний', 'последние', 'последние')} ${of}\u00a0${pluralRu(of, 'день', 'дня', 'дней')}`;
    const lay = `${pluralRu(x.lying, 'был', 'было', 'было')} ${x.lying}\u00a0${pluralRu(x.lying, 'тяжёлый', 'тяжёлых', 'тяжёлых')}`;
    if (x.lying < min) return `${last} ${lay} — нужно не меньше ${min}`;
    if (x.died + x.early === 0) return `${last} ${lay}, умерших и выписанных раньше срока нет`;
    const pct = ((100 * (x.died + x.early)) / x.lying).toFixed(1).replace('.', ',');
    const lost = [
      ...(x.died > 0 ? [`${pluralRu(x.died, 'умер', 'умерли', 'умерли')} ${x.died}`] : []),
      ...(x.early > 0 ? [`${pluralRu(x.early, 'выписан', 'выписаны', 'выписаны')} раньше срока ${x.early}`] : []),
    ];
    return `${last} из ${x.lying}\u00a0${pluralRu(x.lying, 'тяжёлого', 'тяжёлых', 'тяжёлых')} ${lost.join(', ')} — ${pct}\u00a0%`;
  },
  notYet: 'пока нет',
  doneOn: (day: number) => `выполнено, день ${day}`,
  // карточка над главой, когда основные задания выполнены (spec 2026-10-premium-polish)
  completeTitle: 'Глава пройдена',
  // глава 4 — последняя (spec 2026-10-chapter-4, часть 60а): следующей не обещаем
  // с 1.1.3 (часть 99, spec 2026-10-publish-ready): без «пока» — у кампании финал
  completeLast: 'Все главы пройдены. Больница остаётся вашей — работать здесь можно и дальше.',
  completeNext: 'Основные задания главы выполнены. Работать здесь можно и дальше — или перейти в следующую главу.',
  // карьера пройдена (часть 99, spec 2026-10-publish-ready; ответ владельца на вопрос 66)
  careerTitle: 'Карьера пройдена',
  careerPath: (names: readonly string[]) => names.join(' → '),
  careerDays: 'Дней в карьере',
  careerSeen: 'Принято вами',
  careerCorrect: 'Верный диагноз',
  careerChapters: 'Главы',
  careerOn: 'Работать дальше',
  careerMenu: 'В меню',
  // карточка «Карьеры» в профиле
  careersTitle: 'Карьеры',
  careerDone: 'карьера пройдена',
  // сводка карьеры в меню (часть 102, ответ владельца на вопрос 69)
  stripLine: (chapter: string, day: number) => `${chapter} · день ${day}`,
  stripMissions: 'Основные задания',
  stripOf: (done: number, of: number) => `${done} из ${of}`,
  stripNew: 'Кампания — четыре главы',
  moveTo: (order: number) => `Перейти в главу ${order}`,
  moveHint: 'между сменами',
  moveTitle: (move: string) => `${move}?`,
  // лежащих при переезде долечат врачи прежней больницы (spec 2026-10-chapter-4, часть 61б)
  moveText: (from: string, lying = 0) =>
    `Больница, штат и касса будут новыми; врач, сложность, достижения и энциклопедия — прежними. Прежняя больница — ${from} — останется в «Смене» быстрой игры.${lying > 0 ? ` Лежащих в ней — ${lying} — долечат её врачи.` : ''}`,
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
  quickHint: 'практика, случай дня, испытания и сценарии, песочница',
};
