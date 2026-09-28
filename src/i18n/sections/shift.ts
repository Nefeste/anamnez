// Смена в амбулатории (spec 2026-09-first-shift): очередь, часы, итоги дня.
import { pluralRu } from '../plural';

const patients = (n: number) => `${n}\u00a0${pluralRu(n, 'пациент', 'пациента', 'пациентов')}`;
const ago = (female: boolean, m: string, f: string) => (female ? f : m);

export const shift = {
  title: 'Амбулатория',
  loading: 'Открываем амбулаторию…',
  newTitle: 'Практика в амбулатории',
  newText: 'Готовая амбулатория и одна смена за другой: приём с 08:00 до 14:00, по записи и без. Кто пришёл раньше — не всегда первый: медсестра сортирует по срочности. Отпущенные домой вернутся, если им станет хуже.',
  start: 'Начать',
  difficulty: {
    title: 'Сложность',
    student: 'Студент',
    doctor: 'Врач',
    studentText: 'Подсказки «Похоже на» с частотой, анализы и осмотр не ошибаются, пациенты ждут дольше.',
    doctorText: 'Подсказок нет, анализы и осмотр иногда ошибаются — как в жизни.',
  } as Record<string, string>,
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
  waits: (min: number) => `ждёт ${min}\u00a0мин`,
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
    // с нанятыми врачами: прежние строки — о ваших приёмах
    seenAll: (mine: number, theirs: number, arrived: number) => `Принято: ${mine + theirs} из ${arrived} — вами ${mine}, врачами ${theirs}`,
    colleagues: 'Врачи',
    colleague: (name: string, role: string) => `${name}, ${role}`,
    colleagueGone: 'Врач, который больше не работает',
    colleagueLine: (seen: number, correct: number, partly: number, wrong: number, g: Record<string, number>, taken: number) =>
      `Принято: ${seen} · верно: ${correct} · почти: ${partly} · неверно: ${wrong} · оценки A — ${g.A} · B — ${g.B} · C — ${g.C} · D — ${g.D}${taken > 0 ? ` · вы забрали: ${taken}` : ''}`,
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
  map: {
    rooms: {
      reception: 'Регистратура',
      triage: 'Медсестра',
      office: 'Ваш кабинет',
      // кабинет нанятого врача и ординаторская (spec 2026-09-hired-doctors)
      colleagueOffice: 'Кабинет терапевта',
      staff: 'Ординаторская',
      procedure: 'Процедурная',
      lab: 'Лаборатория',
      waiting: 'Ожидание',
      ecg: 'ЭКГ',
      xray: 'Рентген',
      toilet: 'Санузел',
    } as Record<string, string>,
    // для чтения с экрана: что на карте, словами
    label: (waiting: number, away: number, inRoom: string | undefined) =>
      `Карта амбулатории. В зале ожидания: ${patients(waiting)}; на обследованиях: ${patients(away)}; в кабинете: ${inRoom ?? 'никого'}.`,
    invite: 'Пригласить',
    // коснулись человека на карте: кто это и что делает
    staff: {
      registrar: 'Регистратор',
      nurse: 'Медсестра доврачебного кабинета',
      doctor: 'Врач — это вы',
      therapist: 'Терапевт',
      procedureNurse: 'Процедурная медсестра',
      labTech: 'Лаборант',
      ecgNurse: 'Медсестра кабинета ЭКГ',
      radiographer: 'Рентгенолаборант',
      radiologist: 'Рентгенолог',
    } as Record<string, string>,
    // нанятый врач (spec 2026-09-hired-doctors): кто он и кого принимает
    therapist: (name: string, skill: number) => `${name}, терапевт · навык ${skill}`,
    therapistWith: (patient: string) => `Принимает: ${patient}`,
    duty: {
      registrar: 'Записывает пришедших и заводит на них карту',
      nurse: 'Каждому пришедшему меряет давление, пульс, температуру и сатурацию и решает, кого принять первым',
      doctor: 'Принимаете пациентов: расспрос, осмотр, обследования, диагноз и лечение',
      therapist: 'Сейчас без пациента — позовёт следующего из очереди',
      procedureNurse: 'Берёт кровь на анализы',
      labTech: 'Делает анализы крови и мочи',
      ecgNurse: 'Снимает ЭКГ',
      radiographer: 'Делает рентгеновские снимки',
      radiologist: 'Описывает снимки: его заключение приходит вместе со снимком',
    } as Record<string, string>,
    doing: {
      registration: 'В регистратуре: заводят карту',
      triage: 'У медсестры: давление, пульс, температура, сатурация',
      // между числом и единицей — неразрывный пробел (голос студии)
      waiting: (min: number) => `Ждёт приёма ${min}\u00a0мин`,
      office: 'У вас в кабинете',
      colleague: (doctor: string) => `На приёме у терапевта: ${doctor}`,
      exam: { xray: 'На рентгене', ecg: 'На ЭКГ', lab: 'Сдаёт анализы' } as Record<string, string>,
      examQueue: { xray: 'Ждёт очереди на рентген', ecg: 'Ждёт очереди на ЭКГ', lab: 'Ждёт очереди на анализы' } as Record<string, string>,
      results: (hh: string) => `Ждёт результатов — будут к ${hh}`,
      leaving: 'Приём окончен — уходит',
      left: (female: boolean) => ago(female, 'Не дождался приёма и уходит', 'Не дождалась приёма и уходит'),
    },
  },
  entering: (name: string) => `${name} идёт к вам`,
  // пациенты нанятых врачей (spec 2026-09-hired-doctors, часть 19)
  colleagueCase: {
    doctor: (role: string, name: string) => `${role} ${name}`,
    someone: 'врач, который больше не работает',
    list: 'У врачей',
    row: (doctor: string, doing: string) => `${doctor} · ${doing}`,
    inRoom: (since: string) => `на приёме с ${since}`,
    results: (at: string) => `ждёт результатов к ${at}`,
    back: 'ждёт врача с результатами',
    note: (doctor: string) => `Приём ведёт ${doctor}. Видно всё, что врач уже узнал; забрать — пациент перейдёт к вам со всем этим.`,
    take: 'Забрать себе',
    takeHint: (where: 'free' | 'busy' | 'away') =>
      where === 'free' ? 'Сразу к вам в кабинет'
        : where === 'busy' ? 'В вашу очередь, по времени прихода: вы сейчас с пациентом'
          : 'Сейчас на обследованиях — с результатами вернётся к вам',
    open: 'Открыть приём',
    // в журнале смены, когда он не сразу у вас в кабинете
    taken: (name: string, away: boolean) => (away ? `${name} — теперь к вам: вернётся с результатами в вашу очередь` : `${name} — теперь к вам: в вашей очереди`),
  },
};
