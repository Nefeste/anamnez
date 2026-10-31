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
    // самый простой уровень (spec 2026-10-trainee): слово короче «Студента», вкладки вмещаются и на узком экране
    trainee: 'Практикант',
    student: 'Студент',
    resident: 'Ординатор',
    doctor: 'Врач',
    traineeText: 'Как «Студент», и в расспросе, осмотре и назначениях сверху — то, что относится к жалобе; разбор мягче: обоснованность и бережливость — для сведения.',
    studentText: 'Подсказки «Похоже на» с частотой, анализы и осмотр не ошибаются, пациенты ждут дольше.',
    doctorText: 'Подсказок нет, анализы и осмотр иногда ошибаются — как в жизни.',
    residentText: 'Анализы и осмотр иногда ошибаются, как у врача; «Похоже на» — до трёх болезней, уверенность словами, пациенты ждут чуть дольше.',
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
    // первые меры у скорой (spec 2026-10-first-measures, часть 95): тяжёлому без нужной меры хуже
    worse: (name: string, what: string) => `Пауза: хуже — ${name}: ${what}`,
    code: (name: string) => `Пауза: код синий — ${name}`,
    died: (name: string, female: boolean, soft: boolean) =>
      `Пауза: ${soft ? `${ago(female, 'переведён', 'переведена')} в тяжёлом состоянии` : `${ago(female, 'умер', 'умерла')} в смотровой`} — ${name}`,
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
  // оформляются (spec 2026-10-clinic-flow): в очереди врача их ещё нет
  intake: { regQueue: 'ждёт регистратуру', reg: 'в регистратуре', nurseQueue: 'ждёт медсестру', nurse: 'у медсестры' },
  away: 'На обследованиях',
  awayReady: (hh: string) => `результаты к ${hh}`,
  log: 'Что происходит',
  waits: (min: number) => `ждёт ${min}\u00a0мин`,
  arrivedAt: (hh: string) => `пришёл в ${hh}`,
  badge: {
    return: 'повторно', results: 'с результатами', appointment: 'по записи', walkIn: 'без записи', ambulance: 'скорая',
    // записан к специалисту (spec 2026-10-chapter-4, часть 59): к нему и придёт, если вы не позовёте сами
    booked: (doctorDat: string) => `по записи к ${doctorDat}`,
    // «свои больные» (spec 2026-10-own-patients, часть 76): по жалобам — из выбранных групп, нанятые врачи его не берут
    mine: 'ждёт вас',
  },
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
    // фибрилляция желудочков в смотровой (spec 2026-10-chapter-3, часть 39б): под монитором её снимают разрядом; с части
    // 89 — «код синий» (spec 2026-10-code-blue, вопрос 52): бригада бежит к койке
    arrest: (name: string) => `Код синий: остановка сердца — ${name}, смотровая приёмного. Разряд под монитором, ритм восстановлен`,
    // первые меры у скорой (spec 2026-10-first-measures, часть 95): тяжёлому без нужной меры хуже; после четвёртой ступени —
    // остановка кровообращения, ритм не для разряда
    worse: (name: string, what: string) => `Хуже: ${name}, смотровая приёмного — ${what}`,
    code: (name: string) => `Код синий: остановка кровообращения — ${name}, смотровая приёмного. Ритм не для разряда`,
    died: (name: string, female: boolean, soft: boolean) =>
      (soft ? `${name}: ${ago(female, 'переведён', 'переведена')} в другую больницу в тяжёлом состоянии` : `${name} ${ago(female, 'умер', 'умерла')} в смотровой приёмного: реанимация без успеха`),
    // с утра сломался аппарат (FR-EQ-3, spec 2026-10-walk-breakdowns): до завтра его нет
    broken: (equipment: string, room: string) => `Не работает: ${lowerFirst(equipment)}${room ? ` (${lowerFirst(room)})` : ''} — починят к завтра`,
    end: '14:00 — приём по записи окончен, новых пациентов не будет',
    more: (n: number) => `${pluralRu(n, 'Пришёл', 'Пришли', 'Пришли')} ещё ${patients(n)}`,
  },
  checkup: 'профосмотр',
  // вернулся с другой болезнью (часть 41б) — тоже «стало хуже»: диагноз пометка не подсказывает
  returnNote: (reason: 'worse' | 'reaction' | 'unchanged', day: number, female: boolean) =>
    reason === 'worse' ? `Повторно: после приёма в день ${day} стало хуже`
      : reason === 'reaction' ? `Повторно: после приёма в день ${day} — реакция на лечение`
        : `Повторно: после приёма в день ${day} ${ago(female, 'не поправился', 'не поправилась')}`,
  outcomeLater: 'Узнаете в итогах следующих дней: за отпущенными домой игра следит неделю',
  toQueue: 'К очереди',
  toSummary: 'К итогам дня',
  noPatient: 'В кабинете никого',
  summary: {
    // карточка дня (spec 2026-10-premium-polish): «День N закрыт», главные числа — плитками, остальное — строками,
    // каждое число один раз
    closed: (d: number) => `День ${d} закрыт`,
    tileSeen: 'Принято',
    tileCorrect: 'Верный диагноз',
    tileConfidence: 'Уверенность идеального врача',
    tileLeft: 'Ушли, не дождавшись',
    of: (a: number, b: number) => `${a} из ${b}`,
    pct: (n: number) => `${n} %`,
    none: '—',
    achievementsLabel: 'Достижения дня',
    // с нанятыми врачами: плитка «Принято» — все вместе, строка — кто сколько; строки о диагнозах и деньгах — о ваших
    // приёмах
    seenBy: (mine: number, theirs: number) => `Вами — ${mine}, врачами — ${theirs}`,
    // верных — в плитке; здесь — остальное
    verdictRest: (partly: number, wrong: number) => `Диагноз почти верен: ${partly} · неверен: ${wrong}`,
    colleagues: 'Врачи',
    colleague: (name: string, role: string) => `${name}, ${role}`,
    colleagueGone: 'Врач, который больше не работает',
    colleagueLine: (seen: number, correct: number, partly: number, wrong: number, g: Record<string, number>, taken: number) =>
      `Принято: ${seen} · верно: ${correct} · почти: ${partly} · неверно: ${wrong} · оценки A — ${g.A} · B — ${g.B} · C — ${g.C} · D — ${g.D}${taken > 0 ? ` · вы забрали: ${taken}` : ''}`,
    unseen: (n: number) => `Не успели принять: ${n}`,
    grades: 'Оценки случаев',
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
      // первые меры (spec 2026-10-first-measures, часть 95): скольким тяжёлым нужны и скольким даны до первой ступени
      measures: (onTime: number, needed: number) => `Первые меры вовремя: ${onTime} из ${needed}.`,
      worse: (n: number) => `Стало хуже в смотровой: ${n}.`,
      died: (n: number, soft: boolean) => (soft ? `Переведены из смотровой в тяжёлом состоянии: ${n}.` : `Умерли в смотровой: ${n}.`),
    },
    // где ждали (spec 2026-10-where-waited, часть 96): по месту — сколько прошли, сколько ждали, сколько место работало
    waits: {
      title: 'Где ждали',
      you: 'Ваш приём',
      doctor: (name: string, role: string) => `${name}, ${role}`,
      // у лаборатории — пробы, у остальных — люди
      line: (place: string, what: string) => `${place}: ${what}`,
      free: (places: string) => `Без очереди: ${places}.`,
    },
    // сроки по рекомендации за день (spec 2026-10-chapter-3, часть 37): ваши приёмы
    targets: {
      title: 'Сроки',
      line: (name: string, onTime: number, total: number) => `${name} в срок: ${onTime} из ${total}.`,
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
      // палата интенсивной терапии (spec 2026-10-chapter-3, часть 38а)
      icu: (admitted: number, lying: number) => `Из них в палате интенсивной терапии — поступили: ${admitted}, лежат: ${lying}.`,
      // реанимация (spec 2026-10-chapter-4, часть 47)
      ricu: (admitted: number, lying: number) => `Из них в реанимации — поступили: ${admitted}, лежат: ${lying}.`,
      // боксы инфекционного отделения (часть 49а)
      box: (admitted: number, lying: number) => `Из них в боксах — поступили: ${admitted}, лежат: ${lying}.`,
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
      // кабинет нанятого врача и ординаторская (spec 2026-09-hired-doctors); у специалиста — по должности (часть 59)
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
      // палата интенсивной терапии (spec 2026-10-chapter-3, часть 38а)
      icu: 'ПИТ',
      // кабинет КТ (часть 40)
      ct: 'КТ',
      // реанимация (spec 2026-10-chapter-4, часть 47)
      ricu: 'ОРИТ',
      // бокс инфекционного отделения (часть 49а)
      box: 'Бокс',
      // кабинет МРТ (часть 50б)
      mri: 'МРТ',
      // эндоскопический кабинет (часть 53а)
      endoscopy: 'Эндоскопия',
    } as Record<string, string>,
    // кабинет специалиста (spec 2026-10-chapter-4, часть 59): «Кабинет гастроэнтеролога»
    specialistOffice: (doctorGen: string) => `Кабинет ${doctorGen}`,
    // для чтения с экрана: что на карте, словами
    label: (waiting: number, away: number, inRoom: string | undefined) =>
      `Карта амбулатории. В зале ожидания: ${patients(waiting)}; на обследованиях: ${patients(away)}; в кабинете: ${inRoom ?? 'никого'}.`,
    invite: 'Пригласить',
    // значки помещений на карте (spec 2026-09-living-map, часть 23): для чтения с экрана
    signs: {
      queue: (n: number) => `Ждут: ${n}`,
      // из ждущих — вернулись с готовыми результатами (spec 2026-10-code-blue, вопрос 51)
      results: (n: number) => `с результатами: ${n}`,
      noStaff: 'Нет персонала',
      // аппарат сломался с утра (FR-EQ-3, spec 2026-10-walk-breakdowns)
      broken: 'Аппарат в ремонте',
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
      // палата интенсивной терапии (spec 2026-10-chapter-3, часть 38а)
      icuDoctor: 'Анестезиолог-реаниматолог',
      icuNurse: 'Медсестра палаты интенсивной терапии',
      // кабинет КТ (часть 40)
      ctTech: 'Рентгенолаборант кабинета КТ',
      ctDoctor: 'Рентгенолог кабинета КТ',
      // реанимация (spec 2026-10-chapter-4, часть 47)
      ricuDoctor: 'Анестезиолог-реаниматолог реанимации',
      ricuNurse: 'Медсестра реанимации',
      // кабинет МРТ (часть 50б)
      mriTech: 'Рентгенолаборант кабинета МРТ',
      mriDoctor: 'Рентгенолог кабинета МРТ',
      // эндоскопический кабинет (часть 53а)
      endoscopist: 'Врач-эндоскопист',
      endoscopyNurse: 'Медсестра эндоскопического кабинета',
      // смотровая приёмного (spec 2026-10-code-blue)
      erNurse: 'Медсестра смотровой приёмного',
    } as Record<string, string>,
    // нанятый врач (spec 2026-09-hired-doctors): кто он и кого принимает; специалист — по своей должности (часть 59)
    therapist: (name: string, role: string, skill: number) => `${name}, ${role} · навык ${skill}`,
    therapistWith: (patient: string) => `Принимает: ${patient}`,
    duty: {
      registrar: 'Записывает пришедших и заводит на них карту',
      nurse: 'Каждому пришедшему меряет давление, пульс, температуру и сатурацию и решает, кого принять первым',
      doctor: 'Принимаете пациентов: расспрос, осмотр, обследования, диагноз и лечение',
      therapist: 'Сейчас без пациента — позовёт следующего из очереди',
      specialist: 'Сейчас без пациента — позовёт следующего из записанных к нему',
      procedureNurse: 'Берёт кровь на анализы',
      labTech: 'Делает анализы крови и мочи',
      ecgNurse: 'Снимает ЭКГ',
      radiographer: 'Делает рентгеновские снимки',
      radiologist: 'Описывает снимки: его заключение приходит вместе со снимком',
      sonographer: 'Делает УЗИ и сразу описывает, что видит',
      icuDoctor: 'Ведёт тяжёлых больных под мониторами',
      icuNurse: 'Следит за мониторами и ставит капельницы',
      ctTech: 'Укладывает пациента на стол томографа и ведёт съёмку',
      ctDoctor: 'Описывает срезы КТ: его заключение приходит вместе с ними',
      ricuDoctor: 'Ведёт больных на ИВЛ и под мониторами',
      ricuNurse: 'Следит за аппаратами ИВЛ и мониторами, ставит капельницы',
      mriTech: 'Укладывает пациента в тоннель томографа и ведёт съёмку',
      mriDoctor: 'Описывает серии МРТ: его заключение приходит вместе с ними',
      endoscopist: 'Проводит эндоскоп, описывает увиденное и останавливает кровотечение',
      endoscopyNurse: 'Готовит пациента и эндоскоп, помогает при гемостазе',
      erNurse: 'Встречает привезённых скорой и следит за мониторами у коек смотровой',
    } as Record<string, string>,
    doing: {
      registration: 'В регистратуре: заводят карту',
      // очередь у регистратуры и медсестры; медсестра процедурной с пробирками (spec 2026-10-clinic-flow)
      registrationQueue: 'В очереди в регистратуру',
      triageQueue: 'Ждёт медсестру доврачебного кабинета',
      carry: 'Несёт пробирки в лабораторию',
      // бригада к остановке сердца (spec 2026-10-code-blue)
      code: 'Код синий: у койки в смотровой приёмного',
      // живой фон (spec 2026-10-living-background): санузел, перерыв, чтение
      toilet: 'В санузле',
      wash: 'Моет руки',
      toiletQueue: 'Ждёт у санузла: кабинки заняты',
      rest: 'Перерыв: в ординаторской',
      reading: 'Читает между приёмами',
      triage: 'У медсестры: давление, пульс, температура, сатурация',
      // между числом и единицей — неразрывный пробел (голос студии)
      waiting: (min: number) => `Ждёт приёма ${min}\u00a0мин`,
      office: 'У вас в кабинете',
      colleague: (doctorGen: string, doctor: string) => `На приёме у ${doctorGen}: ${doctor}`,
      exam: { xray: 'На рентгене', ecg: 'На ЭКГ', lab: 'Сдаёт анализы', ultrasound: 'На УЗИ', ct: 'На КТ', mri: 'На МРТ', endoscopy: 'На ЭГДС' } as Record<string, string>,
      examQueue: { xray: 'Ждёт очереди на рентген', ecg: 'Ждёт очереди на ЭКГ', lab: 'Ждёт очереди на анализы', ultrasound: 'Ждёт очереди на УЗИ', ct: 'Ждёт очереди на КТ', mri: 'Ждёт очереди на МРТ', endoscopy: 'Ждёт очереди на ЭГДС' } as Record<string, string>,
      results: (hh: string) => `Ждёт результатов — будут к ${hh}`,
      leaving: 'Приём окончен — уходит',
      left: (female: boolean) => ago(female, 'Не дождался приёма и уходит', 'Не дождалась приёма и уходит'),
      // палата (spec 2026-09-chapter-2, часть 26): день поступления — «первые сутки»
      ward: (days: number) => `В палате: ${days + 1}-е\u00a0сутки`,
      // палата интенсивной терапии (часть 38а)
      icu: (days: number) => `В палате интенсивной терапии: ${days + 1}-е\u00a0сутки`,
      // реанимация (spec 2026-10-chapter-4, часть 47)
      ricu: (days: number) => `В реанимации: ${days + 1}-е\u00a0сутки`,
      // бокс инфекционного отделения (часть 49а)
      box: (days: number) => `В боксе: ${days + 1}-е\u00a0сутки`,
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
    // палата интенсивной терапии (spec 2026-10-chapter-3, часть 38а): койки под мониторами
    icu: 'В ПИТ',
    freeIcuBeds: (free: number, all: number) => `палата интенсивной терапии · под монитором свободно ${free} из ${all}`,
    inIcu: 'Палата интенсивной терапии, под монитором',
    // реанимация (spec 2026-10-chapter-4, часть 47): койки с монитором и аппаратом ИВЛ
    ricu: 'В ОРИТ',
    freeRicuBeds: (free: number, all: number) => `реанимация · коек с ИВЛ свободно ${free} из ${all}`,
    inRicu: 'Реанимация, под монитором',
    onVent: 'Реанимация, на ИВЛ',
    // бокс инфекционного отделения (spec 2026-10-chapter-4, часть 49а): заразного кладут отдельно
    box: 'В бокс',
    freeBoxBeds: (free: number, all: number) => `инфекционное отделение · боксов свободно ${free} из ${all}`,
    inBox: 'Бокс инфекционного отделения',
    // фибрилляция желудочков в ПИТ (часть 39б): дежурные сняли её разрядом — строка обхода наутро
    shock: 'За сутки — фибрилляция желудочков: дежурные сняли её разрядом под монитором, ритм восстановлен',
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
      // вред другой болезнью (часть 42а): название лечения — в кавычках, падеж не нужен
      harmAs: (name: string, tx: string) => `${name} после лечения «${tx}»`,
    } as Record<'better' | 'same' | 'worse' | 'ready', string> & { reaction: (tx: string, by: string) => string; harmAs: (name: string, tx: string) => string },
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
    // первые меры (spec 2026-10-first-measures, часть 95): делает медсестра смотровой, сразу, до решения
    measures: 'Первые меры',
    measuresHint: 'делает медсестра смотровой — ваших минут они не стоят',
    // в карте больного — коротко: строка монитора и «Первые меры», кнопки — в листе по касанию
    measuresAll: 'кислород, инфузия, глюкоза, давящая повязка',
    measuresClose: 'Закрыть',
    give: 'дать',
    doing: (min: number) => `медсестра: ${min}\u00a0мин`,
    done: (at: string) => `дано в ${at}`,
    given: (at: string) => `первая мера — дано в ${at}`,
    monitor: 'Монитор',
    nurse: 'Медсестра смотровой',
    spo2: (v: number) => `сатурация ${v}\u00a0%`,
    bp: (v: number) => `верхнее давление ${v}`,
    pulse: (v: number) => `пульс ${v}`,
    breath: (v: number) => `дыхание ${v}`,
    woke: (female: boolean) => `${ago(female, 'пришёл', 'пришла')} в себя`,
    code: 'Код синий: бригада у койки',
    hintLabel: 'Что сделать сразу — по листу',
    hint: {
      oxygen: (v: number) => `кислород — сатурация ${v}\u00a0%`,
      fluids: (v: number) => `инфузия — верхнее давление ${v}`,
      glucose: 'глюкоза — сахар низкий',
      glucometer: 'проверить сахар глюкометром — сознание спутано',
      bleeding: 'давящая повязка — рана кровит',
    },
    bays: 'В смотровой',
    bayOpen: 'монитор и первые меры',
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
