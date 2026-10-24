// Сценарии «Быстрой игры» (часть 91, spec 2026-10-scenarios, вопрос 55): неделя — пять смен в одной больнице с особым
// условием и своей целью. Пороги целей — из src/state/scenario.ts.
import { pluralRu } from '../plural';

const patients = (n: number) => `${n} ${pluralRu(n, 'пациент', 'пациента', 'пациентов')}`;

export const scenarios = {
  title: 'Сценарии',
  intro: 'Неделя — пять смен подряд в одной больнице с особым условием и своей целью. Выполнили цель — достижение.',
  names: { flu: 'Зимний грипп', neighbor: 'Закрыли соседнюю больницу', xray: 'Рентген сломался' } as Record<string, string>,
  rules: {
    flu: 'Зима, эпидемия: ОРВИ, гриппа и пневмонии вдвое больше — на каждого такого приходит ещё один.',
    neighbor: 'Соседняя больница закрыта: пришедших и машин скорой — в полтора раза больше.',
    xray: 'Рентген-аппарат в ремонте всю неделю: снимков нет.',
  } as Record<string, string>,
  /** цель сценария — словами, с порогами */
  goals: {
    flu: (caught: number, needless: number) =>
      `Цель: распознать пневмонию не меньше чем у ${caught} % своих больных с ней; антибиотик без нужды — не больше чем у ${needless} % своих пациентов.`,
    neighbor: (lost: number, deaths: number) =>
      `Цель: не дождались приёма — не больше ${lost} % пришедших; умерли — не больше ${deaths} % своих пациентов.`,
    xray: (grade: string) => `Цель: итог недели не ниже «${grade}».`,
  },
  seenGoal: (n: number) => `И не меньше ${patients(n)} за неделю.`,
  where: {
    flu: 'В любой больнице.',
    neighbor: 'Где есть смотровая приёмного: туда везёт скорая.',
    xray: 'Где есть рентген-кабинет; заметнее всего — в районной больнице: переломы без снимка.',
  } as Record<string, string>,
  /** больница не подходит сценарию */
  unfit: {
    neighbor: 'нет смотровой приёмного — скорая сюда не везёт',
    xray: 'нет рентген-кабинета',
  } as Record<string, string>,
  pick: 'Сценарий',
  start: 'Начать неделю',
  best: (grade: string) => `лучший итог недели — ${grade}`,
  // в смене и в меню
  suffix: (name: string) => ` · сценарий «${name}»`,
  continueHint: (venue: string, day: number, of: number, clock: string) => `${venue}, день ${day} из ${of}, ${clock}`,
  day: (day: number, of: number) => `Неделя: день ${day} из ${of}`,
  // итог дня и недели: цели — строками, ✓ — выполнена
  goal: {
    seen: (n: number, need: number) => `Своих пациентов за неделю: ${n} (нужно не меньше ${need})`,
    pneumonia: (pct: number, of: number, need: number) =>
      (of === 0 ? 'Больных пневмонией пока не было' : `Пневмонию распознали: ${pct} % из ${of} (нужно не меньше ${need} %)`),
    antibiotic: (n: number, of: number, need: number) => `Антибиотик без нужды: ${n} из ${patients(of)} (не больше ${need} %)`,
    queue: (pct: number, of: number, need: number) => `Не дождались приёма: ${pct} % из ${of} пришедших (не больше ${need} %)`,
    deaths: (n: number, of: number, need: number) => `Умерли: ${n} из ${patients(of)} (не больше ${need} %)`,
    overall: (grade: string, need: string) => `Итог недели: ${grade} (нужно не ниже «${need}»)`,
  },
  ok: '✓',
  miss: '✗',
  passed: 'Сценарий пройден: все цели недели выполнены',
  failed: 'Сценарий не пройден: не все цели недели выполнены',
  weekTitle: 'Итог недели',
  soFar: 'Итог за сыгранные смены',
  nextDay: 'Следующая смена',
  again: 'Новый сценарий',
  // поломка рентгена — на всю неделю
  brokenWeek: (equipment: string, room: string) => `Не работает: ${equipment}${room ? ` (${room})` : ''} — до конца недели`,
  brokenExam: (equipment: string) => `${equipment} в ремонте до конца недели`,
};
