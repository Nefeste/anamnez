// Смена в амбулатории (spec 2026-09-first-shift): очередь, часы, итоги дня.
import { pluralRu } from '../plural';

const patients = (n: number) => `${n} ${pluralRu(n, 'пациент', 'пациента', 'пациентов')}`;
const ago = (female: boolean, m: string, f: string) => (female ? f : m);

export const shift = {
  title: 'Амбулатория',
  loading: 'Открываем амбулаторию…',
  newTitle: 'Практика в амбулатории',
  newText: 'Готовая амбулатория и одна смена за другой: приём с 08:00 до 14:00, по записи и без. Кто пришёл раньше — не всегда первый: медсестра сортирует по срочности. Отпущенные домой вернутся, если им станет хуже.',
  start: 'Начать',
  restored: 'Сохранение было повреждено — продолжаем с предыдущей копии.',
  day: (n: number) => `День ${n}`,
  speed: { pause: 'Пауза', x1: '×1', x2: '×2', x4: '×4' } as Record<string, string>,
  speedLabel: 'Часы',
  paused: 'Пауза',
  pause: {
    red: (name: string) => `Пауза: срочный пациент — ${name}`,
    results: (name: string) => `Пауза: результаты готовы — ${name}`,
    end: 'Пауза: все приняты, новых пациентов не будет',
  },
  inRoom: 'В кабинете',
  continueVisit: (name: string) => `Продолжить приём: ${name}`,
  call: (name: string) => `Пригласить: ${name}`,
  callHint: 'первый в очереди; можно выбрать любого',
  skip: 'Промотать до следующего ▶▶',
  skipHint: (away: number) => (away > 0 ? 'до пациента или готовых результатов' : 'до следующего пациента'),
  queue: 'Очередь',
  queueEmpty: 'Пока никого',
  away: 'На обследованиях',
  awayReady: (hh: string) => `результаты к ${hh}`,
  log: 'Что происходит',
  waits: (min: number) => `ждёт ${min} мин`,
  arrivedAt: (hh: string) => `пришёл в ${hh}`,
  badge: { return: 'повторно', results: 'с результатами', appointment: 'по записи', walkIn: 'без записи' },
  // срочность — цветом и словом со значком: цвет один различают не все (ui/theme.ts)
  triage: { red: '‼ срочно', yellow: '! нужно скоро', green: 'в порядке очереди' } as Record<string, string>,
  counts: (seen: number, waiting: number, left: number) =>
    `Принято: ${seen} · ждут: ${waiting}${left > 0 ? ` · ушли, не дождавшись: ${left}` : ''}`,
  closeDay: 'Закрыть день',
  closeDayHint: (unseen: number) => (unseen > 0 ? `не успеете принять: ${patients(unseen)}` : 'все приняты'),
  afterHours: 'После 14:00 новые не приходят: можно допринять очередь или закрыть день',
  notice: {
    arrived: (name: string, female: boolean) => `${ago(female, 'Пришёл', 'Пришла')}: ${name}`,
    red: (name: string, complaint: string) => `Срочно: ${name} — ${complaint}`,
    results: (name: string, female: boolean) => `${name}: результаты готовы — ${ago(female, 'вернулся', 'вернулась')} в очередь`,
    left: (name: string, female: boolean) => `${name} ${ago(female, 'ушёл', 'ушла')}, не дождавшись приёма`,
    end: '14:00 — приём по записи окончен, новых пациентов не будет',
    more: (n: number) => `${pluralRu(n, 'Пришёл', 'Пришли', 'Пришли')} ещё ${patients(n)}`,
  },
  checkup: 'профосмотр',
  returnNote: (reason: 'worse' | 'reaction' | 'unchanged', day: number, female: boolean) =>
    reason === 'worse' ? `Повторно: после приёма в день ${day} стало хуже`
      : reason === 'reaction' ? `Повторно: после приёма в день ${day} — реакция на лечение`
        : `Повторно: после приёма в день ${day} ${ago(female, 'не поправился', 'не поправилась')}`,
  outcomeLater: 'Узнаете в итогах следующих дней: отпущенных домой модель ведёт неделю',
  toQueue: 'К очереди',
  toSummary: 'К итогам дня',
  noPatient: 'В кабинете никого',
  summary: {
    title: (d: number) => `Итоги дня ${d}`,
    seen: (seen: number, arrived: number) => `Принято: ${seen} из ${arrived}`,
    left: (n: number) => `Ушли, не дождавшись: ${n}`,
    unseen: (n: number) => `Не успели принять: ${n}`,
    verdicts: (correct: number, partly: number, wrong: number) => `Диагноз верен: ${correct} · почти: ${partly} · неверно: ${wrong}`,
    grades: 'Оценки случаев',
    confidence: (n: number) => `Уверенность идеального врача в ваших диагнозах: в среднем ${n} из 10`,
    money: (spent: string, rational: string) => `Обследования: ${spent}; разумному врачу хватило бы ${rational}`,
    returns: (planned: number, today: number) => `Вернутся на приём: ${planned} · пришли повторно сегодня: ${today}`,
    moneyNote: 'Деньги пока только для показа: тратить их не на что',
    cases: 'Приёмы дня',
    noCases: 'Сегодня никого не приняли',
    news: 'Что стало с прошлыми пациентами',
    nextDay: 'Следующий день ▶',
    restart: 'Начать практику заново',
    restartConfirm: 'Все дни практики будут стёрты. Начать заново?',
    restartYes: 'Да, заново',
    cancel: 'Отмена',
  },
  news: (name: string, day: number, what: string) => `${name} (приём в день ${day}): ${what}`,
  verdict: { correct: '✓', partly: '≈', wrong: '✗' } as Record<string, string>,
};
