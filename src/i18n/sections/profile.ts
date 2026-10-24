// Профиль врача (spec 2026-09-first-shift, «Профиль-минимум»): имя и пол, практика, архив приёмов;
// достижения (spec 2026-09-campaign, часть 13).
import { pluralRu } from '../plural';
import { lowerFirst } from '../case';

// между числом и единицей — неразрывный пробел (голос студии)
const times = (n: number) => `${n}\u00a0${pluralRu(n, 'раз', 'раза', 'раз')}`;

export const profile = {
  title: 'Профиль',
  // первый запуск и правка имени
  doctorTitle: 'Кто вы в игре',
  doctorText: 'Имя, пол и портрет врача — для обращений в игре. Их можно поменять в профиле.',
  sex: { f: 'Женщина', m: 'Мужчина' } as Record<string, string>,
  first: 'Имя',
  last: 'Фамилия',
  another: 'Другое имя',
  start: 'Начать',
  save: 'Сохранить',
  edit: 'Изменить имя',
  editTitle: 'Имя врача',
  doctor: (first: string, last: string) => `${first} ${last}`,
  // практика — всё время, во всех сменах; с 0.6.2 — плитками и графиками (правила визуализации данных)
  practice: 'Практика',
  noCases: 'Пока ни одного приёма: итоги появятся после первого.',
  kpi: { cases: 'Принято', correct: 'Верный диагноз', minutes: 'В среднем на приём', money: 'Обследования на приём' },
  percent: (n: number) => `${n}\u00a0%`,
  minutesValue: (n: number) => `${n}\u00a0мин`,
  diagnoses: 'Диагнозы',
  verdict: { correct: 'Верно', partly: 'Почти верно', wrong: 'Неверно' },
  // значок рядом с цветом: итог читается и без цвета
  verdictIcon: { correct: '✓', partly: '≈', wrong: '✗' },
  share: (n: number, pct: number) => `${n} · ${pct}\u00a0%`,
  gradesTitle: 'Оценки приёмов',
  care: 'Как вы лечите',
  antibiotics: 'Антибиотик\u00a0— по показаниям',
  danger: 'Нужны стационар или скорая\u00a0— направлены',
  seen: (n: number, total: number) => `Встречалось болезней: ${n} из ${total}`,
  outOf: (n: number, of: number) => `${n} из ${of}`,
  ranks: ['Интерн', 'Ординатор', 'Врач', 'Врач высшей категории'],
  rankLadder: (steps: { name: string; cases: number }[]) =>
    `Звание растёт с принятыми пациентами: ${steps.map((x, i) => (i === 0 ? lowerFirst(x.name) : `${lowerFirst(x.name)} (${x.cases})`)).join(' → ')}.`,
  portrait: 'Портрет',
  portraitN: (n: number) => `Портрет ${n}`,
  archive: 'Архив приёмов',
  archiveHint: 'Последние 50 приёмов — с разбором, как в итогах дня.',
  archiveEmpty: 'Пока пусто: закрытые приёмы появятся здесь.',
  row: (day: number, name: string) => `День ${day} · ${name}`,
  // архив — первые десять, остальное по касанию
  archiveMore: (n: number) => `Показать все — ${n}`,
  archiveLess: 'Свернуть',
  back: 'К профилю',
  // энциклопедия: где хранится практика игрока — там и отметка
  practiceTimes: (n: number) => (n > 0 ? `Встречалось в вашей практике: ${times(n)}` : 'В вашей практике пока не встречалось'),
  practiceShort: (n: number) => `встречалось в практике: ${times(n)}`,
  practiceCount: (n: number, total: number) => `В вашей практике встречалось: ${n} из ${total}`,
  // достижения: у полученных — дата, у остальных — что нужно сделать; без «осталось»
  achievements: 'Достижения',
  achievementsCount: (got: number, total: number) => `Получено: ${got} из ${total}`,
  achievementsOpen: 'Все достижения',
  achievementsHint: 'Отметки за хорошую медицину и хорошую больницу — в любом режиме и без сроков.',
  achievementGroup: {
    practice: 'Приём', diagnosis: 'Диагноз', care: 'Бережливость и безопасность', knowledge: 'Болезни', hospital: 'Больница', campaign: 'Кампания',
    daily: 'Случай дня', challenge: 'Испытания и сценарии',
  } as Record<string, string>,
  gotOn: (date: string) => `Получено ${date}`,
  achievementLine: (name: string) => `Достижение: «${name}»`,
  // специальности и умения (spec 2026-10-skills, часть 75): отделения игры — специальности врача
  specialties: 'Специальности',
  specialty: {
    'dept.therapy': 'Терапия',
    'dept.surgery': 'Хирургия',
    'dept.trauma': 'Травматология',
    'dept.neurology': 'Неврология',
    'dept.infectious': 'Инфекционные болезни',
  } as Record<string, string>,
  levelShort: (n: number) => `уровень ${n}`,
  // очки опыта бывают и с половиной (почти верный диагноз): до уровня — целым числом верных
  toNext: (n: number) => `до следующего — ${n} ${pluralRu(n, 'верный диагноз', 'верных диагноза', 'верных диагнозов')}`,
  topLevel: 'высший уровень',
  skills: 'Умения',
  skillLine: (name: string, text: string) => `«${name}»: ${lowerFirst(text)}`,
  skillsNone: 'Умения появятся со второго уровня специальности.',
  skillsOff: 'Умения выключены в настройках.',
  skillsNote: 'Новое умение действует со следующего дня; в «Случае дня» и «Разобрать случай» умений нет.',
};
