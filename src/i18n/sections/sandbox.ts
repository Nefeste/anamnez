import { pluralRu } from '../plural';

// Песочница — своя больница (spec 2026-09-own-hospital): начало, вечер между сменами, стройка.
export const sandbox = {
  menu: 'Песочница',
  menuHint: 'своя больница: стройка, аппараты, касса — дни без конца',
  menuSaved: (day: number, cash: string) => (day === 0 ? `перед открытием · касса ${cash}` : `день ${day} · касса ${cash}`),
  continueHint: (day: number, cash: string) => (day === 0 ? `песочница: перед открытием · касса ${cash}` : `песочница: день ${day} · касса ${cash}`),
  restartTitle: 'Начать песочницу заново?',
  restartText: 'Сохранение одно: нынешняя больница сотрётся.',

  newTitle: 'Песочница — своя больница',
  newText: (w: number, h: number) =>
    `Стройте амбулаторию на участке ${w} × ${h} клеток: помещения, коридоры, аппараты. Строят между сменами — всё построенное работает со следующего утра.`,
  startTitle: 'С чего начать',
  starts: { empty: 'Пустой участок', clinic: 'Готовая амбулатория' },
  startHints: {
    empty: 'Вход и отрезок коридора — остальное стройте сами.',
    clinic: (share: number) => `Та же амбулатория, что в практике, со всеми аппаратами; в кассе — ${share} % бюджета.`,
  },
  budgetTitle: 'Бюджет',
  budgets: { modest: 'Скромный', normal: 'Обычный', generous: 'Щедрый' },
  begin: 'Начать',

  // вечер между сменами
  title: 'Своя больница',
  beforeOpening: 'Перед открытием',
  day: (day: number) => `День ${day}`,
  cash: (rub: string) => `Касса: ${rub}`,
  rooms: (n: number) => `${n} ${pluralRu(n, 'помещение', 'помещения', 'помещений')}`,
  build: 'Стройка',
  buildHint: 'помещения, коридоры, аппараты',
  openShift: 'Открыть смену',
  openSoon: 'Смена в своей больнице — в следующей версии; сейчас можно строить.',
  needToOpen: 'Чтобы открыть смену, нужно:',

  // экран стройки
  tools: { room: 'Помещение', corridor: 'Коридор', erase: 'Снос' },
  undo: (n: number) => `Отменить (${n})`,
  done: 'Готово',
  mapLabel: 'План участка: стройка',
  pickRoom: 'Какое помещение',
  fromPrice: (rub: string) => `от ${rub}`,
  pickSize: 'Размер',
  sizeLine: (id: string, w: number, h: number, cost: string, seats: number) =>
    `${id} · ${w} × ${h} м · ${cost}${seats > 0 ? ` · ${seats} ${pluralRu(seats, 'место', 'места', 'мест')}` : ''}`,
  rotate: 'Повернуть',
  place: (rub: string) => `Построить · ${rub}`,
  cancel: 'Отмена',
  ghostHint: 'Тяните помещение пальцем, карту — мимо него. Дверь — на отмеченной стороне.',
  brushHint: (rub: string) => `Проведите пальцем по клеткам: ${rub} за клетку. Карта — двумя пальцами.`,
  eraseHint: 'Коснитесь помещения, чтобы снести, или проведите пальцем по коридору.',
  lookHint: 'Коснитесь помещения — что в нём и чего не хватает.',
  why: {
    outside: 'За краем участка',
    room: (name: string) => `Мешает: ${name.toLowerCase()}`,
    corridor: 'Мешает коридор',
    entrance: 'Здесь вход',
    money: (rub: string) => `Не хватает ${rub}`,
    noSlot: 'Места под аппарат нет',
    badDoor: 'Здесь двери не быть: с этой стороны нет коридора',
    other: 'Так нельзя',
  },

  // карточка помещения
  size: (name: string, id: string) => `${name} · ${id}`,
  works: 'Работает',
  notWorking: (why: string) => `Не работает: ${why}`,
  problem: {
    noDoor: 'нет двери в коридор',
    noPath: 'нет прохода от входа',
    noEquipment: 'нет аппарата',
    noStaff: (gen: string) => `нет ${gen}`,
  },
  door: 'Дверь',
  doorPrev: '◀ Дверь',
  doorNext: 'Дверь ▶',
  equipment: 'Аппараты',
  emptySlot: 'Место свободно',
  buy: 'Купить аппарат',
  sell: (rub: string) => `Продать · ${rub}`,
  eqLine: (price: string, upkeep: string) => `${price} · обслуживание ${upkeep} в день`,
  demolish: (rub: string) => `Снести · вернётся ${rub}`,
  demolishTitle: (name: string) => `Снести: ${name.toLowerCase()}?`,
  demolishText: 'Вернётся половина цены помещения и аппаратов. Отменить можно, пока открыт экран стройки.',
  staffSoon: 'Персонал и найм — в следующей версии; пока считается, что люди на местах.',
  close: 'Закрыть',
};
