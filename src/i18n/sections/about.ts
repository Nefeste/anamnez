import { pluralRu } from '../plural';

const count = (n: number, one: string, few: string, many: string) => `${n}\u00a0${pluralRu(n, one, few, many)}`;

export const about = {
  title: 'Об игре',
  version: (v: string) => `Версия ${v}`,
  tagline: 'Симулятор врача с честной диагностикой. Игра в разработке.',
  whatsNew: 'Что нового',
  // то же, что раздел версии в README.md (05-process.md, чек-лист выпуска)
  news: [
    'Ответ на обследование или вопрос — посередине экрана, с отметкой «Новое».',
    '«Свои больные» — своей карточкой в «Настройках»: плитки со значками групп.',
    'Значки групп рисованы кодом, как план больницы, — и в выборе диагноза.',
  ],
  baseTitle: 'Медицинская база',
  base: (version: number, conditions: number, findings: number, exams: number, treatments: number) =>
    `Версия ${version}: ${count(conditions, 'болезнь', 'болезни', 'болезней')} и состояний, ${count(findings, 'признак', 'признака', 'признаков')}, ${count(exams, 'обследование', 'обследования', 'обследований')}, ${count(treatments, 'вид', 'вида', 'видов')} лечения.`,
  baseDraft: 'Статьи базы пока черновые: сверка с врачом-консультантом впереди. Всё упрощено для игры.',
  sources: (n: number) => `Источники — ${n}`,
  sourcesTitle: 'Источники',
  sourcesIntro:
    'Клинические рекомендации, учебники и статьи, по которым составлены болезни, признаки, обследования и лечение в игре. Игра их упрощает; решения о здоровье принимает врач.',
  kinds: {
    guideline: 'Клинические рекомендации',
    textbook: 'Учебники',
    review: 'Обзоры',
    paper: 'Статьи',
    score: 'Шкалы',
    dataset: 'Наборы данных',
  },
  // звук и музыка (часть 62): CC0 упоминания не требует, но автор «Vaporware» его просит (assets/audio/LICENSES.md)
  soundTitle: 'Звук и музыка',
  sound: 'Музыка: «Vaporware» — The Cynic Project, «Contemplation» — Joth. Звуки: набор «RPG Audio» — Kenney. Всё — под лицензией CC0, с OpenGameArt и kenney.nl; сигналы игры — свои.',
  developerTitle: 'Разработчик',
  // строка студии по брендбуку (ADR 0017): рядом — знак студии
  studio: 'Игра студии «Горница»',
  write: 'Написать разработчику',
  mailSubject: (v: string) => `Анамнез ${v}`,
  mailBody: (v: string, device: string) =>
    `(Что случилось или что предложить: что делали, чего ждали, что вышло.)\n\n\n—\nВерсия игры: ${v}\nУстройство: ${device}\nВерсия и устройство помогают найти ошибку; их можно стереть.`,
  site: 'Сайт',
  cantOpen: (what: string) => `Не открылось. Адрес: ${what}`,
  // лицензии открытых компонентов (spec 2026-10-licenses, 0.5.6; 12-publishing.md §8)
  openTitle: 'Открытые компоненты',
  open: 'В игре — шрифты, код и библиотеки других авторов под открытыми лицензиями.',
  licenses: (n: number) => `Лицензии — ${n}`,
  licensesTitle: 'Лицензии',
  licensesIntro:
    'Шрифты, код и библиотеки других авторов, из которых собрана игра, — под открытыми лицензиями. Их условия просят назвать авторов и приложить тексты лицензий: они здесь. Касание строки открывает текст.',
  licenseGroups: { fonts: 'Шрифты', js: 'Код JavaScript', android: 'Библиотеки Android' } as Record<string, string>,
  licenseName: (name: string, version: string) => `${name} ${version}`,
  licenseVia: (license: string, via: string) => `${license} · ${via}`,
  dataTitle: 'Данные',
  data: 'Игра ничего не собирает и не передаёт: у неё нет доступа в интернет. Сохранения и настройки хранятся только на этом телефоне.',
  privacy: 'Политика конфиденциальности',
};
