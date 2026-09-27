// Профиль врача (spec 2026-09-first-shift, «Профиль-минимум»): имя и пол, практика, архив приёмов.
import { pluralRu } from '../plural';

// между числом и единицей — неразрывный пробел (голос студии)
const times = (n: number) => `${n}\u00a0${pluralRu(n, 'раз', 'раза', 'раз')}`;

export const profile = {
  title: 'Профиль',
  // первый запуск и правка имени
  doctorTitle: 'Кто вы в игре',
  doctorText: 'Имя и пол врача — для обращений в игре. Их можно поменять в профиле.',
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
};
