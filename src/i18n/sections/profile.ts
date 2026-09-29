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
  menuHint: (name: string, cases: number) => (cases > 0 ? `${name} · принято: ${cases}` : name),
  // практика — всё время, во всех сменах
  practice: 'Практика',
  cases: (n: number) => `Принято: ${n}`,
  noCases: 'Пока ни одного приёма: итоги появятся после первого.',
  verdicts: (correct: number, partly: number, wrong: number, pct: number) => `Диагноз верен: ${correct} (${pct}\u00a0%) · почти: ${partly} · неверно: ${wrong}`,
  grades: (a: number, b: number, c: number, d: number) => `Оценки приёмов: A — ${a} · B — ${b} · C — ${c} · D — ${d}`,
  money: (rub: string) => `Обследования в среднем: ${rub} на приём`,
  minutes: (n: number) => `В среднем на приём — ${n}\u00a0мин`,
  antibiotics: (ok: number, all: number) => `Антибиотик по показаниям — ${ok} из ${all}\u00a0${pluralRu(all, 'назначения', 'назначений', 'назначений')}`,
  danger: (ok: number, all: number) => `Нужны были стационар или скорая — направлено ${ok} из ${all}`,
  ranks: ['Интерн', 'Ординатор', 'Врач', 'Врач высшей категории'],
  rankLadder: (steps: { name: string; cases: number }[]) =>
    `Звание растёт с принятыми пациентами: ${steps.map((x, i) => (i === 0 ? lowerFirst(x.name) : `${lowerFirst(x.name)} (${x.cases})`)).join(' → ')}.`,
  portrait: 'Портрет',
  portraitN: (n: number) => `Портрет ${n}`,
  seen: (n: number, total: number) => `Встречалось болезней: ${n} из ${total}`,
  archive: 'Архив приёмов',
  archiveHint: 'Последние 50 приёмов — с разбором, как в итогах дня.',
  archiveEmpty: 'Пока пусто: закрытые приёмы появятся здесь.',
  row: (day: number, name: string) => `День ${day} · ${name}`,
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
    daily: 'Случай дня',
  } as Record<string, string>,
  gotOn: (date: string) => `Получено ${date}`,
  achievementLine: (name: string) => `Достижение: «${name}»`,
};
