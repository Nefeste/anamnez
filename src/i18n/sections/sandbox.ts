import { pluralRu } from '../plural';
import { lowerFirst } from '../case';

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
  openHint: 'пациенты придут с 08:00',
  needToOpen: 'Чтобы открыть смену, нужно:',

  // экран стройки
  tools: { room: 'Помещение', corridor: 'Коридор', erase: 'Снос' },
  undo: (n: number) => `Отменить (${n})`,
  done: 'Готово',
  mapLabel: 'План участка: стройка',
  // для чтения с экрана: где призрак помещения — левый верхний угол, клетки от левого верхнего угла участка
  mapGhost: (name: string, x: number, y: number, ok: boolean) =>
    `План участка: стройка. ${name}: клетка ${x}, ${y} — ${ok ? 'можно построить' : 'здесь нельзя'}`,
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
    room: (name: string) => `Мешает: ${lowerFirst(name)}`,
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
    // «нет места в ординаторской»: у этого слова родительный и предложный совпадают
    noPlace: (gen: string) => `нет места в ${gen}`,
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
  demolishTitle: (name: string) => `Снести: ${lowerFirst(name)}?`,
  demolishText: 'Вернётся половина цены помещения и аппаратов. Отменить можно, пока открыт экран стройки.',
  examBlock: {
    none: (gen: string) => `нет ${gen}`,
    down: (name: string, why: string) => `${lowerFirst(name)} не работает: ${why}`,
  },

  // персонал
  staffTitle: 'Персонал',
  staffHint: 'нанять, назначить, уволить',
  hired: 'Работают',
  reserve: 'в резерве — получает зарплату, но не работает',
  candidates: 'Кандидаты сегодня',
  candidatesHint: 'Список новый каждый вечер.',
  noCandidates: 'Сегодня кандидатов нет.',
  noStaff: 'Пока никого.',
  // одинаковых помещений несколько — с номером: «Кабинет врача № 2»
  roomN: (name: string, n: number) => `${name} №\u00a0${n}`,
  salaries: (rub: string) => `Зарплаты за смену: ${rub}`,
  person: (role: string, skill: number, trait?: string) => `${role} · навык ${skill}${trait ? ` · ${trait}` : ''}`,
  perShift: (rub: string) => `${rub} за смену`,
  worksIn: (room: string) => `работает: ${lowerFirst(room)}`,
  hireHint: 'нанять',
  postFreeTitle: 'Свободные места',
  here: 'работает здесь',
  replaces: (name: string) => `вместо: ${name} — в резерв`,
  noPosts: 'Для этой должности в больнице пока нет помещения.',
  assignTitle: (name: string) => `Куда назначить: ${name}`,
  toReserve: 'В резерв',
  fire: 'Уволить',
  fireTitle: (name: string) => `Уволить: ${name}?`,
  fireText: 'Человек уйдёт сразу. Найти другого можно среди кандидатов — они новые каждый вечер.',
  post: (room: string, role: string) => `${room} — ${lowerFirst(role)}`,
  postFree: 'место свободно',
  postWho: (role: string, name: string, skill: number, trait?: string) => `${role}: ${name} · навык ${skill}${trait ? ` · ${trait}` : ''}`,
  traits: { careful: 'аккуратный', fast: 'быстрый', novice: 'новичок', experienced: 'опытный' },
  traitHints: {
    careful: 'точнее описывает снимки',
    fast: 'делает быстрее',
    novice: 'дешевле и учится быстрее',
    experienced: 'дороже и точнее',
  },
  close: 'Закрыть',

  // касса, репутация, оплата приёма (часть 9)
  payers: { oms: 'ОМС', dms: 'ДМС', self: 'платно' },
  payerNote: {
    oms: 'ОМС: страховая оплатит приём по тяжести диагноза и обследования по показаниям',
    dms: 'ДМС: страховая оплатит приём и обследования по показаниям',
    self: 'Платно: пациент оплатит приём и всё, что сделали',
  },
  cashTitle: 'Касса за день',
  income: 'Доходы',
  payerLine: (payer: string, n: number) => `${payer} · ${n}\u00a0${pluralRu(n, 'приём', 'приёма', 'приёмов')}`,
  audit: (rub: string) => `Экспертиза страховых не оплатила ${rub}`,
  auditWhy: (weak: number, unconfirmed: number, unindicated: number) =>
    [
      weak > 0 ? `обоснованность ниже A — ${weak}` : '',
      unconfirmed > 0 ? `без подтверждения диагноза — ${unconfirmed}` : '',
      unindicated > 0 ? `обследований без показаний — ${unindicated}` : '',
    ].filter(Boolean).join(', '),
  level: (pct: number) => `Тариф ОМС за приём — ${pct}\u00a0%`,
  levelMissing: (pct: number, gens: string) => `Тариф ОМС за приём — ${pct}\u00a0%: нет ${gens}`,
  // стационар (spec 2026-09-chapter-2, часть 26): ОМС за случай — при выписке
  wardLine: (n: number) => `Стационар — ${n}\u00a0${pluralRu(n, 'случай', 'случая', 'случаев')}`,
  // прерванные — доля тарифа; без показаний — экспертиза не оплатила (часть 26)
  wardNote: (interrupted: number, unindicated: number, share: number) =>
    [
      interrupted > 0 ? `прерваны переводом или ранней выпиской — ${interrupted}: ${share}\u00a0% тарифа` : '',
      unindicated > 0 ? `госпитализация без показаний — ${unindicated}: не оплачено` : '',
    ].filter(Boolean).join('; '),
  expensesTitle: 'Расходы',
  expense: {
    salaries: 'Зарплаты',
    equipment: 'Обслуживание аппаратов',
    rooms: 'Содержание помещений',
    consumables: 'Расходники',
    ward: 'Стационар: койко-дни',
    interest: 'Проценты по долгу',
  },
  net: (rub: string) => `Итог дня: ${rub}`,
  cashNow: (rub: string) => `В кассе: ${rub}`,
  debt: (debt: string, interest: string) => `Касса в минусе: долг ${debt}, за день начислено ${interest}. Стройка и покупки подождут денег.`,
  repTitle: 'Репутация',
  repLine: (from: number, to: number) => `Репутация: ${from} → ${to}`,
  repScore: (score: number) => `Оценка дня: ${score} из\u00a0100`,
  repNobody: 'Сегодня никто не пришёл — репутация прежняя.',
  repReason: {
    correct: (n: number) => `Верный диагноз: ${n}`,
    wrong: (n: number) => `Ошибка в диагнозе: ${n}`,
    left: (n: number) => `Ушли, не дождавшись: ${n}`,
    unseen: (n: number) => `Не успели принять: ${n}`,
    returned: (n: number) => `Вернулись хуже после лечения: ${n}`,
    waitShort: (min: number) => `Ждали недолго: в среднем ${min}\u00a0мин`,
    waitLong: (min: number) => `Ждали долго: в среднем ${min}\u00a0мин`,
    noToilet: 'Нет санузла',
  },
  repHint: (pull: number) =>
    `Каждый вечер репутация сдвигается к оценке дня на ${pull}\u00a0% разницы. От неё зависит, сколько людей придёт и сколько из них — по ДМС и платно.`,
  reputation: (n: number) => `Репутация: ${n} из\u00a0100`,

  /** «а», «а и б», «а, б и в» */
  andList: (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} и ${xs[xs.length - 1]}`),
  orList: (xs: string[]) => xs.join(' или '),

  // касание помещения на карте смены (часть 10)
  roomWho: (role: string, name: string, skill: number) => `${role}: ${name} · навык ${skill}`,
  roomInOffice: (name: string) => `На приёме: ${name}`,
  roomQueue: (n: number) => `В очереди к врачу: ${n}`,
  roomSeats: (busy: number, seats: number) => `Ждут приёма: ${busy} · мест: ${seats}`,
  roomNow: (name: string) => `Сейчас: ${name}`,
  roomNext: (n: number) => `Ждут обследования: ${n}`,
  roomLab: (n: number) => `Анализов в работе: ${n}`,
  roomFree: 'Сейчас свободно',

  // оплата закрытого приёма — на экране итога
  payment: 'Оплата',
  paid: (payer: string, rub: string) => `${payer}: ${rub}`,
  payQuality: (grade: string, pct: number) => `Обоснованность ${grade} — оплачено ${pct}\u00a0% тарифа`,
  payUnconfirmed: (exams: string, pct: number) => `Диагноз не подтверждён (подтверждает: ${exams}) — оплачено ${pct}\u00a0%`,
  payUnindicated: (exams: string) => `Без показаний, не оплачено: ${exams}`,
  payCut: (rub: string) => `Экспертиза не оплатила: ${rub}`,
};
