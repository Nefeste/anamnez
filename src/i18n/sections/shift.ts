// Смена в амбулатории (spec 2026-09-first-shift): очередь, часы, итоги дня.
import { pluralRu } from '../plural';
import { lowerFirst } from '../case';

const patients = (n: number) => `${n}\u00a0${pluralRu(n, 'пациент', 'пациента', 'пациентов')}`;
const ago = (female: boolean, m: string, f: string) => (female ? f : m);
const COLOR: Record<string, string> = { red: 'красный', yellow: 'жёлтый', green: 'зелёный' };

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
    ambulance: (name: string) => `Пауза: привезла скорая — ${name}`,
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
  badge: { return: 'повторно', results: 'с результатами', appointment: 'по записи', walkIn: 'без записи', ambulance: 'скорая' },
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
    ambulance: (name: string, complaint: string) => `Скорая: ${name} — ${complaint}`,
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
    // стационар за день (spec 2026-09-chapter-2, часть 26)
    // скорая за день (часть 27): сверка сортировки со шкалой NEWS2 и красными флагами
    ambulance: {
      title: 'Скорая',
      line: (arrived: number, sorted: number) => `Привезли: ${arrived}, отсортировали: ${sorted}.`,
      check: (right: number, under: number, over: number) =>
        `Со шкалой совпало: ${right}. Недооценили: ${under}, переоценили: ${over}.`,
      unsorted: (n: number) => `Не отсортировали до конца дня: ${n}.`,
    },
    ward: {
      title: 'Стационар',
      moves: (admitted: number, discharged: number, transferred: number, lying: number) =>
        `Поступили: ${admitted}, выписаны: ${discharged}, переведены: ${transferred}. Лежат: ${lying}.`,
      early: (n: number) => `Выписаны рано: ${n} — вернутся хуже.`,
      // часть 28б: без оценок — разбор в карте приёма
      died: (n: number) => `Умерли в стационаре: ${n}.`,
      stay: (mean: number, norm: number) =>
        `В среднем в стационаре ${String(mean).replace('.', ',')}\u00a0сут. при обычных ${String(norm).replace('.', ',')}.`,
    },
    // операционная за день (часть 28)
    surgery: {
      title: 'Операционная',
      line: (done: number, onTime: number, late: number) => `Операций: ${done}, в срок: ${onTime}${late > 0 ? `, позже срока: ${late}` : ''}.`,
      complications: (n: number) => `Осложнений после операции: ${n} — стационар у них дольше.`,
      complicated: (n: number) => `Оперировали в осложнённой стадии: ${n} — стационар у них дольше.`,
    },
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
      // палата (spec 2026-09-chapter-2, часть 26)
      ward: 'Палата',
      // смотровая приёмного (часть 27)
      emergency: 'Приёмное',
      // операционная (часть 28)
      or: 'Операционная',
      // кабинет УЗИ (часть 29)
      ultrasound: 'УЗИ',
    } as Record<string, string>,
    // для чтения с экрана: что на карте, словами
    label: (waiting: number, away: number, inRoom: string | undefined) =>
      `Карта амбулатории. В зале ожидания: ${patients(waiting)}; на обследованиях: ${patients(away)}; в кабинете: ${inRoom ?? 'никого'}.`,
    invite: 'Пригласить',
    // значки помещений на карте (spec 2026-09-living-map, часть 23): для чтения с экрана
    signs: {
      queue: (n: number) => `Ждут: ${n}`,
      noStaff: 'Нет персонала',
    },
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
      surgeon: 'Хирург',
      anesthetist: 'Анестезиолог',
      orNurse: 'Операционная медсестра',
      sonographer: 'Врач УЗД',
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
      sonographer: 'Делает УЗИ и сразу описывает, что видит',
    } as Record<string, string>,
    doing: {
      registration: 'В регистратуре: заводят карту',
      triage: 'У медсестры: давление, пульс, температура, сатурация',
      // между числом и единицей — неразрывный пробел (голос студии)
      waiting: (min: number) => `Ждёт приёма ${min}\u00a0мин`,
      office: 'У вас в кабинете',
      colleague: (doctor: string) => `На приёме у терапевта: ${doctor}`,
      exam: { xray: 'На рентгене', ecg: 'На ЭКГ', lab: 'Сдаёт анализы', ultrasound: 'На УЗИ' } as Record<string, string>,
      examQueue: { xray: 'Ждёт очереди на рентген', ecg: 'Ждёт очереди на ЭКГ', lab: 'Ждёт очереди на анализы', ultrasound: 'Ждёт очереди на УЗИ' } as Record<string, string>,
      results: (hh: string) => `Ждёт результатов — будут к ${hh}`,
      leaving: 'Приём окончен — уходит',
      left: (female: boolean) => ago(female, 'Не дождался приёма и уходит', 'Не дождалась приёма и уходит'),
      // палата (spec 2026-09-chapter-2, часть 26): день поступления — «первые сутки»
      ward: (days: number) => `В палате: ${days + 1}-е\u00a0сутки`,
      // операционная (часть 28): на столе и ждёт операции в палате
      onTable: (op: string, until: string) => `Идёт операция: ${lowerFirst(op)}, до ${until}`,
      waitingOp: (op: string) => `В палате, ждёт операции: ${lowerFirst(op)}`,
      // скорая (spec 2026-09-chapter-2, часть 27)
      ambulance: {
        unsorted: 'Привезла скорая — ждёт сортировки',
        waiting: 'Привезла скорая — ждёт врача в смотровой',
        door: 'На каталке у входа: в смотровой мест нет',
        withYou: 'У вас на осмотре в смотровой приёмного',
      } as Record<'unsorted' | 'waiting' | 'door' | 'withYou', string>,
    },
  },
  // стационар своей больницы (spec 2026-09-chapter-2, часть 26)
  ward: {
    admit: 'В палату',
    freeBeds: (free: number, all: number) => `свободно ${free} из ${all}`,
    noBeds: 'свободных коек нет',
    refer: 'Направить в другую больницу',
    // обход
    title: 'Обход',
    open: (n: number) => `Обход · ${n}`,
    openHint: 'лежащие в палатах: как идёт лечение, кого выписать',
    empty: 'В палатах никого нет.',
    today: (female: boolean) => (female ? 'Поступила сегодня' : 'Поступил сегодня'),
    days: (days: number, norm: number) =>
      `В стационаре ${days}\u00a0${pluralRu(days, 'сутки', 'суток', 'суток')} · обычно до ${norm}`,
    state: {
      better: 'Лучше: лечение действует',
      same: 'Без перемен',
      worse: 'Хуже: лечение не помогает',
      ready: 'Жалоб нет, показатели в норме',
      reaction: (tx: string, by: string) => `Реакция на ${lowerFirst(tx)}: ${lowerFirst(by)}`,
    } as Record<'better' | 'same' | 'worse' | 'ready', string> & { reaction: (tx: string, by: string) => string },
    readyHint: 'можно выписывать',
    vital: {
      'vital.fever': 'Температура',
      'vital.tachycardia': 'Пульс',
      'vital.tachypnea': 'Дыхание',
      'vital.spo2_low': 'Сатурация',
      'vital.bp_high': 'Давление',
    } as Record<string, string>,
    treatments: (list: string) => `Лечение: ${list}`,
    noTreatment: 'не назначено',
    discharge: 'Выписать',
    replan: 'Сменить лечение',
    transfer: 'Перевести',
    replanTitle: 'Сменить лечение',
    replanDone: 'Готово',
    // операционная (spec 2026-09-chapter-2, часть 28): в решении и на обходе
    operate: 'В операционную',
    opHint: (op: string, free: number, all: number) => `${op} · коек свободно ${free} из ${all}`,
    noOperation: 'у этого диагноза операции нет',
    noDiagnosis: 'сначала — диагноз',
    orDown: (why: string) => `операционная не работает: ${why}`,
    noOpEquipment: (gen: string) => `в операционной нет ${gen}`,
    opWaiting: (op: string, n: number) => `Ждёт операции: ${lowerFirst(op)}${n > 1 ? ` · в очереди ${n}-й` : ''}`,
    opOn: (op: string, until: string) => `Идёт операция: ${lowerFirst(op)}, до ${until}`,
    opDone: (op: string) => `После операции: ${lowerFirst(op)}`,
    opStage: (name: string) => `на операции — ${name}`,
    opComplication: 'после операции — осложнение, стационар дольше',
  },
  // скорая (spec 2026-09-chapter-2, часть 27): лист передачи и сортировка врачом
  ambulance: {
    title: 'Скорая — ждут сортировки',
    reason: (complaint: string) => `повод: ${complaint}`,
    sheetReason: (complaint: string) => `Повод к вызову: ${complaint}`,
    bay: 'в смотровой приёмного',
    door: 'на каталке у входа: мест нет',
    sheet: 'Лист передачи',
    measured: 'Фельдшер измерил',
    news2: (n: number) => `NEWS2 — ${n}\u00a0${pluralRu(n, 'балл', 'балла', 'баллов')}: 7 и больше — красный, 5–6 или 3 по одному показателю — жёлтый`,
    // на «Студенте»: тревожный признак, что поднял цвет выше баллов
    flag: (f: string, triage: string) => `Тревожный признак: ${lowerFirst(f)} — ${COLOR[triage] ?? triage}`,
    sortLabel: 'Как срочно смотреть',
    sort: {
      red: 'Красный — сразу',
      yellow: 'Жёлтый — скоро',
      green: 'Зелёный — в порядке очереди',
    } as Record<'red' | 'yellow' | 'green', string>,
    sortHint: 'цвет — место в очереди; сверка со шкалой — в итогах дня',
    close: 'Потом',
    next: (name: string) => `Скорая: ${name} — сортировать`,
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
