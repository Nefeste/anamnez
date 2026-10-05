// npm run e2e — сценарий Playwright по веб-сборке (09-testing.md §4): все пять прототипов
// этапа 1 и смена этапа 2. Сначала `npm run export:web`. Снимки экранов — в tools/e2e/out/.
import { mkdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { clinicLayout } from '../../src/engine/hospital/clinic';
import { generatePatient } from '../../src/engine/med/generate';
import { apply, newCampaign, newSandbox, newShift, newSingle } from '../../src/engine/shift/engine';
import { DAY, SHIFT_END, SHIFT_SCHEMA_VERSION } from '../../src/engine/shift/types';
import { buildDb } from '../content/load';

const ROOT = join(import.meta.dir, '../..');
const DIST = join(ROOT, 'dist-web');
const OUT = join(import.meta.dir, 'out');
const golden = JSON.parse(readFileSync(join(ROOT, 'tools/test/fixtures/golden.json'), 'utf8'));
/** План амбулатории — тот же, что рисует карта смены: куда касаться. */
const CLINIC = clinicLayout(buildDb().db);
/** Участок песочницы — в клетках: куда касаться на экране стройки. */
const sandboxPlot = buildDb().db.economy.sandbox.plot;
mkdirSync(OUT, { recursive: true });

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.wav': 'audio/wav', '.ttf': 'font/ttf' };
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    const wanted = join(DIST, path === '/' ? 'index.html' : path);
    const name = (await Bun.file(wanted).exists()) ? wanted : join(DIST, 'index.html'); // одностраничное приложение
    return new Response(Bun.file(name), { headers: { 'content-type': TYPES[extname(name)] ?? 'application/octet-stream' } });
  },
});
const base = `http://127.0.0.1:${server.port}`;

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'да ' : 'НЕТ'} ${what}`);
  if (!ok) failures.push(what);
};
const text = async (page: Page, id: string) => (await page.getByTestId(id).innerText()).trim();
/** Только видимое: в веб-стеке предыдущий экран может остаться в DOM (статья поверх статьи). */
const visible = (page: Page, id: string) => page.locator(`[data-testid="${id}"]:visible`);
const visibleText = async (page: Page, id: string) => (await visible(page, id).first().innerText()).trim();

/**
 * «×4», если кнопкам скорости не мешает лист поверх экрана (подсказка наставника, лист передачи):
 * он приходит сам, с автопаузой, и закрывает их своим фоном — его закрывает тот, кто его ждёт. Лист
 * мог открыться и между проверкой и нажатием (так упал сценарий сборки тега v0.3.4: 30 с на «×4»
 * под подсказкой) — нажатие ждёт не дольше 2 с.
 */
async function fastClock(page: Page): Promise<void> {
  if ((await page.locator('[data-testid$="-sheet"]').count()) > 0) return;
  await page.getByTestId('tab-x4').click({ timeout: 2_000 }).catch(() => undefined);
}

/** Часы смены на ×4, пока не выполнится условие; автопаузу («срочный», «результаты») снимаем. */
async function runClockUntil(page: Page, done: () => Promise<boolean>, ms = 60_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await done()) return true;
    if ((await page.getByTestId('shift-pause-reason').count()) > 0) await fastClock(page);
    await page.waitForTimeout(250);
  }
  return false;
}

/**
 * «Пропустить» до первого в очереди. Часы идут с открытия смены: пациент может встать в очередь
 * раньше нажатия, и кнопка на том же месте станет «Пригласить» — нажатие позвало бы его (так упал
 * прогон 0.2.4 в песочнице). На паузе очередь сама не меняется, «Пропустить» снова пускает часы.
 * Вернёт, пришлось ли пропускать.
 */
async function skipToFirst(page: Page): Promise<boolean> {
  await page.getByTestId('tab-pause').click();
  const skip = (await page.getByTestId('shift-call').count()) === 0;
  if (skip) await page.getByTestId('shift-skip').click();
  await page.getByTestId('shift-call').waitFor({ timeout: 5_000 });
  return skip;
}

/**
 * Сохранение смены в конце дня 1 — из движка, как его записала бы игра: двое приняты утром,
 * остальные к 15:00 приняты или ушли. Чтение его — сценарий сохранения (spec first-shift).
 */
function endOfDaySave(): string {
  const { db } = buildDb();
  const s = newShift(db, { seed: 42, season: 'winter' });
  const see = () => {
    apply(db, s, { kind: 'call', id: s.queue[0] });
    apply(db, s, { kind: 'exam', exam: 'exam.ask_complaints' });
    apply(db, s, { kind: 'diagnose', id: 'cond.arvi' });
    apply(db, s, { kind: 'toggleTreatment', id: 'tx.rest_fluids' });
    apply(db, s, { kind: 'finish' });
  };
  apply(db, s, { kind: 'advance', seconds: 3600 });
  for (let i = 0; i < 2 && s.queue.length > 0; i++) see();
  apply(db, s, { kind: 'advance', seconds: 6 * 3600 });
  while (s.queue.length > 0) see();
  return JSON.stringify({ schemaVersion: SHIFT_SCHEMA_VERSION, savedAt: 'e2e', data: s });
}

/** «Смена» в амбулатории посёлка в конце дня: все приняты — «Закрыть день». Записана «позже всех» — её берёт «Продолжить». */
function singleEndOfDaySave(): string {
  const { db } = buildDb();
  const s = newSingle(db, { seed: 44, season: 'winter', difficulty: 'student', venue: 'preset.village' });
  const see = () => {
    apply(db, s, { kind: 'call', id: s.queue[0] });
    apply(db, s, { kind: 'exam', exam: 'exam.ask_complaints' });
    apply(db, s, { kind: 'diagnose', id: 'cond.arvi' });
    apply(db, s, { kind: 'finish' });
  };
  apply(db, s, { kind: 'advance', seconds: 3600 });
  for (let i = 0; i < 2 && s.queue.length > 0; i++) see();
  apply(db, s, { kind: 'advance', seconds: 6 * 3600 });
  while (s.queue.length > 0) see();
  return JSON.stringify({ schemaVersion: SHIFT_SCHEMA_VERSION, savedAt: '9999-12-31T00:00:00.000Z', data: s });
}

/** Песочница с готовой амбулаторией в конце дня 1: все приняты — «Закрыть день». */
function sandboxEndOfDaySave(): string {
  const { db } = buildDb();
  const s = newSandbox(db, { seed: 43, season: 'winter', difficulty: 'doctor', start: 'clinic', budget: db.economy.sandbox.budgets.normal });
  apply(db, s, { kind: 'nextDay' });
  const see = () => {
    apply(db, s, { kind: 'call', id: s.queue[0] });
    apply(db, s, { kind: 'exam', exam: 'exam.ask_complaints' });
    apply(db, s, { kind: 'diagnose', id: 'cond.arvi' });
    apply(db, s, { kind: 'toggleTreatment', id: 'tx.rest_fluids' });
    apply(db, s, { kind: 'finish' });
  };
  apply(db, s, { kind: 'advance', seconds: 3600 });
  for (let i = 0; i < 2 && s.queue.length > 0; i++) see();
  apply(db, s, { kind: 'advance', seconds: 6 * 3600 });
  while (s.queue.length > 0) see();
  return JSON.stringify({ schemaVersion: SHIFT_SCHEMA_VERSION, savedAt: 'e2e', data: s });
}

/**
 * Песочница с нанятым терапевтом (spec 2026-09-hired-doctors), день 1 открыт: справа от
 * амбулатории — коридор, ординаторская и второй кабинет.
 */
function hiredDayOne() {
  const { db } = buildDb();
  const s = newSandbox(db, { seed: 43, season: 'winter', difficulty: 'doctor', start: 'clinic', budget: db.economy.sandbox.budgets.normal });
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.staff', size: 'S', x: 30, y: 0, rot: 0 } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.office', size: 'M', x: 30, y: 10, rot: 2 } });
  apply(db, s, { kind: 'buildEnd' });
  const office = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
  const therapist = s.candidates!.find(c => c.role === 'role.therapist')!;
  apply(db, s, { kind: 'hire', id: therapist.id });
  apply(db, s, { kind: 'assign', id: therapist.id, room: office });
  apply(db, s, { kind: 'nextDay' });
  return { db, s };
}

/**
 * Посреди дня 1 (часть 19): вы свободны, терапевт ведёт приём — уже есть результаты, и ещё
 * 10 минут он будет у врача (проверено на копии дня), чтобы часы до паузы в сценарии не успели.
 */
function hiredMidDaySave(): { save: string; id: string } {
  const { db, s } = hiredDayOne();
  const stays = (id: string) => {
    const copy = structuredClone(s);
    for (let i = 0; i < 10; i++) apply(db, copy, { kind: 'advance', seconds: 60 });
    return copy.patients[id].status === 'inRoom' && copy.patients[id].by === s.patients[id].by;
  };
  const busy = () => Object.values(s.patients).find(p => p.by !== undefined && p.status === 'inRoom' && p.results.length > 1 && stays(p.id));
  for (let i = 0; i < 9 * 60 && !busy(); i++) apply(db, s, { kind: 'advance', seconds: 60 });
  const p = busy()!;
  return { save: JSON.stringify({ schemaVersion: SHIFT_SCHEMA_VERSION, savedAt: 'e2e', data: s }), id: p.id };
}

/**
 * Песочница с нанятым терапевтом в конце дня 1: врач принял своих, вы — остальных.
 */
function hiredEndOfDaySave(): string {
  const { db, s } = hiredDayOne();
  const see = () => {
    apply(db, s, { kind: 'call', id: s.queue[0] });
    apply(db, s, { kind: 'exam', exam: 'exam.ask_complaints' });
    apply(db, s, { kind: 'diagnose', id: 'cond.arvi' });
    apply(db, s, { kind: 'finish' });
  };
  const busy = () => Object.values(s.patients).some(p => p.by !== undefined && (p.status === 'inRoom' || p.status === 'waiting' || p.status === 'away'));
  for (let i = 0; i < 9 * 60; i++) {
    apply(db, s, { kind: 'advance', seconds: 60 });
    if (s.queue.length > 0 && s.queue.length % 3 === 0) see();
  }
  while (s.queue.length > 0) see();
  for (let i = 0; i < 600 && busy(); i++) apply(db, s, { kind: 'advance', seconds: 60 });
  return JSON.stringify({ schemaVersion: SHIFT_SCHEMA_VERSION, savedAt: 'e2e', data: s });
}

/**
 * Песочница с палатой на четыре койки (spec 2026-09-chapter-2, часть 26), день 2 после
 * рабочих часов: вчера одного положили в палату, сегодня следующий — у вас в кабинете,
 * диагноз поставлен; день можно закрыть.
 */
function wardSave(): { save: string; admitted: string; next: string } {
  const { db } = buildDb();
  const s = newSandbox(db, { seed: 21, season: 'winter', difficulty: 'student', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.ward', size: 'M', x: 29, y: 0, rot: 0 } });
  apply(db, s, { kind: 'buildEnd' });
  const ward = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
  apply(db, s, { kind: 'assign', id: s.staff!.find(m => m.role === 'role.nurse' && m.room === 'r7')!.id, room: ward });
  // диагноз — настоящий, лечение — типичное из записи
  const see = () => {
    for (let i = 0; i < 600 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
    const id = s.queue[0];
    const truth = s.patients[id].patient.truth.conditions[0].id;
    apply(db, s, { kind: 'call', id });
    apply(db, s, { kind: 'exam', exam: 'exam.vitals' });
    apply(db, s, { kind: 'diagnose', id: truth });
    const typical = db.conditions[truth].treatment;
    for (const tx of typical?.plan ?? typical?.firstLine ?? []) apply(db, s, { kind: 'toggleTreatment', id: tx });
    return id;
  };
  apply(db, s, { kind: 'nextDay' });
  const admitted = see();
  apply(db, s, { kind: 'setting', setting: 'admit' });
  apply(db, s, { kind: 'finish' });
  apply(db, s, { kind: 'closeDay' });
  apply(db, s, { kind: 'nextDay' });
  const next = see();
  while (s.t < (s.day - 1) * DAY + SHIFT_END) apply(db, s, { kind: 'advance', seconds: 10 * 60 });
  return { save: JSON.stringify({ schemaVersion: SHIFT_SCHEMA_VERSION, savedAt: 'e2e', data: s }), admitted, next };
}

/**
 * Песочница со смотровой приёмного (spec 2026-09-chapter-2, часть 27), день 1 после рабочих
 * часов: скорая привозила пациентов, никого не отсортировали — ждут в смотровой и у входа.
 */
function ambulanceSave(): { save: string; id: string; dx: string; scale: string; flag?: string; cars: number } {
  const { db } = buildDb();
  const s = newSandbox(db, { seed: 21, season: 'winter', difficulty: 'student', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.emergency', size: 'M', x: 29, y: 1, rot: 0 } });
  apply(db, s, { kind: 'buildEnd' });
  const er = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
  apply(db, s, { kind: 'assign', id: s.staff!.find(m => m.role === 'role.nurse' && m.room === 'r7')!.id, room: er });
  apply(db, s, { kind: 'nextDay' });
  while (s.t < (s.day - 1) * DAY + SHIFT_END) apply(db, s, { kind: 'advance', seconds: 10 * 60 });
  const cars = Object.values(s.patients).filter(p => p.kind === 'ambulance').sort((a, b) => a.arriveT - b.arriveT);
  const p = cars[0];
  const flag = p.scale!.flag ? db.findings[p.scale!.flag].name.ru : undefined;
  return {
    save: JSON.stringify({ schemaVersion: SHIFT_SCHEMA_VERSION, savedAt: 'e2e', data: s }), id: p.id, dx: p.patient.truth.conditions[0].id, scale: p.scale!.triage,
    ...(flag ? { flag } : {}), cars: cars.length,
  };
}

/**
 * Смотровая приёмного с монитором с дефибриллятором (spec 2026-10-chapter-3, часть 37): скорая
 * привезла давящую боль в груди — он лежит в смотровой, ещё не отсортирован; прочих привезённых
 * до него врач перевёл, чтобы места не были заняты. Часы стоят сразу после его приезда — под
 * конец рабочих часов: после приёма до «Закрыть день» на ×4 — секунды.
 */
function bedsideSave(swap?: (db: ReturnType<typeof buildDb>['db']) => ReturnType<typeof generatePatient>): { save: string; id: string; dx: string; scale: string } {
  const { db } = buildDb();
  for (let seed = 21; seed < 221; seed++) {
    const s = newSandbox(db, { seed, season: 'winter', difficulty: 'student', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
    const cells: [number, number][] = [];
    for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
    apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
    apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.emergency', size: 'M', x: 29, y: 1, rot: 0 } });
    const er = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
    apply(db, s, { kind: 'build', cmd: { kind: 'buy', room: er, equipment: 'eq.monitor_defib' } });
    apply(db, s, { kind: 'buildEnd' });
    apply(db, s, { kind: 'assign', id: s.staff!.find(m => m.role === 'role.nurse' && m.room === 'r7')!.id, room: er });
    apply(db, s, { kind: 'nextDay' });
    const late = (s.day - 1) * DAY + SHIFT_END - 90 * 60;
    for (let i = 0; i < 6 * 60; i++) {
      const waiting = Object.values(s.patients).filter(p => p.kind === 'ambulance' && p.status === 'waiting' && !p.sorted && p.scale);
      const p = waiting.find(q => q.bay && q.patient.complaints.includes('sym.chest_pain_pressing'));
      if (p && p.arriveT < late) break; // привезли с утра — день дожидать долго: следующее зерно
      if (p && !s.current) {
        // инфаркт с подъёмом ST вместо того, кого привезли (часть 39б): исход перевода по часам
        if (swap) p.patient = swap(db);
        return { save: JSON.stringify({ schemaVersion: SHIFT_SCHEMA_VERSION, savedAt: 'e2e', data: s }), id: p.id, dx: p.patient.truth.conditions[0].id, scale: p.scale!.triage };
      }
      const other = waiting.find(q => !q.patient.complaints.includes('sym.chest_pain_pressing'));
      if (other && !s.current) {
        apply(db, s, { kind: 'sort', id: other.id, triage: other.scale!.triage });
        apply(db, s, { kind: 'call', id: other.id });
        apply(db, s, { kind: 'diagnose', id: other.patient.truth.conditions[0].id });
        apply(db, s, { kind: 'setting', setting: 'ambulance' });
        apply(db, s, { kind: 'finish' });
        continue;
      }
      apply(db, s, { kind: 'advance', seconds: 60 });
    }
  }
  throw new Error('e2e: за 200 зёрен никого с болью в груди в смотровую не привезли');
}

/**
 * Песочница с палатой и операционной (spec 2026-09-chapter-2, часть 28): стол, наркозный
 * аппарат, бригада из кандидатов; день 1 после рабочих часов — у вас в кабинете пациент с
 * аппендицитом, диагноз поставлен.
 */
function surgerySave(): { save: string; id: string } {
  const { db } = buildDb();
  const s = newSandbox(db, { seed: 21, season: 'winter', difficulty: 'student', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.ward', size: 'M', x: 29, y: 0, rot: 0 } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.or', size: 'M', x: 29, y: 10, rot: 2 } });
  const ward = s.hospital!.rooms.find(r => r.type === 'room.ward')!.id;
  const or = s.hospital!.rooms.find(r => r.type === 'room.or')!.id;
  for (const equipment of ['eq.or_table', 'eq.anesthesia']) apply(db, s, { kind: 'build', cmd: { kind: 'buy', room: or, equipment } });
  apply(db, s, { kind: 'buildEnd' });
  apply(db, s, { kind: 'assign', id: s.staff!.find(m => m.role === 'role.nurse' && m.room === 'r7')!.id, room: ward });
  for (const role of ['role.surgeon', 'role.anesthetist', 'role.or_nurse']) {
    const c = s.candidates!.find(x => x.role === role)!;
    apply(db, s, { kind: 'hire', id: c.id });
    apply(db, s, { kind: 'assign', id: c.id, room: or });
  }
  apply(db, s, { kind: 'nextDay' });
  for (let i = 0; i < 600 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
  const id = s.queue[0];
  // пришёл с аппендицитом: болезнь пациента — из генератора, как в тестах движка
  s.patients[id].patient = generatePatient(db, 4242, { department: 'dept.therapy', season: 'winter', primary: 'cond.appendicitis', params: {} });
  apply(db, s, { kind: 'call', id });
  apply(db, s, { kind: 'exam', exam: 'exam.vitals' });
  apply(db, s, { kind: 'diagnose', id: 'cond.appendicitis' });
  while (s.t < (s.day - 1) * DAY + SHIFT_END) apply(db, s, { kind: 'advance', seconds: 10 * 60 });
  return { save: JSON.stringify({ schemaVersion: SHIFT_SCHEMA_VERSION, savedAt: 'e2e', data: s }), id };
}

/**
 * Песочница с палатой интенсивной терапии на две койки (spec 2026-10-chapter-3, часть 38а): два
 * монитора с дефибриллятором, медсестра ЭКГ — в ПИТ, анестезиолог-реаниматолог — из кандидатов;
 * день 1 — у вас в кабинете пациент с анафилактическим шоком, диагноз и эпинефрин назначены.
 */
function icuSave(): { save: string; id: string } {
  const { db } = buildDb();
  const s = newSandbox(db, { seed: 21, season: 'winter', difficulty: 'student', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.icu', size: 'S', x: 29, y: 0, rot: 0 } });
  const icu = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
  for (let i = 0; i < 2; i++) apply(db, s, { kind: 'build', cmd: { kind: 'buy', room: icu, equipment: 'eq.monitor_defib' } });
  apply(db, s, { kind: 'buildEnd' });
  apply(db, s, { kind: 'assign', id: s.staff!.find(m => m.role === 'role.nurse' && m.room === 'r7')!.id, room: icu });
  const c = s.candidates!.find(x => x.role === 'role.anesthetist')!;
  apply(db, s, { kind: 'hire', id: c.id });
  apply(db, s, { kind: 'assign', id: c.id, room: icu });
  apply(db, s, { kind: 'nextDay' });
  for (let i = 0; i < 600 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
  const id = s.queue[0];
  s.patients[id].patient = generatePatient(db, 4747, { department: 'dept.therapy', season: 'winter', primary: 'cond.anaphylaxis', params: {} });
  apply(db, s, { kind: 'call', id });
  apply(db, s, { kind: 'exam', exam: 'exam.vitals' });
  apply(db, s, { kind: 'diagnose', id: 'cond.anaphylaxis' });
  // кислород через маску — всем с анафилактическим шоком (часть 38б, 263_2, рек. 22)
  for (const tx of ['tx.epinephrine_im', 'tx.iv_fluids', 'tx.steroid_iv', 'tx.oxygen_mask']) apply(db, s, { kind: 'toggleTreatment', id: tx });
  return { save: JSON.stringify({ schemaVersion: SHIFT_SCHEMA_VERSION, savedAt: 'e2e', data: s }), id };
}

/**
 * Песочница с кабинетом УЗИ (spec 2026-09-chapter-2, часть 29): УЗ-аппарат, врач УЗД из
 * кандидатов; день 1 — у вас в кабинете пациент с аппендицитом, УЗИ сделано и описано
 * («Студент»: обследования не ошибаются — отросток виден).
 */
function usSave(): { save: string; id: string } {
  const { db } = buildDb();
  const s = newSandbox(db, { seed: 23, season: 'winter', difficulty: 'student', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.ultrasound', size: 'S', x: 29, y: 0, rot: 0 } });
  const us = s.hospital!.rooms.find(r => r.type === 'room.ultrasound')!.id;
  apply(db, s, { kind: 'build', cmd: { kind: 'buy', room: us, equipment: 'eq.us_basic' } });
  apply(db, s, { kind: 'buildEnd' });
  const c = s.candidates!.find(x => x.role === 'role.sonographer')!;
  apply(db, s, { kind: 'hire', id: c.id });
  apply(db, s, { kind: 'assign', id: c.id, room: us });
  apply(db, s, { kind: 'nextDay' });
  for (let i = 0; i < 600 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
  const id = s.queue[0];
  s.patients[id].patient = generatePatient(db, 4343, { department: 'dept.therapy', season: 'winter', primary: 'cond.appendicitis', params: {} });
  apply(db, s, { kind: 'call', id });
  apply(db, s, { kind: 'exam', exam: 'exam.vitals' });
  apply(db, s, { kind: 'exam', exam: 'exam.us_abdomen' });
  apply(db, s, { kind: 'waitResults' });
  return { save: JSON.stringify({ schemaVersion: SHIFT_SCHEMA_VERSION, savedAt: 'e2e', data: s }), id };
}

/**
 * Песочница со смотровой приёмного и кабинетом УЗИ (spec 2026-09-chapter-2, часть 30): больница
 * принимает и хирургию; день 1 — у вас в кабинете больной острым холециститом, УЗИ сделано и
 * описано («Студент»: обследования не ошибаются — камни и толстая стенка видны).
 */
function gallSave(): { save: string; id: string } {
  const { db } = buildDb();
  const s = newSandbox(db, { seed: 25, season: 'winter', difficulty: 'student', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.emergency', size: 'M', x: 29, y: 1, rot: 0 } });
  const er = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.ultrasound', size: 'S', x: 29, y: 10, rot: 2 } });
  const us = s.hospital!.rooms.find(r => r.type === 'room.ultrasound')!.id;
  apply(db, s, { kind: 'build', cmd: { kind: 'buy', room: us, equipment: 'eq.us_basic' } });
  apply(db, s, { kind: 'buildEnd' });
  apply(db, s, { kind: 'assign', id: s.staff!.find(m => m.role === 'role.nurse' && m.room === 'r7')!.id, room: er });
  const c = s.candidates!.find(x => x.role === 'role.sonographer')!;
  apply(db, s, { kind: 'hire', id: c.id });
  apply(db, s, { kind: 'assign', id: c.id, room: us });
  apply(db, s, { kind: 'nextDay' });
  for (let i = 0; i < 600 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
  const id = s.queue[0];
  if (!s.patients[id].departments?.includes('dept.surgery')) throw new Error('gallSave: смотровая приёмного не работает — хирургию не принимают');
  s.patients[id].patient = generatePatient(db, 4545, { department: 'dept.therapy', departments: s.patients[id].departments, season: 'winter', primary: 'cond.cholecystitis', params: {} });
  apply(db, s, { kind: 'call', id });
  apply(db, s, { kind: 'exam', exam: 'exam.vitals' });
  apply(db, s, { kind: 'exam', exam: 'exam.us_abdomen' });
  // привезла скорая — ожидание кончается с её приездом (часть 37): ждать снова, пока не придёт УЗИ
  for (let i = 0; i < 20 && s.patients[id].pending.length > 0; i++) apply(db, s, { kind: 'waitResults' });
  return { save: JSON.stringify({ schemaVersion: SHIFT_SCHEMA_VERSION, savedAt: 'e2e', data: s }), id };
}

/**
 * Песочница со смотровой приёмного и кабинетом КТ (spec 2026-10-chapter-3, часть 40): больница
 * принимает и травму; томограф на 16 срезов, рентгенолаборант и рентгенолог из кандидатов; день 1 —
 * у вас в кабинете сотрясение с рвотой, КТ по правилу показана; расспрос, осмотр и КТ сделаны, КТ
 * описана («Студент»: обследования не ошибаются).
 */
function ctSave(): { save: string; id: string } {
  const { db } = buildDb();
  const s = newSandbox(db, { seed: 25, season: 'winter', difficulty: 'student', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  // томограф дороже «щедрого» бюджета
  s.economy!.cash = 6_000_000;
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.emergency', size: 'M', x: 29, y: 1, rot: 0 } });
  const er = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
  apply(db, s, { kind: 'build', cmd: { kind: 'room', type: 'room.ct', size: 'M', x: 29, y: 10, rot: 2 } });
  const ct = s.hospital!.rooms.find(r => r.type === 'room.ct')!.id;
  apply(db, s, { kind: 'build', cmd: { kind: 'buy', room: ct, equipment: 'eq.ct_16' } });
  apply(db, s, { kind: 'buildEnd' });
  apply(db, s, { kind: 'assign', id: s.staff!.find(m => m.role === 'role.nurse' && m.room === 'r7')!.id, room: er });
  for (const role of ['role.radiographer', 'role.radiologist']) {
    const c = s.candidates!.find(x => x.role === role);
    if (!c) throw new Error(`ctSave: среди кандидатов нет ${role}`);
    apply(db, s, { kind: 'hire', id: c.id });
    apply(db, s, { kind: 'assign', id: c.id, room: ct });
  }
  apply(db, s, { kind: 'nextDay' });
  for (let i = 0; i < 600 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
  const id = s.queue[0];
  const departments = s.patients[id].departments;
  if (!departments?.includes('dept.trauma')) throw new Error('ctSave: смотровая приёмного не работает — травму не принимают');
  // сотрясение с рвотой, без оглушения: КТ показана, после неё — дома
  let seed = 4700;
  const has = (p: ReturnType<typeof generatePatient>, f: string) => p.truth.findings.some(x => x.f === f);
  let patient = generatePatient(db, seed, { department: 'dept.trauma', departments, season: 'winter', primary: 'cond.concussion', params: {} });
  while (!has(patient, 'sym.vomiting') || has(patient, 'sign.gcs_low')) patient = generatePatient(db, ++seed, { department: 'dept.trauma', departments, season: 'winter', primary: 'cond.concussion', params: {} });
  s.patients[id].patient = patient;
  apply(db, s, { kind: 'call', id });
  for (const exam of ['exam.ask_head_injury', 'exam.neuro_exam', 'exam.ct_head']) apply(db, s, { kind: 'exam', exam });
  for (let i = 0; i < 20 && s.patients[id].pending.length > 0; i++) apply(db, s, { kind: 'waitResults' });
  if (!s.patients[id].results.some(r => r.exam === 'exam.ct_head')) throw new Error('ctSave: КТ не пришла');
  return { save: JSON.stringify({ schemaVersion: SHIFT_SCHEMA_VERSION, savedAt: 'e2e', data: s }), id };
}

/**
 * Песочница (spec 2026-10-chapter-3, часть 41а): справа — смотровая приёмного с монитором, кабинет КТ и
 * ниже — ПИТ на две койки. Первая машина скорой везёт ишемический инсульт в окне: 2 часа от начала, NIHSS
 * 5 и больше, без окклюзии и без нарушения глотания. Он лежит в смотровой и вызван; осмотр, расспрос,
 * глюкоза, КТ, вопросы перед тромболизисом и тест глотания готовы («Студент»: без ошибок).
 */
function strokeSave(): { save: string; id: string } {
  const fits = (x: ReturnType<typeof generatePatient>) => {
    const c = x.truth.conditions[0].params;
    return x.age >= 40 && x.truth.values['hx.onset_hours'] === 2 && c.minor === 'no' && c.thrombectomy === 'no' && c.dysphagia === 'no'
      && x.complaints.includes('sym.weakness_one_side') && !x.truth.risks.some(r => r === 'risk.anticoagulants' || r === 'risk.bleeding_tendency');
  };
  return neuroSave('cond.stroke_ischemic', fits, ['exam.neuro_exam', 'exam.ask_stroke', 'exam.glucometer', 'exam.ct_head', 'exam.ask_lysis', 'exam.swallow_test']);
}

/**
 * Песочница с приёмным, КТ и ПИТ (часть 41б): первая машина скорой везёт транзиторную ишемическую
 * атаку высокого риска — 60 лет и старше, слабость прошла, длилось час и дольше, давление высокое; всё,
 * что меняет баллы ABCD2, проверено.
 */
function tiaSave(): { save: string; id: string } {
  const fits = (x: ReturnType<typeof generatePatient>) => {
    const has = (f: string) => x.truth.findings.some(y => y.f === f);
    return x.age >= 60 && has('sym.transient_weakness') && has('hx.tia_long') && has('vital.bp_high') && !x.truth.risks.includes('risk.allergy_nsaid');
  };
  return neuroSave('cond.tia', fits, ['exam.neuro_exam', 'exam.ask_tia', 'exam.vitals', 'exam.ask_chronic', 'exam.ct_head', 'exam.ask_allergies']);
}

/**
 * Песочница с приёмным, КТ и ПИТ (часть 41в): первая машина скорой везёт внутримозговое кровоизлияние —
 * гематома до 30 см³, давление 140 и выше, без антикоагулянтов и без нарушения глотания; осмотр,
 * расспрос, давление, КТ, вопросы перед тромболизисом и тест глотания готовы.
 */
function ichSave(): { save: string; id: string } {
  const fits = (x: ReturnType<typeof generatePatient>) => {
    const c = x.truth.conditions[0].params;
    return x.age >= 40 && c.volume === 'small' && c.sbp140 === 'no' && c.reversal === 'no' && c.dysphagia === 'no'
      && x.complaints.includes('sym.weakness_one_side') && !x.truth.risks.includes('risk.allergy_nsaid');
  };
  return neuroSave('cond.ich', fits, ['exam.neuro_exam', 'exam.ask_stroke', 'exam.vitals', 'exam.ct_head', 'exam.ask_lysis', 'exam.swallow_test']);
}

/**
 * Песочница с приёмным, КТ и ПИТ (часть 42а): первая машина скорой везёт трепетание предсердий — стабильное,
 * меньше 48 часов, с порога CHA₂DS₂-VASc; без астмы — бета-адреноблокатор можно; ЭКГ у постели, давление,
 * хронические болезни и начало готовы.
 */
function afSave(): { save: string; id: string } {
  const fits = (x: ReturnType<typeof generatePatient>) => {
    const c = x.truth.conditions[0].params;
    return x.age >= 40 && c.type === 'flutter' && c.unstable === 'no' && c.recent === 'yes' && c.oac === 'yes'
      && !x.truth.conditions.some(k => k.id === 'cond.asthma') && x.truth.risks.length <= 2;
  };
  return neuroSave('cond.af', fits, ['exam.ecg', 'exam.vitals', 'exam.ask_chronic', 'exam.ask_onset']);
}

/**
 * Песочница с приёмным, КТ и ПИТ (часть 42б): первая машина скорой везёт приступ наджелудочковой тахикардии —
 * стабильный, без астмы: трифосаденин можно; ЭКГ у постели, пульс, давление и хронические болезни готовы.
 */
function svtSave(): { save: string; id: string } {
  const fits = (x: ReturnType<typeof generatePatient>) => x.age >= 15 && x.truth.conditions[0].params.unstable === 'no'
    && !x.truth.conditions.some(k => k.id === 'cond.asthma') && x.truth.risks.length <= 2;
  return neuroSave('cond.svt', fits, ['exam.ecg', 'exam.vitals', 'exam.ask_chronic']);
}

/**
 * Песочница с приёмным, КТ и ПИТ (часть 42в): первая машина скорой везёт полную АВ-блокаду с широким
 * выскальзывающим ритмом и низким давлением, без фибрилляции предсердий в прошлом; ЭКГ у постели, пульс,
 * давление и хронические болезни готовы.
 */
function avbSave(): { save: string; id: string } {
  const fits = (x: ReturnType<typeof generatePatient>) => {
    const c = x.truth.conditions[0].params;
    return x.age >= 50 && c.block === 'wide' && c.unstable === 'yes' && !x.truth.risks.includes('risk.atrial_fibrillation') && x.truth.risks.length <= 2;
  };
  return neuroSave('cond.av_block', fits, ['exam.ecg', 'exam.vitals', 'exam.ask_chronic']);
}

/**
 * Песочница с приёмным, КТ и ПИТ (часть 43а): первая машина скорой везёт расслоение аорты типа B — без астмы и
 * ХОБЛ: бета-адреноблокатор можно; ЭКГ у постели, давление на обеих руках, хронические болезни и
 * КТ-ангиография груди готовы.
 */
function adSave(): { save: string; id: string } {
  const fits = (x: ReturnType<typeof generatePatient>) => x.age >= 40 && x.truth.conditions[0].params.type === 'b'
    && !x.truth.conditions.some(k => k.id === 'cond.asthma' || k.id === 'cond.copd') && x.truth.risks.length <= 2;
  return neuroSave('cond.aortic_dissection', fits, ['exam.ecg', 'exam.bp_both_arms', 'exam.ask_chronic', 'exam.cta_chest']);
}

/**
 * Песочница с приёмным, КТ и ПИТ (часть 43б): первая машина скорой везёт ТЭЛА низкого риска — без шока и
 * расширенного правого желудочка, sPESI 0, сатурация 90 и выше; жалоба — внезапная одышка: расспрос о ноге,
 * хронические болезни, пульс и давление и КТ-ангиография груди готовы.
 */
function peSave(): { save: string; id: string } {
  const fits = (x: ReturnType<typeof generatePatient>) => {
    const k = x.truth.conditions[0].params;
    return x.age >= 40 && x.complaints.includes('sym.dyspnea_sudden') && k.shock === 'no' && k.rv === 'no' && k.spesi === 'no' && k.spo2_below90 === 'no' && x.truth.risks.length <= 2;
  };
  return neuroSave('cond.pe', fits, ['exam.ask_chronic', 'exam.ask_leg', 'exam.vitals', 'exam.cta_chest']);
}

/**
 * Песочница с приёмным, КТ и ПИТ (часть 43в): первая машина скорой везёт острую декомпенсацию сердечной
 * недостаточности с отёком лёгких, сатурация 90 и выше; расспрос, пульс и давление, лёгкие, NT-proBNP и снимок груди
 * готовы.
 */
function adhfSave(): { save: string; id: string } {
  const fits = (x: ReturnType<typeof generatePatient>) => {
    const k = x.truth.conditions[0].params;
    return x.age >= 50 && k.type === 'edema' && k.spo2_below90 === 'no' && x.truth.risks.length <= 3 && x.complaints.includes('sym.dyspnea');
  };
  return neuroSave('cond.adhf', fits, ['exam.ask_chronic', 'exam.ask_complaints', 'exam.vitals', 'exam.lung_auscultation', 'exam.nt_probnp', 'exam.xray_chest']);
}

/**
 * Песочница с приёмным, КТ и ПИТ (часть 43г): первая машина скорой везёт гипертонический криз с энцефалопатией —
 * жалоба на резкий подъём давления, оглушение и тошнота; ЭКГ у постели — первой (срок 15 минут), затем расспрос,
 * давление, неврологический осмотр и глазное дно. Без тошноты, рвоты и пелены одно оглушение «идеальный врач» мог
 * бы счесть ошибкой осмотра: подъём без поражения органов вдесятеро чаще.
 */
function crisisSave(): { save: string; id: string } {
  const fits = (x: ReturnType<typeof generatePatient>) => {
    const k = x.truth.conditions[0].params;
    return x.age >= 45 && k.organ === 'encephalopathy' && x.truth.risks.length <= 3 && x.complaints.includes('sym.bp_surge')
      && ['sign.gcs_low', 'sym.nausea'].every(f => x.truth.findings.some(y => y.f === f));
  };
  return neuroSave('cond.hypertensive_crisis', fits, ['exam.ecg', 'exam.ask_chronic', 'exam.ask_complaints', 'exam.ask_abdomen', 'exam.vitals', 'exam.neuro_exam', 'exam.fundoscopy']);
}

/** Больница с приёмным, КТ и ПИТ; первую машину скорой подменяет больной `primary`, для которого верно `fits`; сделаны `exams`. */
function neuroSave(primary: string, fits: (x: ReturnType<typeof generatePatient>) => boolean, exams: string[]): { save: string; id: string } {
  const { db } = buildDb();
  const s = newSandbox(db, { seed: 25, season: 'winter', difficulty: 'student', start: 'clinic', budget: db.economy.sandbox.budgets.generous });
  // томограф дороже «щедрого» бюджета
  s.economy!.cash = 8_000_000;
  const cells: [number, number][] = [];
  for (let x = 29; x <= 38; x++) for (let y = 7; y <= 9; y++) cells.push([x, y]);
  for (let y = 10; y <= 16; y++) cells.push([38, y]);
  for (let x = 29; x <= 38; x++) for (let y = 17; y <= 19; y++) cells.push([x, y]);
  apply(db, s, { kind: 'build', cmd: { kind: 'corridor', cells } });
  const room = (type: string, size: 'S' | 'M', x: number, y: number, rot: 0 | 2, equipment: string[]) => {
    apply(db, s, { kind: 'build', cmd: { kind: 'room', type, size, x, y, rot } });
    const id = s.hospital!.rooms[s.hospital!.rooms.length - 1].id;
    for (const e of equipment) apply(db, s, { kind: 'build', cmd: { kind: 'buy', room: id, equipment: e } });
    return id;
  };
  const er = room('room.emergency', 'M', 29, 1, 0, ['eq.monitor_defib']);
  const ct = room('room.ct', 'M', 29, 10, 2, ['eq.ct_16']);
  const icu = room('room.icu', 'S', 29, 20, 2, ['eq.monitor_defib', 'eq.monitor_defib']);
  apply(db, s, { kind: 'buildEnd' });
  apply(db, s, { kind: 'assign', id: s.staff!.find(m => m.role === 'role.nurse' && m.room === 'r7')!.id, room: er });
  for (const [role, to] of [['role.radiographer', ct], ['role.radiologist', ct], ['role.nurse', icu], ['role.anesthetist', icu]] as const) {
    const c = s.candidates!.find(x => x.role === role && !s.staff!.some(m => m.id === x.id));
    if (!c) throw new Error(`neuroSave: среди кандидатов нет ${role}`);
    apply(db, s, { kind: 'hire', id: c.id });
    apply(db, s, { kind: 'assign', id: c.id, room: to });
  }
  apply(db, s, { kind: 'nextDay' });
  const p = Object.values(s.patients).filter(q => q.kind === 'ambulance' && q.status === 'coming').sort((a, b) => a.arriveT - b.arriveT)[0];
  if (!p?.departments?.includes('dept.neurology')) throw new Error('neuroSave: кабинет КТ не работает — неврологию не принимают');
  const make = (seed: number) => generatePatient(db, seed, { department: 'dept.neurology', departments: p.departments!, season: 'winter', primary });
  let seed = 4800;
  while (!fits(make(seed))) seed++;
  p.patient = make(seed);
  for (let i = 0; i < 600 && p.status === 'coming'; i++) apply(db, s, { kind: 'advance', seconds: 60 });
  apply(db, s, { kind: 'sort', id: p.id, triage: p.scale!.triage });
  apply(db, s, { kind: 'call', id: p.id });
  for (const exam of exams) apply(db, s, { kind: 'exam', exam });
  for (let i = 0; i < 20 && p.pending.length > 0; i++) apply(db, s, { kind: 'waitResults' });
  const missing = exams.filter(e => !p.results.some(r => r.exam === e));
  if (missing.length > 0) throw new Error(`neuroSave: не пришло ${missing.join(', ')}`);
  return { save: JSON.stringify({ schemaVersion: SHIFT_SCHEMA_VERSION, savedAt: 'e2e', data: s }), id: p.id };
}

/** «Смена» в амбулатории, «Студент»: первым в очереди — стабильная стенокардия напряжения (часть 39г). */
function anginaSave(): { save: string; id: string } {
  const { db } = buildDb();
  const s = newShift(db, { seed: 46, season: 'winter', difficulty: 'student' });
  for (let i = 0; i < 600 && s.queue.length === 0; i++) apply(db, s, { kind: 'advance', seconds: 60 });
  const id = s.queue[0];
  for (let seed = 9500; ; seed++) {
    const x = generatePatient(db, seed, { department: 'dept.therapy', season: 'winter', primary: 'cond.angina_stable', params: { fc: 'i_ii' } });
    if (x.age >= 50 && x.truth.risks.length === 0 && x.truth.conditions.length === 1) {
      s.patients[id].patient = x;
      return { save: JSON.stringify({ schemaVersion: SHIFT_SCHEMA_VERSION, savedAt: 'e2e', data: s }), id };
    }
  }
}

/** Песочница до открытия: готовая амбулатория, бюджет «обычный» — экран «Перед открытием». */
/**
 * Карьера 2, у которой глава 1 выполнена к концу дня 3 (spec 2026-09-chapter-2, часть 34): переход
 * в районную больницу — без сорока приёмов. Итоги трёх дней, задания и письма — как их записала бы
 * игра; день закрыт.
 */
function chapterDoneSave(): string {
  const { db } = buildDb();
  const s = newCampaign(db, { seed: 8, season: 'winter', difficulty: 'student', career: 2 });
  const ch = db.chapters['chapter.district'];
  // по дню на основное задание: лаборатория, сорок приёмов, три дня без лишнего антибиотика
  const done: [string, string[]][] = [['lab', ['firstDay', 'labDone']], ['seen', ['seenDone']], ['antibiotics', ['antibioticsDone', 'end']]];
  s.day = 3;
  s.history = done.map(([mission, letters], i) => ({
    day: i + 1, arrived: 15, seen: 15, left: 0, unseen: 0, correct: 13, partly: 1, wrong: 1, grades: { A: 9, B: 4, C: 2, D: 0 }, money: 0, returnsPlanned: 0, returnsToday: 0,
    campaign: { done: [mission], letters },
  }));
  done.forEach(([mission, letters], i) => {
    s.campaign!.done[mission] = i + 1;
    s.campaign!.letters.push(...letters.map(id => ({ id, day: i + 1, read: true })));
  });
  s.summary = { ...s.history[2], grades: { ...s.history[2].grades } };
  s.campaign!.complete = 3;
  // подсказки главы 1 показаны в ней; подсказки главы 2 — впереди
  s.campaign!.tips = { shown: Object.values(db.tips).filter(t => !t.chapter).map(t => t.id) };
  if (!ch.missions.filter(m => m.main).every(m => s.campaign!.done[m.id])) throw new Error('глава 1: не все основные задания в сохранении');
  return JSON.stringify({ schemaVersion: SHIFT_SCHEMA_VERSION, savedAt: '2026-09-30T00:00:00.000Z', data: s });
}

function sandboxFreshSave(): string {
  const { db } = buildDb();
  const s = newSandbox(db, { seed: 5, season: 'winter', difficulty: 'student', start: 'clinic', budget: db.economy.sandbox.budgets.normal });
  return JSON.stringify({ schemaVersion: SHIFT_SCHEMA_VERSION, savedAt: 'e2e', data: s });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 });
const errors: string[] = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

try {
  // оговорка первого запуска — отдельным экраном, до меню; закрыли — больше её нет
  await page.goto(base);
  await page.getByTestId('accept-disclaimer').waitFor({ timeout: 30_000 });
  await page.screenshot({ path: join(OUT, '01-disclaimer.png') });
  check((await page.getByTestId('menu-quick').count()) === 0, 'первый запуск: оговорка — до меню');
  await page.getByTestId('accept-disclaimer').click();
  // потом — имя и пол врача: имя уже подставлено, пол меняет подсказанное имя
  await page.getByTestId('doctor-first').waitFor({ timeout: 5000 });
  const suggested = await page.getByTestId('doctor-first').inputValue();
  const other = (await page.getByTestId('doctor-sex-f').getAttribute('aria-selected')) === 'true' ? 'm' : 'f';
  await page.getByTestId(`doctor-sex-${other}`).click();
  const resuggested = await page.getByTestId('doctor-last').inputValue();
  check(suggested.length > 0 && resuggested.length > 0, `первый запуск: имя врача подставлено — ${suggested}, после смены пола — ${await page.getByTestId('doctor-first').inputValue()} ${resuggested}`);
  await page.getByTestId('doctor-sex-f').click();
  await page.getByTestId('doctor-first').fill('Анна');
  await page.getByTestId('doctor-last').fill('Петрова');
  await page.getByTestId('doctor-portrait-2').click();
  check((await page.getByTestId('doctor-portrait-2').getAttribute('aria-checked')) === 'true', 'первый запуск: портрет врача выбран — третий из шести');
  await page.screenshot({ path: join(OUT, '01-doctor.png') });
  await page.getByTestId('doctor-submit').click();
  await page.getByTestId('menu-settings').waitFor({ timeout: 5000 });
  check((await text(page, 'menu-profile')).includes('Анна Петрова'), `меню: профиль — «${(await text(page, 'menu-profile')).replace(/\n/g, ' · ')}»`);
  await page.screenshot({ path: join(OUT, '01-menu.png') });
  check(!(await page.getByTestId('menu-campaign').isDisabled()) && await page.getByTestId('menu-quick').isVisible(), 'меню: кампания, быстрая игра, энциклопедия, профиль, настройки');
  await page.goto(base);
  await page.getByTestId('menu-quick').waitFor({ timeout: 30_000 });
  check((await page.getByTestId('accept-disclaimer').count()) === 0, 'оговорка — только при первом запуске');

  // настройки сохраняются; «Об игре» — версия, оговорка, почта, источники базы
  await page.getByTestId('menu-settings').click();
  await page.getByTestId('settings-vibration').waitFor({ timeout: 5000 });
  const vibration = () => page.getByTestId('settings-vibration').getAttribute('aria-checked');
  const quiet = () => page.getByTestId('sound-1').getAttribute('aria-selected');
  check((await vibration()) === 'true' && (await page.getByTestId('sound-3').getAttribute('aria-selected')) === 'true', 'настройки: по умолчанию вибрация включена, звук громкий');
  check((await page.getByTestId('settings-ambience').getAttribute('aria-checked')) === 'true', 'настройки: фон амбулатории по умолчанию включён');
  // «мягкий режим» (spec 2026-09-chapter-2, часть 28б): по умолчанию выключен
  check((await page.getByTestId('settings-soft').getAttribute('aria-checked')) === 'false' && (await text(page, 'settings-soft')).includes('перевод в областную больницу'),
    `настройки: мягкий режим — выключен, ${(await text(page, 'settings-soft')).replace(/\n/g, ' · ')}`);
  // больные (spec 2026-10-variety): по умолчанию — «Реализм», выбор остаётся после перезапуска
  check((await page.getByTestId('patients-real').getAttribute('aria-checked')) === 'true' && (await text(page, 'patients-varied')).includes('редкие болезни чаще'),
    `настройки: больные — «Реализм»; ${(await text(page, 'patients-varied')).replace(/\n/g, ' · ')}`);
  await page.getByTestId('settings-vibration').click();
  await page.getByTestId('sound-1').click();
  await page.getByTestId('patients-varied').click();
  await page.screenshot({ path: join(OUT, '10-settings.png'), fullPage: true });
  await page.goto(`${base}/settings`);
  await page.getByTestId('settings-vibration').waitFor({ timeout: 10_000 });
  check((await vibration()) === 'false' && (await quiet()) === 'true', 'настройки: вибрация и громкость — те же после перезапуска');
  // «Разнообразие» — тоже; дальше сценарий — на частотах жизни
  check((await page.getByTestId('patients-varied').getAttribute('aria-checked')) === 'true', 'настройки: «Разнообразие» — то же после перезапуска');
  await page.getByTestId('patients-real').click();
  await page.getByTestId('settings-vibration').click();
  await page.getByTestId('sound-3').click();
  // размер текста: «Крупный» — шрифт в 1,3 раза больше; вернуть «Обычный»
  const fontOf = () => page.getByTestId('settings-about').locator('div[dir="auto"]').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  const normal = await fontOf();
  await page.getByTestId('text-size-2').click();
  const large = await fontOf();
  check(Math.abs(large / normal - 1.3) < 0.02, `настройки: размер текста «Крупный» — ${normal} → ${large} px`);
  await page.getByTestId('text-size-0').click();
  // тема (spec 2026-09-own-look): по умолчанию — как в телефоне, у сценария телефон светлый;
  // «Тёмная» меняет вид сразу, без перезапуска, и остаётся после перезапуска
  const sheetBg = () => page.getByTestId('settings-about').evaluate(el => getComputedStyle(el).backgroundColor);
  const LIGHT_CARD = 'rgb(255, 253, 248)';
  const DARK_CARD = 'rgb(21, 38, 42)';
  check((await page.getByTestId('theme-system').getAttribute('aria-checked')) === 'true' && (await sheetBg()) === LIGHT_CARD, `настройки: тема как в телефоне — светлая «Медкарта» (${await sheetBg()})`);
  await page.getByTestId('theme-dark').click();
  check((await sheetBg()) === DARK_CARD, `настройки: «Тёмная» — сразу тёмный «Монитор» (${await sheetBg()})`);
  await page.screenshot({ path: join(OUT, '10-settings-dark.png') });
  await page.goto(`${base}/settings`);
  await page.getByTestId('settings-about').waitFor({ timeout: 10_000 });
  check((await page.getByTestId('theme-dark').getAttribute('aria-checked')) === 'true' && (await sheetBg()) === DARK_CARD, 'настройки: тёмная тема — та же после перезапуска');
  await page.getByTestId('theme-system').click();
  check((await sheetBg()) === LIGHT_CARD, 'настройки: снова как в телефоне — светлая');
  {
    // телефон в тёмной теме — «как в телефоне» даёт тёмную без выбора в настройках
    const dark = await browser.newPage({ viewport: { width: 412, height: 915 }, colorScheme: 'dark' });
    await dark.goto(`${base}/settings`);
    await dark.getByTestId('settings-about').waitFor({ timeout: 30_000 });
    const bg = await dark.getByTestId('settings-about').evaluate(el => getComputedStyle(el).backgroundColor);
    check(bg === DARK_CARD && (await dark.getByTestId('theme-system').getAttribute('aria-checked')) === 'true', `настройки: тёмный телефон — «Монитор» по умолчанию (${bg})`);
    await dark.close();
  }
  // отчёт об ошибке: весь текст виден, описание — первой строкой
  await page.getByTestId('settings-report').click();
  await page.getByTestId('report-text').waitFor({ timeout: 5000 });
  await page.getByTestId('report-description').fill('Проверка отчёта');
  const report = await text(page, 'report-text');
  check(report.startsWith('Проверка отчёта') && report.includes(`сборка ${JSON.parse(readFileSync(join(ROOT, 'app.json'), 'utf8')).expo.android.versionCode}`) && report.includes('Практики нет'), `отчёт об ошибке: «${report.split('\n').slice(0, 5).join(' · ')}»`);
  await page.goto(`${base}/settings`);
  await page.getByTestId('settings-about').waitFor({ timeout: 10_000 });
  await page.getByTestId('settings-about').click();
  await page.getByTestId('about-version').waitFor({ timeout: 5000 });
  const version = JSON.parse(readFileSync(join(ROOT, 'app.json'), 'utf8')).expo.version;
  check((await text(page, 'about-version')).includes(version), `«Об игре»: версия ${version}`);
  check((await text(page, 'about-disclaimer')).includes('112') && (await text(page, 'about-write')).includes('support@gornitsa.games'), '«Об игре»: полная оговорка, почта разработчика');
  await page.screenshot({ path: join(OUT, '10-about.png'), fullPage: true });
  await page.getByTestId('about-sources').click();
  await page.getByTestId('source').first().waitFor({ timeout: 5000 });
  const sources = await page.getByTestId('source').count();
  check(sources > 50, `«Об игре»: источники медицинской базы — ${sources}`);

  // энциклопедия: оговорка вверху; раздел → статья → ссылка в статью обследования; поиск
  await page.goto(base);
  await page.getByTestId('menu-encyclopedia').click();
  await page.getByTestId('enc-section-conditions').waitFor({ timeout: 10_000 });
  check(await page.getByTestId('enc-disclaimer').isVisible(), 'энциклопедия: оговорка вверху раздела');
  await page.screenshot({ path: join(OUT, '11-encyclopedia.png') });
  await page.getByTestId('enc-section-conditions').click();
  await visible(page, 'enc-item-cond.pneumonia_cap').click();
  await visible(page, 'enc-article-title').waitFor({ timeout: 5000 });
  const blocks = await visible(page, 'enc-block-signs').count() + await visible(page, 'enc-block-confirm').count()
    + await visible(page, 'enc-block-similar').count() + await visible(page, 'enc-block-treatment').count() + await visible(page, 'enc-block-sources').count();
  check((await visibleText(page, 'enc-article-title')) === 'Внебольничная пневмония' && blocks === 5, 'энциклопедия: статья болезни — признаки, как подтвердить, с чем спутать, лечение, источники');
  await page.screenshot({ path: join(OUT, '11-article.png'), fullPage: true });
  await visible(page, 'enc-link-exam.xray_chest').first().click();
  await visible(page, 'enc-block-confirms').waitFor({ timeout: 5000 });
  check((await visibleText(page, 'enc-article-title')) === 'Рентгенография органов грудной клетки' && (await visible(page, 'enc-link-cond.pneumonia_cap').count()) > 0,
    'энциклопедия: ссылка ведёт в статью обследования, а оттуда — обратно к болезни');
  // больница: у обследования — где делают; у помещения — что здесь делают и что нужно
  await visible(page, 'enc-link-room.xray').first().click();
  await visible(page, 'enc-block-needs').waitFor({ timeout: 5000 });
  check((await visibleText(page, 'enc-article-title')) === 'Рентген-кабинет' && (await visible(page, 'enc-link-role.radiologist').count()) > 0
    && (await visible(page, 'enc-link-eq.xray_digital').count()) > 0, 'энциклопедия: из обследования — в помещение, где его делают: кто нужен и какие аппараты');
  await page.screenshot({ path: join(OUT, '11-room.png'), fullPage: true });
  await page.goto(`${base}/encyclopedia`);
  await page.getByTestId('enc-section-hospital').click();
  await visible(page, 'enc-item-eq.immuno_analyzer').waitFor({ timeout: 5000 });
  check((await visible(page, 'enc-item-room.lab').count()) > 0 && (await visible(page, 'enc-item-role.lab_tech').count()) > 0,
    'энциклопедия: раздел «Больница» — помещения, аппараты, должности');
  await page.goto(`${base}/encyclopedia`);
  await page.getByTestId('enc-section-tips').click();
  await visible(page, 'enc-item-tip.strep').click();
  await visible(page, 'enc-link-exam.strep_rapid').waitFor({ timeout: 5000 });
  check((await visibleText(page, 'enc-article-title')) === 'Горло и антибиотик', 'энциклопедия: раздел «Подсказки» — совет наставника со ссылкой на экспресс-тест');
  await page.goto(`${base}/encyclopedia`);
  await page.getByTestId('enc-search').fill('подъем сегмента');
  await page.getByTestId('enc-item-ecg.st_elevation').waitFor({ timeout: 5000 });
  check(await page.getByTestId('enc-item-ecg.st_elevation').isVisible(), 'энциклопедия: поиск — «подъем» находит «подъём»');

  // П3: движок в V8 даёт тот же отпечаток, что в Bun
  await page.goto(`${base}/spikes/engine`);
  await page.getByTestId('engine-run').click();
  await page.getByTestId('engine-hash').waitFor({ timeout: 60_000 });
  const hash = await text(page, 'engine-hash');
  check(hash === golden.hash, `П3: отпечаток тысячи пациентов в браузере (${hash}) совпадает с Bun (${golden.hash})`);
  await page.screenshot({ path: join(OUT, '02-engine.png') });

  // П2: карта рисуется и считает кадры
  await page.goto(`${base}/spikes/map`);
  await page.waitForTimeout(4000);
  const fps = await text(page, 'map-fps');
  check(/[1-9]\d*\u00a0кадр/.test(fps), `П2: карта рисуется — ${fps}`);
  await page.mouse.click(120, 420);
  await page.waitForTimeout(300);
  const picked = await text(page, 'map-picked');
  check(/клетка \d+, \d+/.test(picked), `П2: касание переводится в клетку — ${picked}`);
  await page.screenshot({ path: join(OUT, '03-map.png') });

  // П4: приём пациента
  await page.goto(`${base}/spikes/patient`);
  await page.getByTestId('exam-exam.ask_complaints').waitFor({ timeout: 30_000 });
  await page.screenshot({ path: join(OUT, '04-patient-start.png') });
  // «Что это?» у обследования и у жалобы
  await page.getByTestId('exam-exam.ask_complaints-info').click();
  await page.getByTestId('term-sheet').waitFor({ timeout: 5000 });
  // innerText учитывает text-transform: заголовки справки — прописными
  check((await page.getByTestId('term-sheet').innerText()).toLowerCase().includes('что проверяет'), 'П4: «Что это?» объясняет обследование');
  await page.waitForTimeout(600); // карточка выезжает снизу
  await page.screenshot({ path: join(OUT, '04-term.png') });
  // «Подробнее» — полная статья энциклопедии; «назад» — обратно в карту, справка закрыта
  const sheet = await page.getByTestId('term-sheet').innerText();
  await page.getByTestId('term-sheet-more').click();
  await visible(page, 'enc-article-title').waitFor({ timeout: 5000 });
  const termArticle = await visibleText(page, 'enc-article-title');
  check(sheet.includes(termArticle), `П4: «Подробнее» в «Что это?» — статья «${termArticle}»`);
  await page.goBack();
  await page.getByTestId('exam-exam.ask_complaints').waitFor({ timeout: 5000 });
  check((await page.getByTestId('term-sheet').count()) === 0, 'П4: из статьи «назад» — в карту пациента');
  await page.getByTestId('exam-exam.ask_complaints').click();
  // ответ — на месте вопроса, листать вверх к «Известно» не нужно (отзыв на 0.0.37)
  await page.getByTestId('done-exam.ask_complaints').waitFor({ timeout: 5000 });
  const asked = await text(page, 'done-exam.ask_complaints');
  check(asked.split('\n').length > 1 && (await page.getByTestId('exam-exam.ask_complaints').count()) === 0, `П4: ответ под вопросом — «${asked.replace(/\n/g, ' · ')}»`);
  await page.getByTestId('tab-examine').click();
  await page.getByTestId('exam-exam.lung_auscultation').click();
  await page.getByTestId('visit-fresh').first().waitFor({ timeout: 5000 });
  check(await page.getByTestId('visit-fresh').first().isVisible(), `П4: новые результаты выделены — ${await text(page, 'visit-fresh-count')}`);
  await page.getByTestId('visit-fresh').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, '04-fresh.png') });
  await page.getByTestId('exam-exam.vitals').click();
  await page.getByTestId('tab-order').click();
  await page.getByTestId('exam-exam.xray_chest').click();
  await page.getByTestId('exam-exam.cbc').click();
  const clockBefore = await text(page, 'visit-clock');
  for (let i = 0; i < 5 && (await page.getByTestId('visit-wait').count()) > 0; i++) await page.getByTestId('visit-wait').click();
  const clockAfter = await text(page, 'visit-clock');
  check(clockBefore !== clockAfter, `П4: ожидание результатов двигает часы (${clockBefore} → ${clockAfter})`);
  // снимок — рисунком в результатах, а не только строками (0.0.10)
  await page.getByTestId('result-xray').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  check((await page.getByTestId('result-xray').count()) === 1 && (await page.getByTestId('result-xray').isVisible()), 'П4: рентген в карте — снимком');
  await page.screenshot({ path: join(OUT, '04-xray.png') });
  // обзорный снимок живота стоя — тоже рисунком (0.0.49): кадр выше, чем шире
  await page.getByTestId('tab-order').click();
  await page.getByTestId('exam-exam.xray_abdomen').click();
  for (let i = 0; i < 5 && (await page.getByTestId('visit-wait').count()) > 0; i++) await page.getByTestId('visit-wait').click();
  await page.getByTestId('result-xray-abdomen').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const abdBox = await page.getByTestId('result-xray-abdomen').boundingBox();
  check((await page.getByTestId('result-xray-abdomen').count()) === 1 && abdBox !== null && abdBox.height > abdBox.width,
    `П4: обзорный снимок живота в карте — рисунком ${Math.round(abdBox?.width ?? 0)} × ${Math.round(abdBox?.height ?? 0)}`);
  await page.screenshot({ path: join(OUT, '04-xray-abdomen.png') });
  await page.screenshot({ path: join(OUT, '04-patient-exams.png'), fullPage: true });
  // решение — отдельный экран в два шага, а не четвёртая вкладка (отзыв на 0.0.5)
  check((await page.locator('[data-testid^="tab-"]').count()) === 3 && (await page.getByTestId('visit-decide').isVisible()), 'П4: три вкладки действий, «Решение» — отдельной кнопкой внизу');
  await page.getByTestId('visit-decide').click();
  await page.getByTestId('dx-cond.pneumonia_cap').waitFor({ timeout: 5000 });
  check(await page.getByTestId('decision-to-plan').isDisabled(), 'решение, шаг 1: без диагноза дальше не пройти');
  await page.getByTestId('dx-cond.pneumonia_cap').click();
  await page.screenshot({ path: join(OUT, '05-decision-diagnosis.png') });
  await page.getByTestId('decision-to-plan').click();
  await page.getByTestId('tx-tx.amoxicillin').waitFor({ timeout: 5000 });
  check((await text(page, 'decision-diagnosis')).includes('Внебольничная пневмония'), 'решение, шаг 2: выбранный диагноз виден над лечением');
  // тромболизис (часть 39а) — только лежащему под монитором: в кабинете кнопка серая, причина под названием
  check(await page.getByTestId('tx-tx.thrombolysis').isDisabled() && (await text(page, 'tx-tx.thrombolysis')).includes('У постели нет монитора с дефибриллятором'),
    'решение в кабинете: «Тромболизис при инфаркте» серый — у постели нет монитора с дефибриллятором');
  await page.getByTestId('tx-tx.amoxicillin').click();
  await page.getByTestId('setting-home').click();
  await page.screenshot({ path: join(OUT, '05-decision-plan.png') });
  await page.getByTestId('visit-finish').click();
  await page.getByTestId('visit-truth').waitFor({ timeout: 5000 });
  const truth = await text(page, 'visit-truth');
  check(truth.startsWith('На самом деле:'), `П4: разбор показывает правду — ${truth}`);
  const outcome = await text(page, 'visit-outcome');
  const overall = await text(page, 'visit-overall');
  check(outcome.length > 0 && /^[ABCD]$/.test(overall), `этап 2: исход и оценка случая — «${outcome}», итог ${overall}`);
  await page.screenshot({ path: join(OUT, '05-outcome.png') });
  // разбор → энциклопедия: статья о том, что было на самом деле; поставленное — тоже
  check(await page.getByTestId('visit-chosen-article').isVisible(), 'разбор: ошибся — есть статья и о поставленном диагнозе');
  await page.getByTestId('visit-truth-article').click();
  await visible(page, 'enc-article-title').waitFor({ timeout: 5000 });
  const truthArticle = await visibleText(page, 'enc-article-title');
  check(truth.includes(truthArticle), `разбор → энциклопедия: статья «${truthArticle}»`);
  await page.goBack();
  await page.getByTestId('visit-next').waitFor({ timeout: 5000 });
  await page.getByTestId('visit-next').click();
  await page.getByTestId('exam-exam.ask_complaints').waitFor({ timeout: 5000 });
  check((await page.getByTestId('tab-ask').getAttribute('aria-selected')) === 'true', 'П4: у следующего пациента открыта вкладка «Спросить»');

  // П5: снимки, ЭКГ, портреты; с 0.0.34 — срезы головы на КТ и МРТ (spec 2026-09-ct-mri-ultrasound)
  await page.goto(`${base}/spikes/imaging`);
  // нарисован ли холст: неподвижный рисунок в вебе копируется в 2D-холст (без своего контекста
  // WebGL) — посередине непрозрачный пиксель; холст, потерявший контекст, пуст
  const drawn = async (selector: string) => page.locator(selector).evaluateAll(els => els.map(el => {
    const c = el as HTMLCanvasElement;
    const d = c.getContext('2d')?.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    return d !== undefined && d[3] === 255;
  }));
  // рисунков на экране больше сорока, в вебе каждый рисует CanvasKit в главном потоке — снимок
  // экрана ждёт кадра, которого до конца рисования нет (с 0.2.0 снимков груди на семь больше, и
  // под нагрузкой на всё уходило за 30 с): сначала ждём, пока нарисованы все
  const allDrawn = async (ms: number) => {
    await page.waitForTimeout(2500);
    for (const until = Date.now() + ms; Date.now() < until;) {
      const all = await drawn('canvas');
      if (all.length > 0 && all.every(Boolean)) return;
      await page.waitForTimeout(500);
    }
  };
  await allDrawn(90_000);
  await page.screenshot({ path: join(OUT, '06-imaging.png'), fullPage: true });
  check(true, 'П5: экран снимков открылся (смотреть 06-imaging.png)');
  // с частью 41в — и кровь в бороздах, и большая гематома со смещением: срезов головы 9
  const heads = await drawn('[data-testid^="head-ct-"] canvas, [data-testid^="head-mri-"] canvas');
  const us = await drawn('[data-testid^="us-"] canvas');
  const abd = await drawn('[data-testid^="abd-"] canvas');
  // снимок груди при травме (часть 32в): воздух, кровь, переломы рёбер; с частью 43а — и расширенное средостение, с
  // частью 43в — застой и отёк лёгких
  const chest = await drawn('[data-testid^="chest-"] canvas');
  // срез груди на КТ-ангиографии (часть 43а): без расслоения, тип A и тип B; с частью 43б — тромбоэмболия
  const ctChest = await drawn('[data-testid^="cta-chest-"] canvas');
  const allImages = await drawn('canvas');
  check(heads.length === 9 && heads.every(Boolean) && us.length === 16 && us.every(Boolean) && abd.length === 3 && abd.every(Boolean) && chest.length === 10 && chest.every(Boolean)
    && ctChest.length === 5 && ctChest.every(Boolean) && allImages.every(Boolean),
    `П5: срезы головы нарисованы — ${heads.filter(Boolean).length} из 9, УЗИ — ${us.filter(Boolean).length} из 16 (с венами и артерией ног), снимки живота — ${abd.filter(Boolean).length} из 3, груди — ${chest.filter(Boolean).length} из 10, срезы груди на КТ — ${ctChest.filter(Boolean).length} из 5; все рисунки экрана — ${allImages.filter(Boolean).length} из ${allImages.length} (смотреть 06-head-*.png, 06-us.png, 06-abdomen.png, 06-chest.png, 06-cta-chest.png)`);
  // ЭКГ в двенадцати отведениях (spec 2026-10-chapter-3, часть 36): ритмы, проведение, стенки инфаркта
  const ecg = await drawn('[data-testid^="ecg-"] canvas');
  check(ecg.length === 20 && ecg.every(Boolean), `П5: листы ЭКГ в двенадцати отведениях нарисованы — ${ecg.filter(Boolean).length} из 20 (смотреть 06-ecg-*.png)`);
  for (const id of ['head-ct', 'head-mri', 'us', 'abdomen', 'chest', 'cta-chest']) {
    await page.getByTestId(id).scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.getByTestId(id).screenshot({ path: join(OUT, `06-${id}.png`) });
  }
  // карточка ЭКГ — 19 листов, выше окна отрисовки браузера: целиком снимок выходит пустым (0.3.1),
  // поэтому — по листу
  for (const id of ['ecg-inferior', 'ecg-af', 'ecg-avb3', 'ecg-lbbb']) {
    await page.getByTestId(id).scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.getByTestId(id).screenshot({ path: join(OUT, `06-${id}.png`) });
  }

  // П7: рентген костей кодом (spec 2026-09-chapter-2, часть 31): у каждого вида — норма и переломы
  await page.goto(`${base}/spikes/bones`);
  await allDrawn(60_000);
  const bones = await drawn('[data-testid^="bone-"] canvas');
  check(bones.length === 20 && bones.every(Boolean), `П7: рентген костей нарисован — ${bones.filter(Boolean).length} из 20 (смотреть 06-bones-*.png)`);
  for (const view of ['wrist', 'ankle', 'knee', 'foot', 'hip', 'clavicle', 'ribs']) {
    await page.getByTestId(`bones-${view}`).scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.getByTestId(`bones-${view}`).screenshot({ path: join(OUT, `06-bones-${view}.png`) });
  }

  // П6: сохранение с копией и откат
  await page.goto(`${base}/spikes/save`);
  await page.getByTestId('save-save').click();
  await page.waitForTimeout(500);
  await page.getByTestId('save-save').click();
  await page.waitForTimeout(500);
  const saved = await text(page, 'save-status');
  check(/Записано \d+\u00a0КБ/.test(saved), `П6: ${saved}`);
  await page.getByTestId('save-load').click();
  await page.waitForTimeout(300);
  check((await text(page, 'save-status')).includes('текущий файл'), 'П6: читается текущий файл');
  await page.getByTestId('save-corrupt').click();
  await page.waitForTimeout(500);
  check((await text(page, 'save-status')).includes('предыдущая копия'), 'П6: испорченный файл — читается предыдущая копия');
  await page.screenshot({ path: join(OUT, '07-save.png') });

  // Этап 2: смена — часы на карте, приём, «отпустить ждать результатов», итог, продолжение
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-shift').click();
  await page.getByTestId('shift-start').waitFor({ timeout: 15_000 });
  // сложность выбирают при начале практики; по умолчанию — «Студент» с подсказками
  check((await page.getByTestId('difficulty-student').getAttribute('aria-selected')) === 'true' && (await text(page, 'difficulty-text')).startsWith('Подсказки'), 'смена: сложность по умолчанию — «Студент»');
  await page.getByTestId('shift-start').click();
  // в очереди никого — «промотать до следующего» (отзыв на 0.0.7: ждали 40 секунд)
  const skipped = await skipToFirst(page);
  const opened = await text(page, 'shift-clock');
  check(/^\d\d:\d\d$/.test(opened) && (!skipped || opened > '08:00'), `смена: «промотать до следующего» — пришёл первый (${opened})`);
  await page.getByTestId('tab-x4').click();
  await page.waitForTimeout(1500);
  const ticking = await text(page, 'shift-clock');
  check(ticking > opened, `смена: часы идут, пока в кабинете никого (${opened} → ${ticking})`);
  // карта амбулатории над очередью: подпись для чтения с экрана — кто где
  const mapLabel = (await page.getByTestId('clinic-map').getAttribute('aria-label')) ?? '';
  check(await page.getByTestId('clinic-map').isVisible() && /В зале ожидания: [1-9]/.test(mapLabel), `смена: карта амбулатории — «${mapLabel}»`);
  // касание на карте — кто это: медсестра и зачем к ней идут
  const map = page.getByTestId('clinic-map');
  const cellPx = ((await map.boundingBox())?.width ?? 0) / CLINIC.grid.w;
  const tapCell = (c: readonly [number, number]) => map.click({ position: { x: (c[0] + 0.5) * cellPx, y: (c[1] + 0.5) * cellPx } });
  await tapCell(CLINIC.staff.find(x => x.role === 'nurse')!.cell);
  await page.getByTestId('map-who').waitFor({ timeout: 5_000 });
  const nurseWho = await text(page, 'map-who');
  check(nurseWho.includes('Медсестра доврачебного кабинета') && nurseWho.includes('давление'), `смена: касание на карте — «${nurseWho.replace(/\n/g, ' · ')}»`);
  // первые пришедшие доходят до стойки, до медсестры и садятся в зале — тогда их и касаемся;
  // на какой стул сел первый, зависит от зерна смены: перебираем стулья по кругу
  let seatedWho = '';
  for (let i = 0; i < 120 && !seatedWho.includes('Ждёт приёма'); i++) {
    // пришёл срочный — смена на автопаузе (зерно смены — от времени запуска): дальше на ×4,
    // иначе остальные так и стоят у стойки и медсестры
    if ((await page.getByTestId('tab-x4').getAttribute('aria-selected')) !== 'true') await page.getByTestId('tab-x4').click();
    await tapCell(CLINIC.seats[i % CLINIC.seats.length]);
    await page.waitForTimeout(200);
    seatedWho = (await page.getByTestId('map-who').count()) > 0 ? await text(page, 'map-who') : '';
  }
  check(seatedWho.includes('Ждёт приёма') && (await page.getByTestId('map-invite').isVisible()), `смена: коснулись ждущего в зале — «${seatedWho.replace(/\n/g, ' · ')}»`);
  // значок у вашего кабинета — сколько ждут вас (spec 2026-09-living-map, часть 23)
  const officeSign = (await page.getByTestId(`sign-${CLINIC.mine}`).getAttribute('aria-label')) ?? '';
  check(/^Ждут: [1-9]\d*$/.test(officeSign), `смена: значок очереди у кабинета — «${officeSign}»`);
  await page.screenshot({ path: join(OUT, '08-shift-queue.png') });
  // «Пригласить» — он идёт в кабинет, карта пациента открывается, когда вошёл
  const invited = Date.now();
  await page.getByTestId('map-invite').click();
  await page.getByTestId('exam-exam.ask_complaints').waitFor({ timeout: 10_000 });
  const walked = Date.now() - invited;
  check(walked > 800, `смена: приглашённый дошёл до кабинета — карта пациента через ${walked} мс`);
  const likely = page.locator('[data-testid^="likely-"]');
  check((await likely.count()) > 0 && (await likely.first().innerText()).includes('из 10 похожих пациентов'), `смена: «Студент» — «Похоже на»: ${(await likely.first().innerText()).trim()}`);
  const roomClock = await text(page, 'visit-clock');
  await page.waitForTimeout(1500);
  check((await text(page, 'visit-clock')) === roomClock, 'смена: в кабинете часы идут только делами');
  await page.getByTestId('exam-exam.ask_complaints').click();
  await page.getByTestId('tab-order').click();
  // кабинета УЗИ в амбулатории нет (часть 29): обследование серым, с причиной
  const usHere = page.getByTestId('exam-exam.us_abdomen');
  check(await usHere.isDisabled() && (await usHere.innerText()).includes('нет кабинета УЗИ'), `смена: УЗИ в амбулатории — «${(await usHere.innerText()).replace(/\n/g, ' · ')}»`);
  await page.getByTestId('exam-exam.cbc').click();
  await page.screenshot({ path: join(OUT, '08-shift-card.png') });
  await page.getByTestId('visit-send-away').click();
  await page.getByTestId('shift-clock').waitFor({ timeout: 10_000 });
  check((await page.locator('[data-testid^="away-"]').count()) === 1, 'смена: отпущенный ждать результатов — «на обследованиях»');
  const back = page.locator('[data-testid^="queue-"]').filter({ hasText: 'с результатами' });
  check(await runClockUntil(page, async () => (await back.count()) > 0), 'смена: результаты готовы — пациент снова в очереди');
  await back.first().click();
  await page.getByTestId('visit-fresh').first().waitFor({ timeout: 10_000 });
  check(await page.getByTestId('visit-fresh').first().isVisible(), 'смена: пришедшее без врача — «новое» при вызове');
  await page.getByTestId('visit-decide').click();
  // в амбулатории хирургии нет (часть 30): среди диагнозов — ни холецистита, ни панкреатита
  const surgicalHere = await page.locator('[data-testid="dx-cond.cholecystitis"], [data-testid="dx-cond.pancreatitis"], [data-testid="dx-cond.biliary_colic"]').count();
  check(surgicalHere === 0 && (await page.getByTestId('dx-cond.appendicitis').count()) === 1, `смена: в амбулатории хирургических диагнозов нет (${surgicalHere}), аппендицит — есть`);
  await page.locator('[data-testid^="hint-"]').first().click();
  await page.getByTestId('decision-to-plan').click();
  await page.getByTestId('setting-home').click();
  await page.getByTestId('visit-finish').click();
  await page.getByTestId('visit-truth').waitFor({ timeout: 10_000 });
  check((await text(page, 'visit-outcome')).includes('итогах следующих дней'), 'смена: исход «домой» — в итогах следующих дней');
  const gotNow = (await text(page, 'visit-achievements')).split('\n');
  check(gotNow.includes('Достижение: «Первый пациент»'), `смена: первый приём — на итоге ${gotNow.join(' · ')}`);
  await page.screenshot({ path: join(OUT, '08-shift-outcome.png') });
  await page.getByTestId('shift-to-queue').click();
  await page.getByTestId('shift-counts').waitFor({ timeout: 10_000 });
  check((await text(page, 'shift-counts')).startsWith('Принято: 1'), `смена: приём засчитан — ${await text(page, 'shift-counts')}`);
  await page.goto(base);
  await page.getByTestId('menu-continue').waitFor({ timeout: 10_000 });
  const hint = await text(page, 'menu-continue');
  check(hint.includes('день 1'), `смена: сохранена, в меню — «Продолжить: ${hint.split('\n').pop()}»`);
  // профиль: приём — в практике и в архиве; из архива — тот же разбор; в энциклопедии — «встречалось»
  await page.getByTestId('menu-profile').click();
  await page.getByTestId('profile-name').waitFor({ timeout: 5000 });
  const cases = await text(page, 'profile-line-0');
  const archived = page.locator('[data-testid^="archive-"]');
  check((await text(page, 'profile-name')) === 'Анна Петрова' && cases === 'Принято: 1' && (await archived.count()) === 1, `профиль: «${cases}», в архиве — ${await archived.count()}`);
  const profileLines = await page.locator('[data-testid^="profile-line-"]').allInnerTexts();
  check((await text(page, 'profile-rank')) === 'Интерн' && profileLines.some(l => /^В среднем на приём — \d+\s?мин$/.test(l.trim())),
    `профиль: звание «${await text(page, 'profile-rank')}», ${profileLines.find(l => l.startsWith('В среднем')) ?? 'нет строки о минутах'}`);
  await page.screenshot({ path: join(OUT, '09-profile.png') });
  await archived.first().click();
  await page.getByTestId('visit-truth').waitFor({ timeout: 10_000 });
  check(await page.getByTestId('visit-truth').isVisible(), `профиль: приём из архива — ${await text(page, 'visit-truth')}`);
  await page.getByTestId('visit-truth-article').click();
  await visible(page, 'enc-practice').waitFor({ timeout: 10_000 });
  const practice = await visibleText(page, 'enc-practice');
  check(practice.startsWith('Встречалось в вашей практике: 1'), `энциклопедия: «${practice}»`);
  // достижения: у полученного — дата, у остальных — что нужно сделать
  await page.goto(`${base}/profile`);
  await page.getByTestId('profile-achievements').click();
  await page.getByTestId('achievements-count').waitFor({ timeout: 5000 });
  check((await text(page, 'achievement-ach.first_patient')).includes('Получено ') && (await text(page, 'achievement-ach.run_5')).includes('Поставить пять верных'),
    `профиль: достижения — ${await text(page, 'achievements-count')}, «Первый пациент» получено`);
  await page.screenshot({ path: join(OUT, '09-achievements.png'), fullPage: true });
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-shift').waitFor({ timeout: 10_000 });
  // начать заново — только после вопроса: сохранение одно
  await page.getByTestId('menu-shift').click();
  await page.getByTestId('restart-sheet').waitFor({ timeout: 5000 });
  await page.getByTestId('restart-sheet-close').click();
  await page.getByTestId('restart-sheet').waitFor({ state: 'detached', timeout: 5000 });
  check((await text(page, 'menu-shift')).includes('продолжить или начать заново'), 'быстрая игра: «Отмена» — практика на месте');
  await page.getByTestId('menu-shift').click();
  await page.getByTestId('restart-confirm').click();
  await page.getByTestId('shift-clock').waitFor({ timeout: 10_000 });
  check((await text(page, 'shift-clock')) === '08:00' && (await text(page, 'shift-counts')).startsWith('Принято: 0'), 'меню: «Начать заново» — день 1, 08:00');

  // песочница: пустой участок → регистратура (призрак тянут пальцем) → коридор кистью → отмена
  // и снова → карточка помещения → «Готово»; в меню «Продолжить» — песочница
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-sandbox').click();
  await page.getByTestId('sandbox-start').waitFor({ timeout: 10_000 });
  await page.getByTestId('sandbox-budget-generous').click();
  check((await text(page, 'sandbox-cash')) === 'Касса: 2\u00a0500\u00a0000\u00a0₽', `песочница: щедрый бюджет — ${await text(page, 'sandbox-cash')}`);
  await page.getByTestId('sandbox-budget-normal').click();
  await page.getByTestId('sandbox-start').click();
  await page.getByTestId('sandbox-build').waitFor({ timeout: 10_000 });
  check((await text(page, 'sandbox-open-needs')).includes('Регистратура, Зона ожидания, Кабинет врача'), `песочница: перед открытием — ${await text(page, 'sandbox-open-needs')}`);
  await page.getByTestId('sandbox-build').click();
  await page.getByTestId('build-map').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  const [plotW, plotH] = sandboxPlot;
  // где на экране клетка: масштаб — «весь участок на экране»; сдвиг — по подписи построенного
  // помещения (панель снизу меняет высоту карты, а камера стоит), пока его нет — участок по центру
  let anchor: { id: string; x: number; y: number } | undefined;
  const cellPoint = async (x: number, y: number) => {
    const box = (await page.getByTestId('build-map').boundingBox())!;
    const z = Math.min(box.width / (plotW * 16), box.height / (plotH * 16));
    const c = 16 * z;
    const label = anchor ? await page.getByTestId('build-map').getByTestId(`label-${anchor.id}`).boundingBox() : null;
    if (anchor && label) return { x: label.x + (x - anchor.x - 1 + 0.5) * c, y: label.y + (y - anchor.y - 1 + 0.5) * c };
    return { x: box.x + (box.width - plotW * c) / 2 + (x + 0.5) * c, y: box.y + (box.height - plotH * c) / 2 + (y + 0.5) * c };
  };
  const drag = async (cells: [number, number][]) => {
    const a = await cellPoint(...cells[0]);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    for (const c of cells.slice(1)) {
      const b = await cellPoint(...c);
      await page.mouse.move(b.x, b.y, { steps: 14 });
    }
    // палец задерживается на месте: последнее движение успевает дойти до жеста раньше, чем его отпустили
    await page.waitForTimeout(150);
    await page.mouse.up();
    await page.waitForTimeout(400);
  };
  const cash0 = await text(page, 'build-cash');
  await page.getByTestId('build-tool-room').click();
  // кабинет КТ (часть 40) — в списке помещений песочницы, с ценой
  const ctType = await text(page, 'room-type-room.ct');
  check(ctType.startsWith('Кабинет КТ') && ctType.includes('70 000 ₽'), `песочница: в списке помещений — «${ctType.replace(/\n/g, ' · ').slice(0, 120)}»`);
  await page.getByTestId('room-type-room.reception').click();
  await page.getByTestId('build-place').waitFor({ timeout: 5000 });
  // призрак — посреди участка (17, 10); тянем на пять клеток влево
  await drag([[19, 13], [14, 13]]);
  await page.screenshot({ path: join(OUT, '12-build-ghost.png') });
  await page.getByTestId('build-place').click();
  await page.getByTestId('build-tool-corridor').waitFor({ timeout: 5000 });
  anchor = { id: 'r1', x: 12, y: 10 };
  const cash1 = await text(page, 'build-cash');
  check(cash1 !== cash0 && (await page.getByTestId('build-undo').innerText()).includes('(1)'), `стройка: регистратура построена — ${cash0} → ${cash1}`);
  await page.getByTestId('build-tool-corridor').click();
  const corridor: [number, number][] = [[4, 13], [4, 17], [34, 17]];
  await drag(corridor);
  const cash2 = await text(page, 'build-cash');
  check(cash2 !== cash1 && (await page.getByTestId('build-undo').innerText()).includes('(2)'), `стройка: коридор кистью — ${cash1} → ${cash2}`);
  await page.getByTestId('build-undo').click();
  check((await text(page, 'build-cash')) === cash1, 'стройка: «Отменить» — коридора нет, деньги вернулись полностью');
  await drag(corridor);
  await page.getByTestId('build-tool-done').click();
  await page.screenshot({ path: join(OUT, '12-build.png') });
  const reception = await cellPoint(14, 12);
  await page.mouse.click(reception.x, reception.y);
  await page.getByTestId('room-status').waitFor({ timeout: 5000 });
  check((await text(page, 'room-status')) === 'Не работает: нет регистратора', `стройка: карточка регистратуры — ${await text(page, 'room-status')}`);
  await page.getByTestId('room-card-close').click();
  await page.getByTestId('build-done').click();
  await page.getByTestId('sandbox-open-needs').waitFor({ timeout: 5000 });
  check((await text(page, 'sandbox-open-needs')).includes('Регистратура: нет регистратора, Зона ожидания, Кабинет врача'),
    `песочница: регистратура есть, регистратора нет — ${await text(page, 'sandbox-open-needs')}`);
  // персонал: кандидат-регистратор → нанять → назначить в регистратуру
  await page.getByTestId('sandbox-staff').click();
  await page.locator('[data-testid^="candidate-"]').first().waitFor({ timeout: 5000 });
  const registrar = page.locator('[data-testid^="candidate-"]', { hasText: 'Регистратор' }).first();
  await registrar.click();
  await page.getByTestId('assign-r1').click();
  const hiredText = await page.locator('[data-testid^="staff-s"]').first().innerText();
  check(hiredText.includes('работает: регистратура'), `персонал: нанят и назначен — ${hiredText.replace(/\n/g, ' · ')}`);
  await page.goBack();
  await page.getByTestId('sandbox-open-needs').waitFor({ timeout: 5000 });
  check(!(await text(page, 'sandbox-open-needs')).includes('Регистратура') && await page.getByTestId('sandbox-open').isDisabled(), 'песочница: регистратор на месте, но без зоны ожидания и кабинета смену не открыть');
  // зона ожидания и кабинет врача вдоль коридора — смену можно открыть; принять пациента,
  // дожить до конца дня и закрыть его — в итогах касса (spec 2026-09-own-hospital, приёмка 5)
  await page.getByTestId('sandbox-build').click();
  await page.getByTestId('build-map').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  // где призрак — из подписи карты для чтения с экрана: «…: клетка 16, 10 — здесь нельзя»
  const ghostAt = async () => {
    const m = /клетка (\d+), (\d+)/.exec((await page.getByTestId('build-map').getAttribute('aria-label')) ?? '');
    return m ? [Number(m[1]), Number(m[2])] as [number, number] : undefined;
  };
  // тянем призрак за клетку внутри него, пока он не встанет куда нужно (жест в вебе может
  // отстать на клетку — тогда ещё раз с того места, где он оказался)
  const placeRoom = async (type: string, size: string, target: [number, number]) => {
    await page.getByTestId('build-tool-room').click();
    await page.getByTestId(`room-type-${type}`).click();
    const sized = page.getByTestId(`room-size-${size}`);
    if ((await sized.count()) > 0) await sized.click();
    await page.getByTestId('build-place').waitFor({ timeout: 5000 });
    for (let i = 0; i < 4; i++) {
      const at = await ghostAt();
      if (!at || (at[0] === target[0] && at[1] === target[1])) break;
      const grip: [number, number] = [at[0] + 2, at[1] + 2];
      await drag([grip, [grip[0] + target[0] - at[0], grip[1] + target[1] - at[1]]]);
    }
    check(JSON.stringify(await ghostAt()) === JSON.stringify(target), `стройка: ${type} — призрак в клетке ${target.join(', ')}`);
    await page.getByTestId('build-place').click();
    await page.getByTestId('build-tool-corridor').waitFor({ timeout: 5000 });
  };
  // над коридором, правее регистратуры: зона ожидания M и кабинет врача
  await placeRoom('room.waiting', 'M', [18, 10]);
  await placeRoom('room.office', 'M', [27, 10]);
  await page.getByTestId('build-done').click();
  await page.getByTestId('sandbox-open').waitFor({ timeout: 5000 });
  check(!(await page.getByTestId('sandbox-open').isDisabled()), 'песочница: регистратура, зона ожидания и кабинет у коридора, регистратор на месте — смену можно открыть');
  await page.getByTestId('sandbox-open').click();
  await skipToFirst(page);
  await page.getByTestId('shift-call').click();
  await page.getByTestId('exam-exam.ask_complaints').waitFor({ timeout: 10_000 });
  await page.getByTestId('exam-exam.ask_complaints').click();
  await page.getByTestId('visit-decide').click();
  await page.locator('[data-testid^="hint-"]').first().click();
  await page.getByTestId('decision-to-plan').click();
  await page.getByTestId('setting-home').click();
  await page.getByTestId('visit-finish').click();
  await page.getByTestId('visit-payment').waitFor({ timeout: 10_000 });
  await page.getByTestId('shift-to-queue').click();
  await page.getByTestId('tab-x4').click();
  const closable = page.locator('[data-testid="shift-close-day-early"], [data-testid="shift-close-day"]');
  check(await runClockUntil(page, async () => (await closable.count()) > 0, 180_000), 'песочница: смена дожита до конца дня');
  await closable.first().click();
  await page.getByTestId('summary-cash').waitFor({ timeout: 10_000 });
  check((await text(page, 'summary-seen')).startsWith('Принято: 1 из'), `песочница с пустого участка, итоги дня: ${await text(page, 'summary-seen')}`);
  check((await text(page, 'cash-now')).startsWith('В кассе: ') && (await page.getByTestId('cash-oms').count()) + (await page.getByTestId('cash-dms').count()) + (await page.getByTestId('cash-self').count()) === 1,
    `песочница с пустого участка, касса: ${await text(page, 'cash-now')}`);
  await page.goto(base);
  await page.getByTestId('menu-continue').waitFor({ timeout: 10_000 });
  check((await text(page, 'menu-continue')).includes('песочница: день 1'), `меню: «Продолжить» — последняя партия: ${(await text(page, 'menu-continue')).replace(/\n/g, ' · ')}`);

  // песочница заново — с готовой амбулаторией: штат на местах; продали иммунохимический
  // анализатор — ТТГ в карте пациента серым с причиной; «Открыть смену» — день 1 на своём плане
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-sandbox').click();
  await page.getByTestId('restart-confirm').click();
  await page.getByTestId('sandbox-from-clinic').click();
  await page.getByTestId('sandbox-start').click();
  await page.getByTestId('sandbox-build').waitFor({ timeout: 10_000 });
  await page.getByTestId('sandbox-build').click();
  await page.getByTestId('build-map').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  anchor = undefined; // другая песочница: участок снова по центру
  const lab = await cellPoint(25, 3);
  await page.mouse.click(lab.x, lab.y);
  await page.getByTestId('room-sell-3').click();
  await page.getByTestId('room-card-close').click();
  await page.getByTestId('build-done').click();
  await page.getByTestId('sandbox-open').waitFor({ timeout: 5000 });
  await page.getByTestId('sandbox-open').click();
  await skipToFirst(page);
  check(await page.getByTestId('clinic-map').isVisible(), 'песочница: смена открыта — карта своей больницы');
  // касание помещения мимо людей — что это, работает ли, кто в нём (план тот же, что в практике)
  const ownMap = page.getByTestId('clinic-map');
  const ownCell = ((await ownMap.boundingBox())?.width ?? 0) / CLINIC.grid.w;
  const labRoom = CLINIC.rooms.find(r => r.type === 'lab')!;
  const tech = CLINIC.staff.find(x => x.role === 'labTech')!.cell;
  const far: [number, number] = [tech[0] - labRoom.x < labRoom.w / 2 ? labRoom.x + labRoom.w - 2 : labRoom.x + 1, tech[1] - labRoom.y < labRoom.h / 2 ? labRoom.y + labRoom.h - 2 : labRoom.y + 1];
  await ownMap.click({ position: { x: (far[0] + 0.5) * ownCell, y: (far[1] + 0.5) * ownCell } });
  await page.getByTestId('map-room').waitFor({ timeout: 5_000 });
  const labText = await text(page, 'map-room');
  check(labText.startsWith('Лаборатория') && labText.includes('Работает') && labText.includes('Лаборант: '), `песочница: касание помещения — «${labText.replace(/\n/g, ' · ')}»`);
  await page.screenshot({ path: join(OUT, '13-sandbox-room.png') });
  await page.getByTestId('shift-call').click();
  await page.getByTestId('exam-exam.ask_complaints').waitFor({ timeout: 10_000 });
  await page.getByTestId('tab-order').click();
  const tsh = page.getByTestId('exam-exam.tsh');
  await tsh.waitFor({ timeout: 5000 });
  check(await tsh.isDisabled() && (await tsh.innerText()).includes('нет иммунохимического анализатора'), `песочница: ТТГ — «${(await tsh.innerText()).replace(/\n/g, ' · ')}»`);
  check(!(await page.getByTestId('exam-exam.cbc').isDisabled()), 'песочница: общий анализ крови — можно');
  await page.screenshot({ path: join(OUT, '13-sandbox-card.png') });
  check(/^(ОМС|ДМС|Платно): /.test(await visibleText(page, 'visit-payer')), `песочница: кто платит — ${await visibleText(page, 'visit-payer')}`);

  // конец дня в песочнице из сохранения: итоги — касса по плательщикам и статьям, репутация;
  // у приёма — оплата после экспертизы
  // сначала — в меню: живой партии в памяти нет, её сохранение уже на диске; потом подменить его
  await page.goto(base);
  await page.getByTestId('menu-quick').waitFor({ timeout: 10_000 });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/sandbox.json', sandboxEndOfDaySave()]);
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-sandbox').click();
  await page.getByTestId('restart-continue').click();
  await page.getByTestId('shift-close-day').waitFor({ timeout: 15_000 });
  await page.getByTestId('shift-close-day').click();
  await page.getByTestId('summary-cash').waitFor({ timeout: 10_000 });
  check((await text(page, 'cash-now')).startsWith('В кассе: '), `песочница, итоги дня: ${await text(page, 'cash-now')}`);
  check(/^Итог дня: [+−]?\d/.test(await text(page, 'cash-net')), `песочница, итоги дня: ${await text(page, 'cash-net')}`);
  check(/^Репутация: \d+ → \d+$/.test(await text(page, 'rep-line')), `песочница, итоги дня: ${await text(page, 'rep-line')}`);
  await page.waitForTimeout(1500); // лист меню «Продолжить» ещё уезжает вниз (веб)
  await page.screenshot({ path: join(OUT, '14-sandbox-summary.png'), fullPage: true });
  await page.locator('[data-testid^="case-"]').first().click();
  await page.getByTestId('visit-payment').waitFor({ timeout: 10_000 });
  check(/^оплата\n(омс|дмс|платно): \d/i.test(await text(page, 'visit-payment')), `песочница, итог приёма: ${(await text(page, 'visit-payment')).replace(/\n/g, ' · ')}`);

  // нанятый врач, часть 19: посреди дня его пациент — в разделе «У врачей»; открыть — карта
  // только для чтения, «Забрать себе» — пациент у вас в кабинете со всем, что врач узнал
  const mid = hiredMidDaySave();
  await page.goto(base);
  await page.getByTestId('menu-quick').waitFor({ timeout: 10_000 });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/sandbox.json', mid.save]);
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-sandbox').click();
  await page.getByTestId('restart-continue').click();
  await page.getByTestId('shift-colleagues').waitFor({ timeout: 15_000 });
  await page.getByTestId('tab-pause').click();
  const atDoctor = await text(page, `colleague-${mid.id}`);
  // подпись раздела — заглавными (стиль подписей), innerText отдаёт как на экране
  check(/^у врачей\n/i.test(await text(page, 'shift-colleagues')) && /\nтерапевт .+ · на приёме с \d\d:\d\d$/.test(atDoctor),
    `нанятый врач, «У врачей»: ${atDoctor.replace(/\n/g, ' · ')}`);
  await page.waitForTimeout(1500); // лист меню «Продолжить» ещё уезжает вниз (веб)
  await page.screenshot({ path: join(OUT, '14-hired-colleagues.png'), fullPage: true });
  await page.getByTestId(`colleague-${mid.id}`).click();
  await page.getByTestId('visit-colleague').waitFor({ timeout: 10_000 });
  const took = await text(page, 'colleague-take');
  check((await text(page, 'visit-colleague')).startsWith('Приём ведёт терапевт') && took.includes('Забрать себе') && took.includes('Сразу к вам в кабинет')
    && (await page.getByTestId('visit-decide').count()) === 0 && (await page.getByTestId('exam-exam.ask_onset').count()) === 0,
    `приём врача — только для чтения: ${await text(page, 'visit-colleague')} · ${took.replace(/\n/g, ' · ')}`);
  await page.screenshot({ path: join(OUT, '14-hired-colleague-case.png'), fullPage: true });
  await page.getByTestId('colleague-take').click();
  await visible(page, 'visit-decide').waitFor({ timeout: 10_000 });
  check((await page.locator('[data-testid="visit-colleague"]:visible').count()) === 0 && (await visible(page, 'exam-exam.ask_onset').count()) + (await visible(page, 'done-exam.ask_onset').count()) === 1,
    'забрали себе: пациент у вас в кабинете, карта — ваша');

  // нанятый врач (spec 2026-09-hired-doctors): песочница с терапевтом во втором кабинете — в
  // итогах дня его строка и его приёмы к разбору, а в «Персонале» он — во втором кабинете врача
  await page.goto(base);
  await page.getByTestId('menu-quick').waitFor({ timeout: 10_000 });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/sandbox.json', hiredEndOfDaySave()]);
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-sandbox').click();
  await page.getByTestId('restart-continue').click();
  await page.getByTestId('shift-close-day').waitFor({ timeout: 15_000 });
  await page.getByTestId('shift-close-day').click();
  await page.getByTestId('summary-colleagues').waitFor({ timeout: 10_000 });
  const colleagues = await text(page, 'summary-colleagues');
  check(/вами \d+, врачами [1-9]\d*$/.test(await text(page, 'summary-seen')) && /терапевт\nПринято: [1-9]/.test(colleagues),
    `нанятый врач, итоги дня: ${await text(page, 'summary-seen')} · ${colleagues.replace(/\n/g, ' · ')}`);
  await page.waitForTimeout(1500); // лист меню «Продолжить» ещё уезжает вниз (веб)
  await page.screenshot({ path: join(OUT, '14-hired-summary.png'), fullPage: true });
  // разбор приёма врача — как ваш: кто вёл, его лечение, как прошёл бы разумный
  await page.getByTestId('summary-colleagues').locator('[data-testid^="case-"]').first().click();
  await page.getByTestId('visit-by-doctor').waitFor({ timeout: 10_000 });
  check(/^Приём (вёл|вела) терапевт /.test(await text(page, 'visit-by-doctor')) && (await page.getByTestId('visit-truth').count()) === 1,
    `разбор приёма врача: ${await text(page, 'visit-by-doctor')}`);
  await page.screenshot({ path: join(OUT, '14-hired-review.png'), fullPage: true });
  await page.getByTestId('shift-to-summary').click();
  await page.getByTestId('summary-colleagues').waitFor({ timeout: 10_000 });
  await page.getByTestId('sandbox-staff').click();
  await page.getByTestId('staff-total').waitFor({ timeout: 10_000 });
  const staffTexts = await page.locator('[data-testid^="staff-s"]').allInnerTexts();
  check(staffTexts.some(x => x.includes('Терапевт') && x.includes('работает: кабинет врача №\u00a02')), `нанятый врач в «Персонале»: ${staffTexts.find(x => x.includes('Терапевт'))?.replace(/\n/g, ' · ')}`);

  // стационар (spec 2026-09-chapter-2, часть 26): утро дня 2 — вчерашний пациент в палате,
  // «Обход · 1»; на обходе — сутки, как идёт болезнь, температура по суткам; в решении
  // следующего — «В палату» со свободными койками; положили — лежат двое; выписали первого —
  // в итогах дня стационар, в кассе — случай стационара и койко-дни
  const w = wardSave();
  await page.goto(base);
  await page.getByTestId('menu-quick').waitFor({ timeout: 10_000 });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/sandbox.json', w.save]);
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-sandbox').click();
  await page.getByTestId('restart-continue').click();
  await page.getByTestId('rounds-open').waitFor({ timeout: 15_000 });
  await page.getByTestId('tab-pause').click();
  check((await text(page, 'rounds-open')).startsWith('Обход · 1'), `стационар: на экране смены — ${(await text(page, 'rounds-open')).replace(/\n/g, ' · ')}`);
  await page.getByTestId('rounds-open').click();
  await page.getByTestId(`round-${w.admitted}`).waitFor({ timeout: 10_000 });
  const round = await text(page, `round-${w.admitted}`);
  check(round.includes('В стационаре 1\u00a0сутки · обычно до ') && /\nТемпература: \d+,\d → \d+,\d\u00a0°C\n/.test(round) && round.includes('Лечение: '),
    `стационар, обход: ${round.replace(/\n/g, ' · ')}`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, '16-ward-rounds.png'), fullPage: true });
  await page.goBack();
  await page.getByTestId('shift-continue').click();
  await visible(page, 'visit-decide').waitFor({ timeout: 10_000 });
  await visible(page, 'visit-decide').click();
  await page.getByTestId('decision-to-plan').click();
  await page.getByTestId('setting-admit').waitFor({ timeout: 5000 });
  const admit = await text(page, 'setting-admit');
  check(admit.startsWith('В палату') && admit.includes('свободно 3 из 4') && (await text(page, 'setting-ward')).startsWith('Направить в другую больницу'),
    `стационар, решение: ${admit.replace(/\n/g, ' · ')} · ${(await text(page, 'setting-ward')).replace(/\n/g, ' · ')}`);
  await page.getByTestId('setting-admit').click();
  await page.screenshot({ path: join(OUT, '16-ward-decision.png'), fullPage: true });
  await page.getByTestId('visit-finish').click();
  await page.getByTestId('visit-outcome').waitFor({ timeout: 10_000 });
  check((await text(page, 'visit-outcome')).includes('Лежит в палате'), `стационар, итог приёма: ${await text(page, 'visit-outcome')}`);
  await page.getByTestId('shift-to-queue').click();
  await page.getByTestId('rounds-open').waitFor({ timeout: 10_000 });
  check((await text(page, 'rounds-open')).startsWith('Обход · 2'), `стационар: положили второго — ${(await text(page, 'rounds-open')).replace(/\n/g, ' · ')}`);
  await page.getByTestId('tab-pause').click();
  await page.getByTestId('rounds-open').click();
  await page.getByTestId(`round-discharge-${w.admitted}`).click();
  await page.getByTestId(`round-${w.admitted}`).waitFor({ state: 'detached', timeout: 5000 });
  check((await page.locator('[data-testid^="round-state-"]').count()) === 1, 'стационар: выписан — на обходе остался один');
  await page.goBack();
  await page.locator('[data-testid="shift-close-day-early"], [data-testid="shift-close-day"]').first().click();
  await page.getByTestId('summary-ward').waitFor({ timeout: 10_000 });
  const wardDay = await text(page, 'summary-ward');
  check(wardDay.includes('Поступили: 1, выписаны: 1, переведены: 0. Лежат: 1.') && (await page.getByTestId('cash-ward').count()) === 1,
    `стационар, итоги дня: ${wardDay.replace(/\n/g, ' · ')} · ${(await text(page, 'summary-cash')).replace(/\n/g, ' · ')}`);
  check((await text(page, 'summary-cash')).includes('Стационар: койко-дни'), 'стационар, касса: койко-дни — отдельной статьёй');
  // первая — лёгкая кишечная инфекция: лечится дома, за госпитализацию без показаний страховая не платит
  check((await text(page, 'cash-ward-note')) === 'Госпитализация без показаний — 1: не оплачено', `стационар, касса: ${await text(page, 'cash-ward-note')}`);
  await page.waitForTimeout(1500); // лист меню «Продолжить» ещё уезжает вниз (веб)
  await page.screenshot({ path: join(OUT, '16-ward-summary.png'), fullPage: true });

  // скорая (spec 2026-09-chapter-2, часть 27): после рабочих часов привезённые ждут сортировки —
  // карточка «Скорая», внизу — «сортировать»; лист передачи — повод, что измерил фельдшер, на «Студенте» — NEWS2;
  // отсортировали — в очереди со значком «скорая»; позвали — карта сразу (смотрят в смотровой);
  // в итогах дня — сверка со шкалой и «не отсортировали»
  const amb = ambulanceSave();
  await page.goto(base);
  await page.getByTestId('menu-quick').waitFor({ timeout: 10_000 });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/sandbox.json', amb.save]);
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-sandbox').click();
  await page.getByTestId('restart-continue').click();
  await page.getByTestId(`ambulance-${amb.id}`).waitFor({ timeout: 15_000 });
  await page.getByTestId('tab-pause').click();
  const row = await text(page, `ambulance-${amb.id}`);
  check(/\nповод: .+ · в смотровой приёмного$/.test(row), `скорая: ждут сортировки — ${row.replace(/\n/g, ' · ')}`);
  // внизу — не «Пропустить ожидание»: сначала сортировать первого привезённого
  const sortNext = await text(page, 'shift-sort');
  check(sortNext.startsWith(`Скорая: ${row.split('\n')[0]} — сортировать`) && (await page.getByTestId('shift-skip').count()) === 0, `скорая, кнопка внизу: ${sortNext}`);
  await page.getByTestId('shift-sort').click();
  await page.getByTestId('handover-news2').waitFor({ timeout: 5000 });
  const handover = await text(page, 'handover-sheet');
  // подписи листа — прописными (стиль подписей), innerText отдаёт как на экране
  check(/^NEWS2 — \d+\u00a0балл/.test(await text(page, 'handover-news2')) && handover.toLowerCase().includes('фельдшер измерил') && /Пульс \d+\sуд\/мин/.test(handover),
    `скорая, лист передачи: ${handover.replace(/\n/g, ' · ').slice(0, 220)}`);
  // на «Студенте» — и тревожный признак, если цвет поднял он, а не баллы
  const flagLine = (await page.getByTestId('handover-flag').count()) > 0 ? await text(page, 'handover-flag') : undefined;
  check(amb.flag === undefined ? flagLine === undefined : flagLine?.startsWith(`Тревожный признак: ${amb.flag.toLowerCase()} — `) === true,
    `скорая, тревожный признак в листе: ${flagLine ?? 'нет — цвет дали баллы'}`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, '17-ambulance-handover.png') });
  await page.getByTestId(`sort-${amb.scale}`).click();
  await page.getByTestId('handover-sheet').waitFor({ state: 'detached', timeout: 5000 });
  const queued = await text(page, `queue-${amb.id}`);
  // скорая не платит отдельно: привезённый — всегда ОМС
  check(queued.includes('скорая') && queued.includes('ОМС') && (await page.getByTestId(`ambulance-${amb.id}`).count()) === 0,
    `скорая: отсортирован — в очереди: ${queued.replace(/\n/g, ' · ')}`);
  await page.getByTestId(`queue-${amb.id}`).click();
  await visible(page, 'visit-decide').waitFor({ timeout: 10_000 });
  check(true, 'скорая: позвали — карта сразу, без похода в кабинет');
  await visible(page, 'visit-decide').click();
  await page.getByTestId(`dx-${amb.dx}`).click();
  await page.getByTestId('decision-to-plan').click();
  await page.getByTestId('visit-finish').click();
  await page.getByTestId('visit-outcome').waitFor({ timeout: 10_000 });
  await page.getByTestId('shift-to-queue').click();
  await page.locator('[data-testid="shift-close-day-early"], [data-testid="shift-close-day"]').first().click();
  await page.getByTestId('summary-ambulance').waitFor({ timeout: 10_000 });
  const ambDay = await text(page, 'summary-ambulance');
  check(ambDay.includes(`Привезли: ${amb.cars}, отсортировали: 1.`) && ambDay.includes('Со шкалой совпало: 1. Недооценили: 0, переоценили: 0.')
    && (amb.cars === 1 || ambDay.includes(`Не отсортировали до конца дня: ${amb.cars - 1}.`)), `скорая, итоги дня: ${ambDay.replace(/\n/g, ' · ')}`);
  await page.waitForTimeout(1500); // лист меню «Продолжить» ещё уезжает вниз (веб)
  await page.screenshot({ path: join(OUT, '17-ambulance-summary.png'), fullPage: true });

  // сроки и ЭКГ у постели (spec 2026-10-chapter-3, часть 37): привезли давящую боль в груди —
  // в карте строка срока, ЭКГ у постели за 5 минут, результат сразу; в разборе — «Сроки», в
  // итогах дня — «в срок: 1 из 1»
  const bed = bedsideSave();
  await page.goto(base);
  await page.getByTestId('menu-quick').waitFor({ timeout: 10_000 });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/sandbox.json', bed.save]);
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-sandbox').click();
  await page.getByTestId('restart-continue').click();
  await page.getByTestId(`ambulance-${bed.id}`).waitFor({ timeout: 15_000 });
  await page.getByTestId('tab-pause').click();
  await page.getByTestId(`ambulance-${bed.id}`).click();
  await page.getByTestId(`sort-${bed.scale}`).click();
  await page.getByTestId('handover-sheet').waitFor({ state: 'detached', timeout: 5000 });
  await page.getByTestId(`queue-${bed.id}`).click();
  await visible(page, 'visit-decide').waitFor({ timeout: 10_000 });
  const targetLine = await text(page, 'visit-target-0');
  check(/^ЭКГ при боли в груди — в первые 10\u00a0минут; с прихода — \d+\u00a0мин$/.test(targetLine), `сроки: в карте — «${targetLine}»`);
  await page.getByTestId('tab-order').click();
  const ecgButton = await text(page, 'exam-exam.ecg');
  check(ecgButton.includes('у постели, 5\u00a0мин · 400\u00a0₽'), `ЭКГ у постели: ${ecgButton.replace(/\n/g, ' · ')}`);
  await page.getByTestId('exam-exam.ecg').click();
  await page.getByTestId('done-exam.ecg').waitFor({ timeout: 10_000 });
  // у постели — сразу, без «будет в …»
  const ecgDone = await text(page, 'done-exam.ecg');
  check(!ecgDone.includes('Будет в') && (await page.getByTestId('visit-wait').count()) === 0, `ЭКГ у постели: сразу — «${ecgDone.replace(/\n/g, ' · ').slice(0, 120)}»`);
  const doneLine = await text(page, 'visit-target-0');
  check(/^ЭКГ при боли в груди — через \d+\u00a0мин после прихода, в срок$/.test(doneLine), `сроки: сделано — «${doneLine}»`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, '17-bedside-ecg.png'), fullPage: true });
  await visible(page, 'visit-decide').click();
  await page.getByTestId(`dx-${bed.dx}`).click();
  await page.getByTestId('decision-to-plan').click();
  await page.getByTestId('visit-finish').click();
  await page.getByTestId('visit-outcome').waitFor({ timeout: 10_000 });
  const targetsGrade = await text(page, 'visit-targets-grade');
  const reviewLine = await text(page, 'visit-target-line-0');
  check(targetsGrade === 'A' && /^• ЭКГ при боли в груди: через \d+\u00a0мин после прихода — в срок$/.test(reviewLine), `сроки, разбор: ${targetsGrade} · ${reviewLine}`);
  await page.getByTestId('shift-to-queue').click();
  // рабочие часы ещё идут — «Закрыть день» появится после них
  await page.getByTestId('tab-x4').click();
  const closeBed = page.locator('[data-testid="shift-close-day-early"], [data-testid="shift-close-day"]');
  check(await runClockUntil(page, async () => (await closeBed.count()) > 0, 120_000), 'сроки: день дожит до конца рабочих часов');
  await closeBed.first().click();
  await page.getByTestId('summary-targets').waitFor({ timeout: 10_000 });
  const targetsDay = await text(page, 'summary-targets');
  check(targetsDay.includes('ЭКГ при боли в груди в срок: 1 из 1.'), `сроки, итоги дня: ${targetsDay.replace(/\n/g, ' · ')}`);
  await page.waitForTimeout(1500); // лист меню «Продолжить» ещё уезжает вниз (веб)
  await page.screenshot({ path: join(OUT, '17-targets-summary.png'), fullPage: true });

  // исход перевода по часам (spec 2026-10-chapter-3, часть 39б): в смотровой — инфаркт с подъёмом ST
  // в первые часы, без противопоказаний; ЭКГ у постели, тромболизис со спутниками и «Вызвать скорую» —
  // в итоге приёма строка о сосудистом центре, в разборе — сроки тромболизиса и перевода
  const lysisRisks = ['risk.anticoagulants', 'risk.bleeding_tendency', 'risk.recent_bleed_surgery', 'risk.stroke_history'];
  const mi = bedsideSave(db => {
    for (let seed = 9100; ; seed++) {
      const x = generatePatient(db, seed, { department: 'dept.therapy', season: 'winter', primary: 'cond.acs', params: { type: 'stemi', killip: 'i' } });
      if (x.truth.values['hx.onset_hours'] <= 3 && x.complaints.includes('sym.chest_pain_pressing') && !lysisRisks.some(r => x.truth.risks.includes(r))) return x;
    }
  });
  await page.goto(base);
  await page.getByTestId('menu-quick').waitFor({ timeout: 10_000 });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/sandbox.json', mi.save]);
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-sandbox').click();
  await page.getByTestId('restart-continue').click();
  await page.getByTestId(`ambulance-${mi.id}`).waitFor({ timeout: 15_000 });
  await page.getByTestId('tab-pause').click();
  await page.getByTestId(`ambulance-${mi.id}`).click();
  await page.getByTestId(`sort-${mi.scale}`).click();
  await page.getByTestId('handover-sheet').waitFor({ state: 'detached', timeout: 5000 });
  await page.getByTestId(`queue-${mi.id}`).click();
  await visible(page, 'visit-decide').waitFor({ timeout: 10_000 });
  await page.getByTestId('tab-order').click();
  await page.getByTestId('exam-exam.ecg').click();
  await page.getByTestId('done-exam.ecg').waitFor({ timeout: 10_000 });
  // ЭКГ находит подъём ST не у каждого (чувствительность 92 %): сроки смотровой — когда нашла
  const st = (await text(page, 'done-exam.ecg')).includes('Подъём сегмента ST в отведениях');
  await visible(page, 'visit-decide').click();
  await page.getByTestId('dx-cond.acs').click();
  await page.getByTestId('decision-to-plan').click();
  for (const tx of ['tx.thrombolysis', 'tx.aspirin_acs', 'tx.clopidogrel', 'tx.enoxaparin_acs']) await page.getByTestId(`tx-${tx}`).click();
  await page.getByTestId('setting-ambulance').click();
  await page.getByTestId('visit-finish').click();
  await page.getByTestId('visit-outcome').waitFor({ timeout: 10_000 });
  const rsc = await text(page, 'visit-outcome');
  check(/(Переведён|Переведена) в сосудистый центр\. Тромболизис (помог|не помог)|в сосудистом центре на \d-е\u00a0сутки/.test(rsc), `исход перевода: «${rsc.replace(/\n/g, ' · ').slice(0, 220)}»`);
  const lines: string[] = [];
  for (let i = 0; (await page.getByTestId(`visit-target-line-${i}`).count()) > 0; i++) lines.push(await text(page, `visit-target-line-${i}`));
  const lysisLine = lines.some(l => /^• Тромболизис при подъёме ST: через \d+\u00a0мин после ЭКГ с подъёмом ST — /.test(l));
  const transferLine = lines.some(l => /^• Перевод при подъёме ST: через \d+\u00a0мин после прихода — в срок$/.test(l));
  check(st ? lysisLine && transferLine : !lysisLine && !transferLine, `сроки тромболизиса и перевода (ЭКГ ${st ? 'нашла' : 'не нашла'} подъём ST): ${lines.join(' · ')}`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, '17-rsc-outcome.png'), fullPage: true });
  await page.getByTestId('shift-to-queue').click();

  // ОКС без подъёма ST (spec 2026-10-chapter-3, часть 39в): тропонин по алгоритму 0/1 час — одно
  // назначение, два результата; пока второго нет — «будет в …»; прирост подтверждает инфаркт, правило
  // («Студент») — коронарография в первые сутки, перевод; в разборе — без «не назначено»
  const nste = bedsideSave(db => {
    for (let seed = 9300; ; seed++) {
      const x = generatePatient(db, seed, { department: 'dept.therapy', season: 'winter', primary: 'cond.acs', params: { type: 'nste', mi: 'yes', killip: 'i' } });
      // возраст — как у ОКС в базе (с 35 лет): иначе вывод «Студента» его не предложит; сатурация не
      // ниже 90 — без обязательного кислорода
      if (x.age >= 45 && x.complaints.includes('sym.chest_pain_pressing') && x.truth.risks.length === 0 && x.truth.conditions[0].params.spo2_below90 === 'no') return x;
    }
  });
  await page.goto(base);
  await page.getByTestId('menu-quick').waitFor({ timeout: 10_000 });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/sandbox.json', nste.save]);
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-sandbox').click();
  await page.getByTestId('restart-continue').click();
  await page.getByTestId(`ambulance-${nste.id}`).waitFor({ timeout: 15_000 });
  await page.getByTestId('tab-pause').click();
  await page.getByTestId(`ambulance-${nste.id}`).click();
  await page.getByTestId(`sort-${nste.scale}`).click();
  await page.getByTestId('handover-sheet').waitFor({ state: 'detached', timeout: 5000 });
  await page.getByTestId(`queue-${nste.id}`).click();
  await visible(page, 'visit-decide').waitFor({ timeout: 10_000 });
  await page.getByTestId('tab-order').click();
  await page.getByTestId('exam-exam.troponin_hs').click();
  await page.getByTestId('done-exam.troponin_hs').waitFor({ timeout: 10_000 });
  const tropWait = await text(page, 'done-exam.troponin_hs');
  check(tropWait.includes('Будет в'), `тропонин: ждём — «${tropWait.replace(/\n/g, ' · ').slice(0, 120)}»`);
  // ждать — до первого результата, потом до второго (привезённая скорая обрывает ожидание — ещё раз)
  for (let i = 0; i < 8 && (await page.getByTestId('visit-wait').count()) > 0; i++) await page.getByTestId('visit-wait').click();
  const tropDone = await text(page, 'done-exam.troponin_hs');
  check(/Через час тропонин T вырос на \d+\sнг\/л — 5 и больше/.test(tropDone) && /Тропонин T \d+\sнг\/л — (52 и выше|ниже 12)/.test(tropDone),
    `тропонин 0/1 час: «${tropDone.replace(/\n/g, ' · ').slice(0, 220)}»`);
  const ruleLine = await text(page, 'rule-rule.acs_invasive');
  check(ruleLine.startsWith('Коронарография в первые сутки при ОКС. Коронарография в первые сутки — перевод в сосудистый центр'), `правило коронарографии: «${ruleLine.slice(0, 160)}»`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, '18-troponin.png'), fullPage: true });
  await visible(page, 'visit-decide').click();
  await page.getByTestId('dx-cond.acs').click();
  await page.getByTestId('decision-to-plan').click();
  for (const tx of ['tx.aspirin_acs', 'tx.nitroglycerin', 'tx.enoxaparin_acs']) await page.getByTestId(`tx-${tx}`).click();
  await page.getByTestId('setting-ambulance').click();
  await page.getByTestId('visit-finish').click();
  await page.getByTestId('visit-outcome').waitFor({ timeout: 10_000 });
  // замечаний разбора о лечении нет: клопидогрел перед коронарографией не дали, антикоагулянт — облегчает
  const nsteReview = await page.locator('body').innerText();
  check(!/не назначено|здесь не показано/i.test(nsteReview), `ОКС без подъёма ST, перевод: разбор — «${nsteReview.replace(/\n/g, ' · ').slice(0, 260)}»`);
  await page.getByTestId('shift-to-queue').click();

  // стенокардия напряжения (spec 2026-10-chapter-3, часть 39г): боль при нагрузке — жалоба, расспрос о боли в
  // груди её не повторяет, а отвечает: давно, не чаще, в покое не давит; дома — нитроглицерин,
  // бета-адреноблокатор и статин, в разборе нет «не назначено»
  const angina = anginaSave();
  const ac = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 });
  await ac.addInitScript(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/shift.json', angina.save]);
  const pa = await ac.newPage();
  pa.on('pageerror', e => errors.push(String(e)));
  await pa.goto(`${base}/shift`);
  await pa.getByTestId(`queue-${angina.id}`).waitFor({ timeout: 15_000 });
  await pa.getByTestId('tab-pause').click();
  await pa.getByTestId(`queue-${angina.id}`).click();
  await visible(pa, 'visit-decide').waitFor({ timeout: 15_000 });
  await pa.getByTestId('exam-exam.ask_chest_pain').click();
  await pa.getByTestId('done-exam.ask_chest_pain').waitFor({ timeout: 5000 });
  const anginaAsk = await text(pa, 'done-exam.ask_chest_pain');
  check(anginaAsk.includes('Приступы такие же') && anginaAsk.includes('Давящей боли за грудиной в покое нет'), `стенокардия напряжения: расспрос — «${anginaAsk.replace(/\n/g, ' · ').slice(0, 240)}»`);
  await visible(pa, 'visit-decide').click();
  await pa.getByTestId('dx-cond.angina_stable').click();
  await pa.getByTestId('decision-to-plan').click();
  for (const tx of ['tx.nitroglycerin', 'tx.beta_blocker', 'tx.statin']) await pa.getByTestId(`tx-${tx}`).click();
  await pa.getByTestId('setting-home').click();
  await pa.getByTestId('visit-finish').click();
  await pa.getByTestId('visit-truth').waitFor({ timeout: 10_000 });
  const anginaReview = await pa.locator('body').innerText();
  check(anginaReview.includes('Стабильная стенокардия напряжения') && !/не назначено|здесь не показано/i.test(anginaReview),
    `стенокардия напряжения: дома, разбор — «${anginaReview.replace(/\n/g, ' · ').slice(0, 260)}»`);
  await pa.waitForTimeout(500);
  await pa.screenshot({ path: join(OUT, '19-angina.png'), fullPage: true });
  await ac.close();
  // операционная (spec 2026-09-chapter-2, часть 28): у вас пациент с аппендицитом — в решении
  // «В операционную» с операцией и койками; итог приёма — операция и палата; на обходе —
  // «идёт операция» и выписать нельзя; вечером — в итогах дня операционная
  const surg = surgerySave();
  await page.goto(base);
  await page.getByTestId('menu-quick').waitFor({ timeout: 10_000 });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/sandbox.json', surg.save]);
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-sandbox').click();
  await page.getByTestId('restart-continue').click();
  await page.getByTestId('shift-continue').waitFor({ timeout: 15_000 });
  await page.getByTestId('tab-pause').click();
  await page.getByTestId('shift-continue').click();
  await visible(page, 'visit-decide').waitFor({ timeout: 10_000 });
  await visible(page, 'visit-decide').click();
  await page.getByTestId('decision-to-plan').click();
  await page.getByTestId('setting-surgery').waitFor({ timeout: 5000 });
  const opOption = await text(page, 'setting-surgery');
  check(opOption.startsWith('В операционную') && opOption.includes('Аппендэктомия · коек свободно 4 из 4') && !(await page.getByTestId('setting-surgery').isDisabled()),
    `операционная, решение: ${opOption.replace(/\n/g, ' · ')}`);
  await page.getByTestId('setting-surgery').click();
  await page.screenshot({ path: join(OUT, '18-surgery-decision.png'), fullPage: true });
  await page.getByTestId('visit-finish').click();
  await page.getByTestId('visit-outcome').waitFor({ timeout: 10_000 });
  check((await text(page, 'visit-outcome')).includes('В операционную, после операции — в палату'), `операционная, итог приёма: ${await text(page, 'visit-outcome')}`);
  await page.getByTestId('shift-to-queue').click();
  await page.getByTestId('rounds-open').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, '18-surgery-map.png') });
  await page.getByTestId('rounds-open').click();
  await page.getByTestId(`round-op-${surg.id}`).waitFor({ timeout: 10_000 });
  const opLine = await text(page, `round-op-${surg.id}`);
  check(/^Идёт операция: аппендэктомия, до \d{2}:\d{2}$/.test(opLine) && await page.getByTestId(`round-discharge-${surg.id}`).isDisabled()
    && await page.getByTestId(`round-transfer-${surg.id}`).isDisabled(), `операционная, обход: ${opLine}; выписать и перевести нельзя`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, '18-surgery-rounds.png'), fullPage: true });
  await page.goBack();
  await page.locator('[data-testid="shift-close-day-early"], [data-testid="shift-close-day"]').first().click();
  await page.getByTestId('summary-surgery').waitFor({ timeout: 10_000 });
  const opDay = await text(page, 'summary-surgery');
  check(opDay.includes('Операций: 1, в срок: 1.'), `операционная, итоги дня: ${opDay.replace(/\n/g, ' · ')}`);
  await page.waitForTimeout(1500); // лист меню «Продолжить» ещё уезжает вниз (веб)
  await page.screenshot({ path: join(OUT, '18-surgery-summary.png'), fullPage: true });
  // палата интенсивной терапии (spec 2026-10-chapter-3, часть 38а): у вас анафилактический шок — в
  // решении «В ПИТ» со свободными койками под монитором; итог — лежит в ПИТ; на обходе — строка ПИТ
  const icuv = icuSave();
  await page.goto(base);
  await page.getByTestId('menu-quick').waitFor({ timeout: 10_000 });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/sandbox.json', icuv.save]);
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-sandbox').click();
  await page.getByTestId('restart-continue').click();
  await page.getByTestId('shift-continue').waitFor({ timeout: 15_000 });
  await page.getByTestId('tab-pause').click();
  await page.getByTestId('shift-continue').click();
  await visible(page, 'visit-decide').waitFor({ timeout: 10_000 });
  await visible(page, 'visit-decide').click();
  await page.getByTestId('decision-to-plan').click();
  await page.getByTestId('setting-icu').waitFor({ timeout: 5000 });
  // кислород через маску (часть 38б) — своя группа в списке назначений
  check((await page.getByTestId('tx-tx.oxygen_mask').count()) === 1 && (await page.getByText('Кислород', { exact: true }).count()) >= 1,
    'ПИТ, решение: «Кислород через маску» — в группе «Кислород»');
  const icuOption = await text(page, 'setting-icu');
  check(icuOption.startsWith('В ПИТ') && icuOption.includes('под монитором свободно 2 из 2') && !(await page.getByTestId('setting-icu').isDisabled()),
    `ПИТ, решение: ${icuOption.replace(/\n/g, ' · ')}`);
  await page.getByTestId('setting-icu').click();
  await page.screenshot({ path: join(OUT, '18-icu-decision.png'), fullPage: true });
  await page.getByTestId('visit-finish').click();
  await page.getByTestId('visit-outcome').waitFor({ timeout: 10_000 });
  check((await text(page, 'visit-outcome')).includes('Лежит в палате интенсивной терапии, под монитором'), `ПИТ, итог приёма: ${await text(page, 'visit-outcome')}`);
  await page.getByTestId('shift-to-queue').click();
  await page.getByTestId('rounds-open').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, '18-icu-map.png') });
  await page.getByTestId('rounds-open').click();
  await page.getByTestId(`round-icu-${icuv.id}`).waitFor({ timeout: 10_000 });
  check((await text(page, `round-icu-${icuv.id}`)) === 'Палата интенсивной терапии, под монитором', `ПИТ, обход: ${await text(page, `round-icu-${icuv.id}`)}`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, '18-icu-rounds.png'), fullPage: true });
  await page.goBack();
  // энциклопедия: операция — что лечит, где, бригада
  await page.goto(`${base}/encyclopedia/article/tx.appendectomy`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  // подписи разделов — прописными (стиль подписей), innerText отдаёт как на экране
  const team = (await visibleText(page, 'enc-block-team')).toLowerCase();
  check((await visibleText(page, 'enc-article-title')) === 'Аппендэктомия' && team === 'бригада' && (await visible(page, 'enc-block-treats').count()) === 1,
    `энциклопедия, операция: ${await visibleText(page, 'enc-article-title')} — что лечит, где, ${team}`);
  // перфорация (часть 28б): исходы по стадии — у операции, риск по часам — у болезни
  check((await visible(page, 'enc-block-outcomes').count()) === 1, 'энциклопедия, операция: исходы — без перфорации и с ней');
  await page.goto(`${base}/encyclopedia/article/cond.appendicitis`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const risk = await page.locator('text=Перфорация без операции').first().isVisible().catch(() => false);
  check(risk, 'энциклопедия, аппендицит: «Перфорация без операции: за первые 36 ч — до 2 %…»');

  // кабинет УЗИ (spec 2026-09-chapter-2, часть 29): у вас пациент с аппендицитом, УЗИ сделано —
  // результат сектором и строкой; на карте — кабинет УЗИ; в энциклопедии — обследование и кабинет
  const usv = usSave();
  await page.goto(base);
  await page.getByTestId('menu-quick').waitFor({ timeout: 10_000 });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/sandbox.json', usv.save]);
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-sandbox').click();
  await page.getByTestId('restart-continue').click();
  await page.getByTestId('shift-continue').waitFor({ timeout: 15_000 });
  await page.getByTestId('tab-pause').click();
  await page.getByTestId('shift-continue').click();
  await visible(page, 'result-us').waitFor({ timeout: 10_000 });
  await visible(page, 'result-us').scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  const usBox = await visible(page, 'result-us').boundingBox();
  const usLine = await page.locator('text=утолщённый несжимаемый червеобразный отросток').first().isVisible().catch(() => false);
  check(usBox !== null && usBox.height > 150 && usLine, `УЗИ: результат в карте — сектором ${Math.round(usBox?.width ?? 0)} × ${Math.round(usBox?.height ?? 0)} и строкой «…утолщённый несжимаемый червеобразный отросток…»`);
  await page.screenshot({ path: join(OUT, '18-us-result.png'), fullPage: true });
  await page.goBack();
  await page.getByTestId('shift-clock').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, '18-us-map.png') });
  await page.goto(`${base}/encyclopedia/article/exam.us_abdomen`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const usAcc = await page.locator('text=чувствительность 76\u00a0%').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'УЗИ брюшной полости' && usAcc, `энциклопедия, УЗИ: ${await visibleText(page, 'enc-article-title')} — чувствительность 76 %, специфичность 95 %`);
  await page.goto(`${base}/encyclopedia/article/room.ultrasound`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  check((await visibleText(page, 'enc-article-title')) === 'Кабинет УЗИ', `энциклопедия, кабинет: ${await visibleText(page, 'enc-article-title')}`);

  // кабинет КТ (spec 2026-10-chapter-3, часть 40): у вас сотрясение с рвотой — КТ показана и сделана:
  // срез головы и «Крови внутри черепа нет»; после КТ — «Дома», в разборе место не ошибка; на карте —
  // кабинет КТ; в энциклопедии — кабинет, обследование и место после КТ
  const ctv = ctSave();
  await page.goto(base);
  await page.getByTestId('menu-quick').waitFor({ timeout: 10_000 });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/sandbox.json', ctv.save]);
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-sandbox').click();
  await page.getByTestId('restart-continue').click();
  await page.getByTestId('shift-continue').waitFor({ timeout: 15_000 });
  await page.getByTestId('tab-pause').click();
  await page.getByTestId('shift-continue').click();
  await visible(page, 'result-ct').waitFor({ timeout: 10_000 });
  await visible(page, 'result-ct').scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  const ctBox = await visible(page, 'result-ct').boundingBox();
  const ctLine = await page.locator('text=Крови внутри черепа нет').first().isVisible().catch(() => false);
  check(ctBox !== null && ctBox.height > 150 && Math.abs(ctBox.width - ctBox.height) < 2 && ctLine,
    `КТ: результат в карте — срезом ${Math.round(ctBox?.width ?? 0)} × ${Math.round(ctBox?.height ?? 0)} и строкой «Крови внутри черепа нет»`);
  await page.screenshot({ path: join(OUT, '20-ct-result.png'), fullPage: true });
  await visible(page, 'visit-decide').click();
  await visible(page, 'dx-cond.concussion').click();
  await visible(page, 'decision-to-plan').click();
  for (const tx of ['tx.screen_rest', 'tx.paracetamol']) await page.getByTestId(`tx-${tx}`).click();
  await page.getByTestId('setting-home').click();
  await page.getByTestId('visit-finish').click();
  await page.getByTestId('visit-truth').waitFor({ timeout: 10_000 });
  const ctReview = await page.locator('body').innerText();
  check(ctReview.includes('Сотрясение головного мозга') && !/Недооценили тяжесть|Перестраховка/.test(ctReview),
    `КТ: после КТ без крови — «Дома», разбор — «${ctReview.replace(/\n/g, ' · ').slice(0, 260)}»`);
  await page.getByTestId('shift-to-queue').click();
  await page.getByTestId('shift-clock').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, '20-ct-map.png') });
  await page.goto(`${base}/encyclopedia/article/room.ct`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  check((await visibleText(page, 'enc-article-title')) === 'Кабинет КТ', `энциклопедия, кабинет: ${await visibleText(page, 'enc-article-title')}`);
  await page.goto(`${base}/encyclopedia/article/exam.ct_head`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  check((await visibleText(page, 'enc-article-title')) === 'КТ головного мозга', `энциклопедия, КТ: ${await visibleText(page, 'enc-article-title')}`);
  await page.goto(`${base}/encyclopedia/article/cond.concussion`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const afterCt = await page.locator('text=После обследования «КТ головного мозга» — дома.').first().isVisible().catch(() => false);
  check(afterCt, 'энциклопедия, сотрясение: «После обследования «КТ головного мозга» — дома.»');

  // ишемический инсульт (spec 2026-10-chapter-3, часть 41а): у вас — привезённый скорой инсульт в окне,
  // он лежит в смотровой под монитором; в карте — NIHSS и КТ без крови, КТ-ангиография — среди
  // обследований; тромболизис у постели доступен, «В ПИТ»; в разборе — сроки инсульта и ни одного
  // замечания о лечении; в энциклопедии — острый период и тромболизис в окне
  const sv = strokeSave();
  await page.goto(base);
  await page.getByTestId('menu-quick').waitFor({ timeout: 10_000 });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/sandbox.json', sv.save]);
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-sandbox').click();
  await page.getByTestId('restart-continue').click();
  await page.getByTestId('shift-continue').waitFor({ timeout: 15_000 });
  await page.getByTestId('tab-pause').click();
  await page.getByTestId('shift-continue').click();
  await visible(page, 'visit-decide').waitFor({ timeout: 10_000 });
  const strokeCard = await page.locator('body').innerText();
  check(/По шкале инсульта NIH — \d+/.test(strokeCard) && strokeCard.includes('Крови внутри черепа нет'),
    `инсульт: в карте — NIHSS и КТ без крови («${strokeCard.replace(/\n/g, ' · ').slice(0, 240)}»)`);
  await visible(page, 'tab-order').click();
  check((await visible(page, 'exam-exam.cta_head').count()) === 1, 'инсульт: «КТ-ангиография сосудов головы и шеи» — среди обследований');
  await page.screenshot({ path: join(OUT, '21-stroke-card.png'), fullPage: true });
  await visible(page, 'visit-decide').click();
  await visible(page, 'dx-cond.stroke_ischemic').click();
  await visible(page, 'decision-to-plan').click();
  await page.getByTestId('tx-tx.thrombolysis_stroke').waitFor({ timeout: 5000 });
  check(!(await page.getByTestId('tx-tx.thrombolysis_stroke').isDisabled()) && (await text(page, 'tx-tx.thrombolysis_stroke')).includes('Тромболизис при ишемическом инсульте'),
    `инсульт, решение: тромболизис у постели под монитором — ${await text(page, 'tx-tx.thrombolysis_stroke')}`);
  await page.getByTestId('tx-tx.thrombolysis_stroke').click();
  await page.getByTestId('setting-icu').click();
  await page.screenshot({ path: join(OUT, '21-stroke-decision.png'), fullPage: true });
  await page.getByTestId('visit-finish').click();
  await page.getByTestId('visit-truth').waitFor({ timeout: 10_000 });
  const strokeReview = await page.locator('body').innerText();
  check(strokeReview.includes('Ишемический инсульт') && strokeReview.includes('Осмотр при подозрении на инсульт') && strokeReview.includes('Тест глотания при инсульте')
    && !/Не назначено|не показано|Окно закрылось|Недооценили тяжесть/.test(strokeReview),
    `инсульт: тромболизис и ПИТ, разбор — «${strokeReview.replace(/\n/g, ' · ').slice(0, 300)}»`);
  await page.screenshot({ path: join(OUT, '21-stroke-review.png'), fullPage: true });
  await page.goto(`${base}/encyclopedia/article/cond.stroke_ischemic`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const settles = await page.locator('text=Острый период проходит под наблюдением в стационаре').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'Ишемический инсульт' && settles, `энциклопедия, инсульт: ${await visibleText(page, 'enc-article-title')} — острый период в стационаре`);

  // транзиторная ишемическая атака (часть 41б): у вас — ТИА высокого риска, всё для шкалы проверено;
  // в карте — строка ABCD2 с баллами; два антиагреганта и «В ПИТ» — разбор без замечаний; в
  // энциклопедии — баллы шкалы и риск инсульта по группам
  const tv = tiaSave();
  await page.goto(base);
  await page.getByTestId('menu-quick').waitFor({ timeout: 10_000 });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/sandbox.json', tv.save]);
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-sandbox').click();
  await page.getByTestId('restart-continue').click();
  await page.getByTestId('shift-continue').waitFor({ timeout: 15_000 });
  await page.getByTestId('tab-pause').click();
  await page.getByTestId('shift-continue').click();
  await visible(page, 'visit-decide').waitFor({ timeout: 10_000 });
  const tiaCard = await page.locator('body').innerText();
  check(tiaCard.includes('Шкала ABCD2 после транзиторной ишемической атаки') && /Риск инсульта выше — нужны два антиагреганта, ацетилсалициловая кислота и клопидогрел: \d\u00a0балл/.test(tiaCard),
    `ТИА: в карте — строка ABCD2 с баллами («${tiaCard.replace(/\n/g, ' · ').slice(0, 300)}»)`);
  await page.screenshot({ path: join(OUT, '21-tia-card.png'), fullPage: true });
  await visible(page, 'visit-decide').click();
  await visible(page, 'dx-cond.tia').click();
  await visible(page, 'decision-to-plan').click();
  await page.getByTestId('tx-tx.aspirin_acs').waitFor({ timeout: 5000 });
  await page.getByTestId('tx-tx.aspirin_acs').click();
  await page.getByTestId('tx-tx.clopidogrel').click();
  await page.getByTestId('setting-icu').click();
  await page.getByTestId('visit-finish').click();
  await page.getByTestId('visit-truth').waitFor({ timeout: 10_000 });
  const tiaReview = await page.locator('body').innerText();
  check(tiaReview.includes('Транзиторная ишемическая атака') && tiaReview.includes('Осмотр при подозрении на инсульт') && !/Не назначено|не показано|Недооценили тяжесть/.test(tiaReview),
    `ТИА: два антиагреганта и ПИТ, разбор — «${tiaReview.replace(/\n/g, ' · ').slice(0, 300)}»`);
  await page.screenshot({ path: join(OUT, '21-tia-review.png'), fullPage: true });
  await page.goto(`${base}/encyclopedia/article/rule.abcd2`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  // заголовки разделов на экране — заглавными, и innerText отдаёт их так же: порог — без учёта регистра
  const scale = (await page.locator('body').innerText()).replace(/\u00a0/g, ' ');
  check((await visibleText(page, 'enc-article-title')) === 'Шкала ABCD2 после транзиторной ишемической атаки' && scale.includes('Прошедшая слабость в руке и ноге · 2 балла') && /если баллов 4 и больше/i.test(scale),
    `энциклопедия, ABCD2: ${await visibleText(page, 'enc-article-title')} — баллы и порог`);
  await page.goto(`${base}/encyclopedia/article/cond.tia`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const strokeRisk = await page.locator('text=ишемический инсульт у 12').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'Транзиторная ишемическая атака' && strokeRisk, `энциклопедия, ТИА: ${await visibleText(page, 'enc-article-title')} — риск инсульта по группам`);

  // внутримозговое кровоизлияние (часть 41в): у вас — привезённая скорой гематома до 30 см³; в карте — КТ с
  // кровью и гематомой в полушарии с объёмом, срез, «тромболизис нельзя» и правило об антикоагулянте; давление
  // в вену у постели, консультация нейрохирурга и «В ПИТ» — разбор без замечаний, со сроком нейрохирурга; в
  // энциклопедии — перевод при гематоме больше 30 см³
  const hv = ichSave();
  await page.goto(base);
  await page.getByTestId('menu-quick').waitFor({ timeout: 10_000 });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/sandbox.json', hv.save]);
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-sandbox').click();
  await page.getByTestId('restart-continue').click();
  await page.getByTestId('shift-continue').waitFor({ timeout: 15_000 });
  await page.getByTestId('tab-pause').click();
  await page.getByTestId('shift-continue').click();
  await visible(page, 'visit-decide').waitFor({ timeout: 10_000 });
  const ichCard = (await page.locator('body').innerText()).replace(/\u00a0/g, ' ');
  check(ichCard.includes('Внутри черепа свежая кровь') && /Гематома в (правом|левом) полушарии — \d+ см³/.test(ichCard) && ichCard.includes('Тромболизис нельзя: кровь внутри черепа')
    && ichCard.includes('Антикоагулянтов не принимает — нейтрализовать нечего'),
    `ВМК: в карте — КТ с гематомой, «тромболизис нельзя» и правило об антикоагулянте («${ichCard.replace(/\n/g, ' · ').slice(0, 300)}»)`);
  await visible(page, 'result-ct').scrollIntoViewIfNeeded();
  check((await visible(page, 'result-ct').boundingBox() ?? { height: 0 }).height > 150, 'ВМК: КТ — срезом головы');
  await page.screenshot({ path: join(OUT, '21-ich-card.png'), fullPage: true });
  await visible(page, 'visit-decide').click();
  await visible(page, 'dx-cond.ich').click();
  await visible(page, 'decision-to-plan').click();
  await page.getByTestId('tx-tx.bp_iv').waitFor({ timeout: 5000 });
  check(!(await page.getByTestId('tx-tx.bp_iv').isDisabled()), `ВМК, решение: давление в вену у постели под монитором — ${await text(page, 'tx-tx.bp_iv')}`);
  await page.getByTestId('tx-tx.bp_iv').click();
  await page.getByTestId('tx-tx.nsg_consult').click();
  await page.getByTestId('setting-icu').click();
  await page.screenshot({ path: join(OUT, '21-ich-decision.png'), fullPage: true });
  await page.getByTestId('visit-finish').click();
  await page.getByTestId('visit-truth').waitFor({ timeout: 10_000 });
  const ichReview = await page.locator('body').innerText();
  check(ichReview.includes('Внутримозговое кровоизлияние') && ichReview.includes('Консультация нейрохирурга при кровоизлиянии') && !/Не назначено|не показано|вредно|Недооценили тяжесть/.test(ichReview),
    `ВМК: давление, нейрохирург и ПИТ, разбор — «${ichReview.replace(/\n/g, ' · ').slice(0, 300)}»`);
  await page.screenshot({ path: join(OUT, '21-ich-review.png'), fullPage: true });
  await page.goto(`${base}/encyclopedia/article/cond.ich`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const ichWhere = await page.locator('text=При гематоме больше 30').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'Внутримозговое кровоизлияние' && ichWhere, `энциклопедия, ВМК: ${await visibleText(page, 'enc-article-title')} — перевод при гематоме больше 30 см³`);

  // фибрилляция и трепетание предсердий (часть 42а): у вас — привезённое скорой трепетание меньше 48 часов; в
  // карте — ЭКГ с пилообразными волнами и лента, строка CHA₂DS₂-VASc с баллами; электрическая кардиоверсия у
  // постели, антикоагулянт и «Домой» — разбор без замечаний; в энциклопедии — шкала с возрастом полосами и
  // порогом по полу
  const af = afSave();
  await page.goto(base);
  await page.getByTestId('menu-quick').waitFor({ timeout: 10_000 });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/sandbox.json', af.save]);
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-sandbox').click();
  await page.getByTestId('restart-continue').click();
  await page.getByTestId('shift-continue').waitFor({ timeout: 15_000 });
  await page.getByTestId('tab-pause').click();
  await page.getByTestId('shift-continue').click();
  await visible(page, 'visit-decide').waitFor({ timeout: 10_000 });
  const afCard = (await page.locator('body').innerText()).replace(/\u00a0/g, ' ');
  check(afCard.includes('Пилообразные волны F вместо зубцов P — трепетание предсердий') && afCard.includes('Шкала CHA₂DS₂-VASc при фибрилляции предсердий')
    && /Риск инсульта высокий — нужен антикоагулянт постоянно: \d балл/.test(afCard),
    `ФП: в карте — ЭКГ с трепетанием и строка CHA₂DS₂-VASc с баллами («${afCard.replace(/\n/g, ' · ').slice(0, 300)}»)`);
  await visible(page, 'result-ecg').scrollIntoViewIfNeeded();
  check((await visible(page, 'result-ecg').boundingBox() ?? { height: 0 }).height > 100, 'ФП: ЭКГ — лентой');
  await page.screenshot({ path: join(OUT, '21-af-card.png'), fullPage: true });
  await visible(page, 'visit-decide').click();
  await visible(page, 'dx-cond.af').click();
  await visible(page, 'decision-to-plan').click();
  await page.getByTestId('tx-tx.cardioversion').waitFor({ timeout: 5000 });
  check(!(await page.getByTestId('tx-tx.cardioversion').isDisabled()), `ФП, решение: кардиоверсия у постели под монитором — ${await text(page, 'tx-tx.cardioversion')}`);
  await page.getByTestId('tx-tx.cardioversion').click();
  await page.getByTestId('tx-tx.doac').click();
  await page.getByTestId('setting-home').click();
  await page.screenshot({ path: join(OUT, '21-af-decision.png'), fullPage: true });
  await page.getByTestId('visit-finish').click();
  await page.getByTestId('visit-truth').waitFor({ timeout: 10_000 });
  const afReview = await page.locator('body').innerText();
  check(afReview.includes('Фибрилляция и трепетание предсердий') && !/[Нн]е назначено|не показано|вредно|Недооценили тяжесть/.test(afReview),
    `ФП: кардиоверсия, антикоагулянт и дом, разбор — «${afReview.replace(/\n/g, ' · ').slice(0, 300)}»`);
  await page.screenshot({ path: join(OUT, '21-af-review.png'), fullPage: true });
  await page.goto(`${base}/encyclopedia/article/rule.cha2ds2vasc`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const cha = (await page.locator('body').innerText()).replace(/\u00a0/g, ' ');
  check((await visibleText(page, 'enc-article-title')) === 'Шкала CHA₂DS₂-VASc при фибрилляции предсердий' && cha.includes('Возраст 65–74 года — 1 балл') && cha.includes('Женский пол — 1 балл')
    && /если баллов у мужчин 2 и больше, у женщин — 3 и больше/i.test(cha),
    `энциклопедия, CHA₂DS₂-VASc: ${await visibleText(page, 'enc-article-title')} — возраст полосами и порог по полу`);

  // наджелудочковая тахикардия (часть 42б): у вас — привезённый скорой приступ; в карте — ЭКГ с узкими
  // комплексами, пульс 150 и чаще, сердцебиение «ровно»; вагусные пробы и трифосаденин у постели под
  // монитором и «Домой» — разбор без замечаний; в энциклопедии — без монитора у постели ПИТ, у разряда —
  // спутники только при фибрилляции предсердий
  const svt = svtSave();
  await page.goto(base);
  await page.getByTestId('menu-quick').waitFor({ timeout: 10_000 });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/sandbox.json', svt.save]);
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-sandbox').click();
  await page.getByTestId('restart-continue').click();
  await page.getByTestId('shift-continue').waitFor({ timeout: 15_000 });
  await page.getByTestId('tab-pause').click();
  await page.getByTestId('shift-continue').click();
  await visible(page, 'visit-decide').waitFor({ timeout: 10_000 });
  const svtCard = (await page.locator('body').innerText()).replace(/\u00a0/g, ' ');
  check(svtCard.includes('комплексы QRS узкие, зубцов P перед ними нет — наджелудочковая тахикардия') && svtCard.includes('Пульс очень частый: 150 в минуту и чаще')
    && svtCard.includes('часто-часто и ровно'),
    `НЖТ: в карте — ЭКГ с узкими комплексами, пульс 150 и чаще, сердцебиение ровно («${svtCard.replace(/\n/g, ' · ').slice(0, 300)}»)`);
  await visible(page, 'result-ecg').scrollIntoViewIfNeeded();
  check((await visible(page, 'result-ecg').boundingBox() ?? { height: 0 }).height > 100, 'НЖТ: ЭКГ — лентой');
  await page.screenshot({ path: join(OUT, '22-svt-card.png'), fullPage: true });
  await visible(page, 'visit-decide').click();
  await visible(page, 'dx-cond.svt').click();
  await visible(page, 'decision-to-plan').click();
  await page.getByTestId('tx-tx.trifosadenine').waitFor({ timeout: 5000 });
  check(!(await page.getByTestId('tx-tx.trifosadenine').isDisabled()), `НЖТ, решение: трифосаденин у постели под монитором — ${await text(page, 'tx-tx.trifosadenine')}`);
  await page.getByTestId('tx-tx.vagal').click();
  await page.getByTestId('tx-tx.trifosadenine').click();
  await page.getByTestId('setting-home').click();
  await page.screenshot({ path: join(OUT, '22-svt-decision.png'), fullPage: true });
  await page.getByTestId('visit-finish').click();
  await page.getByTestId('visit-truth').waitFor({ timeout: 10_000 });
  const svtReview = await page.locator('body').innerText();
  check(svtReview.includes('Пароксизмальная наджелудочковая тахикардия') && !/[Нн]е назначено|не показано|вредно|Недооценили тяжесть/.test(svtReview),
    `НЖТ: вагусные пробы, трифосаденин и дом, разбор — «${svtReview.replace(/\n/g, ' · ').slice(0, 300)}»`);
  await page.screenshot({ path: join(OUT, '22-svt-review.png'), fullPage: true });
  await page.goto(`${base}/encyclopedia/article/cond.svt`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const svtArticle = (await page.locator('body').innerText()).replace(/\u00a0/g, ' ');
  check((await visibleText(page, 'enc-article-title')) === 'Пароксизмальная наджелудочковая тахикардия'
    && svtArticle.includes('Без монитора с дефибриллятором у постели — палата интенсивной терапии.'),
    `энциклопедия, НЖТ: ${await visibleText(page, 'enc-article-title')} — без монитора у постели ПИТ`);
  await page.goto(`${base}/encyclopedia/article/tx.cardioversion`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const cvArticle = (await page.locator('body').innerText()).replace(/\u00a0/g, ' ');
  check(cvArticle.includes('Только при') && cvArticle.includes('Фибрилляция и трепетание предсердий'),
    `энциклопедия, кардиоверсия: спутники — только при фибрилляции предсердий`);

  // АВ-блокада (часть 42в): у вас — полная блокада с широким выскальзывающим ритмом и низким давлением; в
  // карте — ЭКГ с широкими редкими комплексами, пульс реже 50 и давление ниже 90; наружная стимуляция у
  // постели под монитором и «Вызвать скорую» — перевод на кардиостимулятор, разбор без замечаний; в
  // энциклопедии — перевод в центр и до перевода одно из по виду блокады
  const avb = avbSave();
  await page.goto(base);
  await page.getByTestId('menu-quick').waitFor({ timeout: 10_000 });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/sandbox.json', avb.save]);
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-sandbox').click();
  await page.getByTestId('restart-continue').click();
  await page.getByTestId('shift-continue').waitFor({ timeout: 15_000 });
  await page.getByTestId('tab-pause').click();
  await page.getByTestId('shift-continue').click();
  await visible(page, 'visit-decide').waitFor({ timeout: 10_000 });
  const avbCard = (await page.locator('body').innerText()).replace(/\u00a0/g, ' ');
  check(avbCard.includes('комплексы широкие и редкие — полная АВ-блокада') && avbCard.includes('Пульс редкий: реже 50 в минуту')
    && avbCard.includes('Давление низкое: верхнее ниже 90'),
    `АВ-блокада: в карте — ЭКГ с широкими редкими комплексами, пульс реже 50, давление ниже 90 («${avbCard.replace(/\n/g, ' · ').slice(0, 300)}»)`);
  await visible(page, 'result-ecg').scrollIntoViewIfNeeded();
  check((await visible(page, 'result-ecg').boundingBox() ?? { height: 0 }).height > 100, 'АВ-блокада: ЭКГ — лентой');
  await page.screenshot({ path: join(OUT, '23-avb-card.png'), fullPage: true });
  await visible(page, 'visit-decide').click();
  await visible(page, 'dx-cond.av_block').click();
  await visible(page, 'decision-to-plan').click();
  await page.getByTestId('tx-tx.pacing_tc').waitFor({ timeout: 5000 });
  check(!(await page.getByTestId('tx-tx.pacing_tc').isDisabled()) && !(await page.getByTestId('tx-tx.atropine').isDisabled()),
    `АВ-блокада, решение: стимуляция и атропин у постели под монитором — ${await text(page, 'tx-tx.pacing_tc')}`);
  await page.getByTestId('tx-tx.pacing_tc').click();
  await page.getByTestId('setting-ambulance').click();
  await page.screenshot({ path: join(OUT, '23-avb-decision.png'), fullPage: true });
  await page.getByTestId('visit-finish').click();
  await page.getByTestId('visit-truth').waitFor({ timeout: 10_000 });
  const avbReview = await page.locator('body').innerText();
  check(avbReview.includes('АВ-блокада II–III степени') && !/[Нн]е назначено|не показано|вредно|Недооценили тяжесть/.test(avbReview),
    `АВ-блокада: стимуляция и скорая, разбор — «${avbReview.replace(/\n/g, ' · ').slice(0, 300)}»`);
  await page.screenshot({ path: join(OUT, '23-avb-review.png'), fullPage: true });
  await page.goto(`${base}/encyclopedia/article/cond.av_block`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const avbArticle = (await page.locator('body').innerText()).replace(/\u00a0/g, ' ');
  check((await visibleText(page, 'enc-article-title')) === 'АВ-блокада II–III степени' && avbArticle.includes('Обычно — скорая, перевод в центр.')
    && avbArticle.includes('при нестабильной гемодинамике и широких комплексах или Мобитц II — блокаде ниже узла'),
    `энциклопедия, АВ-блокада: ${await visibleText(page, 'enc-article-title')} — перевод в центр, до перевода по виду блокады`);

  // расслоение аорты (часть 43а): у вас — тип B; в карте — КТ-ангиография «расслоение типа B» и срез груди с
  // интимой в нисходящей аорте; морфин и бета-адреноблокатор в вену у постели под монитором, своя ПИТ — разбор
  // без замечаний; в энциклопедии — тип A на перевод, тромболизис опасен
  const ad = adSave();
  await page.goto(base);
  await page.getByTestId('menu-quick').waitFor({ timeout: 10_000 });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/sandbox.json', ad.save]);
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-sandbox').click();
  await page.getByTestId('restart-continue').click();
  await page.getByTestId('shift-continue').waitFor({ timeout: 15_000 });
  await page.getByTestId('tab-pause').click();
  await page.getByTestId('shift-continue').click();
  await visible(page, 'visit-decide').waitFor({ timeout: 10_000 });
  const adCard = (await page.locator('body').innerText()).replace(/\u00a0/g, ' ');
  // давление на обеих руках у этого больного почти одинаковое — без находок оно в «Известно» одной строкой
  check(adCard.includes('Отслоённая интима в нисходящей аорте, два просвета; восходящая не расслоена — расслоение типа B') && adCard.includes('Давление на обеих руках'),
    `расслоение аорты: в карте — КТ-ангиография с типом B и давление на обеих руках («${adCard.replace(/\n/g, ' · ').slice(0, 300)}»)`);
  await visible(page, 'result-ct-chest').scrollIntoViewIfNeeded();
  check((await visible(page, 'result-ct-chest').boundingBox() ?? { height: 0 }).height > 150, 'расслоение аорты: КТ-ангиография — срезом груди');
  await page.screenshot({ path: join(OUT, '24-ad-card.png'), fullPage: true });
  await visible(page, 'visit-decide').click();
  await visible(page, 'dx-cond.aortic_dissection').click();
  await visible(page, 'decision-to-plan').click();
  await page.getByTestId('tx-tx.morphine_iv').waitFor({ timeout: 5000 });
  check(!(await page.getByTestId('tx-tx.morphine_iv').isDisabled()) && !(await page.getByTestId('tx-tx.beta_blocker_iv').isDisabled()),
    `расслоение аорты, решение: морфин и бета-адреноблокатор в вену у постели под монитором — ${await text(page, 'tx-tx.beta_blocker_iv')}`);
  await page.getByTestId('tx-tx.morphine_iv').click();
  await page.getByTestId('tx-tx.beta_blocker_iv').click();
  await page.getByTestId('setting-icu').click();
  await page.screenshot({ path: join(OUT, '24-ad-decision.png'), fullPage: true });
  await page.getByTestId('visit-finish').click();
  await page.getByTestId('visit-truth').waitFor({ timeout: 10_000 });
  const adReview = await page.locator('body').innerText();
  check(adReview.includes('Расслоение аорты') && !/[Нн]е назначено|не показано|вредно|Недооценили тяжесть/.test(adReview),
    `расслоение аорты: морфин, бета-адреноблокатор и ПИТ, разбор — «${adReview.replace(/\n/g, ' · ').slice(0, 300)}»`);
  await page.screenshot({ path: join(OUT, '24-ad-review.png'), fullPage: true });
  await page.goto(`${base}/encyclopedia/article/cond.aortic_dissection`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const adArticle = (await page.locator('body').innerText()).replace(/\u00a0/g, ' ');
  check((await visibleText(page, 'enc-article-title')) === 'Расслоение аорты' && adArticle.includes('При расслоении восходящей аорты (тип A) — скорая, перевод в центр.')
    && adArticle.includes('Тромболизис при инфаркте'),
    `энциклопедия, расслоение аорты: ${await visibleText(page, 'enc-article-title')} — тип A на перевод, тромболизис опасен`);

  // ТЭЛА (часть 43б): у вас — низкий риск; в карте — жалоба на внезапную одышку, КТ-ангиография с дефектами наполнения
  // и срез груди с тромбами, sPESI 0 — «лечить дома»; ПОАК и «Домой» — разбор без замечаний; в энциклопедии — место по
  // sPESI, из кабинета без монитора — в стационар
  const pe = peSave();
  await page.goto(base);
  await page.getByTestId('menu-quick').waitFor({ timeout: 10_000 });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/sandbox.json', pe.save]);
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-sandbox').click();
  await page.getByTestId('restart-continue').click();
  await page.getByTestId('shift-continue').waitFor({ timeout: 15_000 });
  await page.getByTestId('tab-pause').click();
  await page.getByTestId('shift-continue').click();
  await visible(page, 'visit-decide').waitFor({ timeout: 10_000 });
  const peCard = (await page.locator('body').innerText()).replace(/\u00a0/g, ' ');
  check(/Вдруг стало нечем дышать|Резко начала? задыхаться/.test(peCard) && peCard.includes('Дефекты наполнения')
    && peCard.includes('0 баллов: риск низкий — можно лечить дома пероральным антикоагулянтом'),
    `ТЭЛА: в карте — внезапная одышка, тромбы на КТ-ангиографии и sPESI 0 («${peCard.replace(/\n/g, ' · ').slice(0, 300)}»)`);
  await visible(page, 'result-ct-chest').scrollIntoViewIfNeeded();
  check((await visible(page, 'result-ct-chest').boundingBox() ?? { height: 0 }).height > 150, 'ТЭЛА: КТ-ангиография — срезом груди');
  await page.screenshot({ path: join(OUT, '25-pe-card.png'), fullPage: true });
  await visible(page, 'visit-decide').click();
  await visible(page, 'dx-cond.pe').click();
  await visible(page, 'decision-to-plan').click();
  await page.getByTestId('tx-tx.doac').waitFor({ timeout: 5000 });
  await page.getByTestId('tx-tx.doac').click();
  await page.getByTestId('setting-home').click();
  await page.screenshot({ path: join(OUT, '25-pe-decision.png'), fullPage: true });
  await page.getByTestId('visit-finish').click();
  await page.getByTestId('visit-truth').waitFor({ timeout: 10_000 });
  const peReview = await page.locator('body').innerText();
  check(peReview.includes('Тромбоэмболия лёгочной артерии') && !/[Нн]е назначено|не показано|вредно|Недооценили тяжесть/.test(peReview),
    `ТЭЛА низкого риска: ПОАК и «Домой», разбор — «${peReview.replace(/\n/g, ' · ').slice(0, 300)}»`);
  await page.screenshot({ path: join(OUT, '25-pe-review.png'), fullPage: true });
  await page.goto(`${base}/encyclopedia/article/cond.pe`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const peArticle = (await page.locator('body').innerText()).replace(/\u00a0/g, ' ');
  check((await visibleText(page, 'enc-article-title')) === 'Тромбоэмболия лёгочной артерии' && peArticle.includes('При sPESI 1 балл и больше — в стационаре.')
    && peArticle.includes('Без монитора с дефибриллятором у постели — в стационаре.'),
    `энциклопедия, ТЭЛА: ${await visibleText(page, 'enc-article-title')} — место по sPESI, без монитора — в стационар`);

  // острая декомпенсация сердечной недостаточности (часть 43в): у вас — отёк лёгких; в карте — хрипы над всеми полями,
  // NT-proBNP выше порога и снимок груди с «крыльями бабочки»; фуросемид и нитроглицерин в вену, CPAP, НМГ и «В ПИТ» —
  // разбор без замечаний; в энциклопедии — ПИТ по признакам и вред мочегонного у «холодной»
  const hf = adhfSave();
  await page.goto(base);
  await page.getByTestId('menu-quick').waitFor({ timeout: 10_000 });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/sandbox.json', hf.save]);
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-sandbox').click();
  await page.getByTestId('restart-continue').click();
  await page.getByTestId('shift-continue').waitFor({ timeout: 15_000 });
  await page.getByTestId('tab-pause').click();
  await page.getByTestId('shift-continue').click();
  await visible(page, 'visit-decide').waitFor({ timeout: 10_000 });
  const hfCard = (await page.locator('body').innerText()).replace(/\u00a0/g, ' ');
  check(hfCard.includes('NT-proBNP выше порога для возраста') && hfCard.includes('«крыльями бабочки»') && hfCard.includes('Над всеми полями обоих лёгких — влажные хрипы'),
    `ОДСН: в карте — NT-proBNP, отёк лёгких на снимке и хрипы над всеми полями («${hfCard.replace(/\n/g, ' · ').slice(0, 300)}»)`);
  await visible(page, 'result-xray').scrollIntoViewIfNeeded();
  check((await visible(page, 'result-xray').boundingBox() ?? { height: 0 }).height > 150, 'ОДСН: рентген груди — снимком');
  await page.screenshot({ path: join(OUT, '26-adhf-card.png'), fullPage: true });
  await visible(page, 'visit-decide').click();
  await visible(page, 'dx-cond.adhf').click();
  await visible(page, 'decision-to-plan').click();
  for (const tx of ['tx.furosemide_iv', 'tx.nitroglycerin_iv', 'tx.cpap', 'tx.lmwh']) {
    await page.getByTestId(`tx-${tx}`).waitFor({ timeout: 5000 });
    await page.getByTestId(`tx-${tx}`).click();
  }
  await page.getByTestId('setting-icu').click();
  await page.screenshot({ path: join(OUT, '26-adhf-decision.png'), fullPage: true });
  await page.getByTestId('visit-finish').click();
  await page.getByTestId('visit-truth').waitFor({ timeout: 10_000 });
  const hfReview = await page.locator('body').innerText();
  check(hfReview.includes('Острая декомпенсация сердечной недостаточности') && !/[Нн]е назначено|не показано|вредно|Недооценили тяжесть/.test(hfReview),
    `ОДСН с отёком лёгких: фуросемид, нитроглицерин, CPAP, НМГ и ПИТ, разбор — «${hfReview.replace(/\n/g, ' · ').slice(0, 300)}»`);
  await page.screenshot({ path: join(OUT, '26-adhf-review.png'), fullPage: true });
  await page.goto(`${base}/encyclopedia/article/cond.adhf`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const hfArticle = (await page.locator('body').innerText()).replace(/\u00a0/g, ' ');
  check((await visibleText(page, 'enc-article-title')) === 'Острая декомпенсация сердечной недостаточности'
    && hfArticle.includes('При отёке лёгких, гипоперфузии, частоте дыхания выше 25 или сатурации ниже 90 % — палата интенсивной терапии.')
    && hfArticle.includes('при гипоперфузии — холодной влажной коже'),
    `энциклопедия, ОДСН: ${await visibleText(page, 'enc-article-title')} — ПИТ по признакам, лечение по формам`);

  // гипертонический криз (часть 43г): у вас — энцефалопатия; в карте — «Давление очень высокое: 180/110 и выше»,
  // оглушение по шкале Глазго и глазное дно; препарат в вену и «В ПИТ» — разбор без замечаний; в энциклопедии — ПИТ у
  // криза, у подъёма без поражения органов — дома, а препарат в вену опасен
  const htn = crisisSave();
  await page.goto(base);
  await page.getByTestId('menu-quick').waitFor({ timeout: 10_000 });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/sandbox.json', htn.save]);
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-sandbox').click();
  await page.getByTestId('restart-continue').click();
  await page.getByTestId('shift-continue').waitFor({ timeout: 15_000 });
  await page.getByTestId('tab-pause').click();
  await page.getByTestId('shift-continue').click();
  await visible(page, 'visit-decide').waitFor({ timeout: 10_000 });
  const htnCard = (await page.locator('body').innerText()).replace(/\u00a0/g, ' ');
  check(htnCard.includes('Давление очень высокое: 180/110 и выше') && htnCard.includes('умеренное оглушение') && /[Гг]лазно[ем] дн/.test(htnCard),
    `Криз: в карте — давление 180/110 и выше, оглушение и глазное дно («${htnCard.replace(/\n/g, ' · ').slice(0, 300)}»)`);
  await page.screenshot({ path: join(OUT, '27-crisis-card.png'), fullPage: true });
  await visible(page, 'visit-decide').click();
  await visible(page, 'dx-cond.hypertensive_crisis').click();
  await visible(page, 'decision-to-plan').click();
  await page.getByTestId('tx-tx.bp_iv').waitFor({ timeout: 5000 });
  await page.getByTestId('tx-tx.bp_iv').click();
  await page.getByTestId('setting-icu').click();
  await page.screenshot({ path: join(OUT, '27-crisis-decision.png'), fullPage: true });
  await page.getByTestId('visit-finish').click();
  await page.getByTestId('visit-truth').waitFor({ timeout: 10_000 });
  const htnReview = await page.locator('body').innerText();
  check(htnReview.includes('Гипертонический криз') && !/[Нн]е назначено|не показано|вредно|Недооценили тяжесть|Обоснованность [CD]/.test(htnReview),
    `Криз с энцефалопатией: препарат в вену и ПИТ, разбор — «${htnReview.replace(/\n/g, ' · ').slice(0, 300)}»`);
  await page.screenshot({ path: join(OUT, '27-crisis-review.png'), fullPage: true });
  await page.goto(`${base}/encyclopedia/article/cond.hypertensive_crisis`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const htnArticle = (await page.locator('body').innerText()).replace(/\u00a0/g, ' ');
  check((await visibleText(page, 'enc-article-title')) === 'Гипертонический криз' && htnArticle.includes('Обычно — палата интенсивной терапии.')
    && htnArticle.includes('При гипертонической энцефалопатии без действенного лечения'),
    `энциклопедия, криз: ${await visibleText(page, 'enc-article-title')} — ПИТ, течение по формам`);
  await page.goto(`${base}/encyclopedia/article/cond.bp_uncontrolled`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const urgencyArticle = (await page.locator('body').innerText()).replace(/\u00a0/g, ' ');
  check((await visibleText(page, 'enc-article-title')) === 'Подъём давления без поражения органов' && urgencyArticle.includes('Обычно — дома.')
    && urgencyArticle.includes('Снижение давления препаратом в вену'),
    `энциклопедия, подъём без поражения органов: ${await visibleText(page, 'enc-article-title')} — дома, препарат в вену в «Опасно»`);

  // хирургия живота (spec 2026-09-chapter-2, часть 30): со смотровой приёмного больница принимает
  // и хирургию — у вас больной острым холециститом; УЗИ — желчный пузырь с камнями и толстой
  // стенкой; в выборе диагноза — колика, холецистит, панкреатит; в энциклопедии — срок операции
  const gall = gallSave();
  await page.goto(base);
  await page.getByTestId('menu-quick').waitFor({ timeout: 10_000 });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/sandbox.json', gall.save]);
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-sandbox').click();
  await page.getByTestId('restart-continue').click();
  await page.getByTestId('shift-continue').waitFor({ timeout: 15_000 });
  await page.getByTestId('tab-pause').click();
  await page.getByTestId('shift-continue').click();
  await visible(page, 'result-us').waitFor({ timeout: 10_000 });
  await visible(page, 'result-us').scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  const gbBox = await visible(page, 'result-us').boundingBox();
  const gbStones = await page.locator('text=конкременты с акустической тенью').first().isVisible().catch(() => false);
  const gbWall = await page.locator('text=Стенка желчного пузыря утолщена').first().isVisible().catch(() => false);
  check(gbBox !== null && gbBox.height > 150 && gbStones && gbWall,
    `холецистит: УЗИ — сектором ${Math.round(gbBox?.width ?? 0)} × ${Math.round(gbBox?.height ?? 0)}, строки «конкременты с акустической тенью» и «стенка утолщена»`);
  await page.screenshot({ path: join(OUT, '19-gall-us.png'), fullPage: true });
  await visible(page, 'visit-decide').click();
  await visible(page, 'dx-cond.cholecystitis').waitFor({ timeout: 10_000 });
  const surgicalDx = (await Promise.all(['cond.cholecystitis', 'cond.biliary_colic', 'cond.pancreatitis'].map(id => visible(page, `dx-${id}`).count()))).every(n => n === 1);
  check(surgicalDx && (await visible(page, 'dx-cond.cholelithiasis').count()) === 0, 'холецистит: в выборе диагноза — желчная колика, острый холецистит, острый панкреатит; камни без приступа — нет');
  const ulcerDx = (await Promise.all(['cond.perforated_ulcer', 'cond.ulcer_bleeding', 'cond.strangulated_hernia'].map(id => visible(page, `dx-${id}`).count()))).every(n => n === 1);
  check(ulcerDx, 'хирургия живота (0.0.49): в выборе диагноза — прободная язва, язвенное кровотечение, ущемлённая паховая грыжа');
  check((await visible(page, 'dx-cond.adhesive_sbo').count()) === 1, 'хирургия живота (0.0.50): в выборе диагноза — спаечная кишечная непроходимость');
  const colicDx = (await Promise.all(['cond.renal_colic', 'cond.paraproctitis'].map(id => visible(page, `dx-${id}`).count()))).every(n => n === 1);
  check(colicDx, 'хирургия приёмного (0.0.51): в выборе диагноза — почечная колика и острый парапроктит');
  check((await visible(page, 'dx-cond.diverticulitis').count()) === 1, 'хирургия приёмного (0.0.52): в выборе диагноза — острый дивертикулит');
  await visible(page, 'dx-cond.cholecystitis').click();
  await page.screenshot({ path: join(OUT, '19-gall-decision.png'), fullPage: true });
  await visible(page, 'decision-to-plan').click();
  await visible(page, 'decision-diagnosis').waitFor({ timeout: 5000 });
  check((await visibleText(page, 'decision-diagnosis')).includes('Острый холецистит'), `холецистит: диагноз — ${await visibleText(page, 'decision-diagnosis')}`);
  await page.goto(`${base}/encyclopedia/article/cond.cholecystitis`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const window72 = await page.locator('text=в первые 72\u00a0ч от начала болезни').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'Острый холецистит' && window72, `энциклопедия, холецистит: ${await visibleText(page, 'enc-article-title')} — операция в первые 72 ч от начала болезни`);
  await page.goto(`${base}/encyclopedia/article/cond.pancreatitis`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  check((await visibleText(page, 'enc-article-title')) === 'Острый панкреатит', `энциклопедия, панкреатит: ${await visibleText(page, 'enc-article-title')}`);
  // прободная язва (0.0.49): операция в первые 2 ч, позже суток — давняя перфорация; у ушивания —
  // цена каждого часа ожидания
  await page.goto(`${base}/encyclopedia/article/cond.perforated_ulcer`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const window2 = await page.locator('text=в первые 2\u00a0ч после поступления').first().isVisible().catch(() => false);
  const after24 = await page.locator('text=Позже 24\u00a0ч от начала болезни — давняя перфорация').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'Прободная язва' && window2 && after24,
    `энциклопедия, прободная язва: ${await visibleText(page, 'enc-article-title')} — ушивание в первые 2 ч, позже суток — давняя перфорация`);
  await page.goto(`${base}/encyclopedia/article/tx.ulcer_suture`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const perHour = await page.locator('text=Каждый час от поступления до операции выживаемость ниже на 2,4\u00a0%.').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'Ушивание прободной язвы' && perHour, 'энциклопедия, ушивание: каждый час ожидания — выживаемость ниже на 2,4 %');
  // спаечная непроходимость (0.0.50): без показаний к экстренной — в палате, операция не позже 72 ч;
  // некроз — при ишемии кишки через 6 ч; у грыжи условие словами, а не «yes»
  await page.goto(`${base}/encyclopedia/article/cond.adhesive_sbo`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const observe72 = await page.locator('text=не помогло — операция не позже 72\u00a0ч после поступления').first().isVisible().catch(() => false);
  const necrosis = await page.locator('text=При ишемии кишки позже 6\u00a0ч от начала болезни — некроз кишки.').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'Спаечная кишечная непроходимость' && observe72 && necrosis,
    `энциклопедия, непроходимость: ${await visibleText(page, 'enc-article-title')} — наблюдение до 72 ч, некроз при ишемии через 6 ч`);
  await page.goto(`${base}/encyclopedia/article/cond.strangulated_hernia`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const herniaWhen = await page.locator('text=при непроходимости кишки').first().isVisible().catch(() => false);
  const herniaYes = await page.locator('text=(yes)').count();
  check(herniaWhen && herniaYes === 0, 'энциклопедия, ущемлённая грыжа: условие словами — «при непроходимости кишки», без «yes»');
  // почечная колика и парапроктит (0.0.51): колика — дома, с инфекцией — перевод, беременная — в
  // стационар; парапроктит — операция в первые 12 ч; УЗИ почек — в кабинете УЗИ
  await page.goto(`${base}/encyclopedia/article/cond.renal_colic`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const colicTransfer = await page.locator('text=При инфекции мочевых путей — скорая, перевод в центр.').first().isVisible().catch(() => false);
  const colicPregnancy = await page.locator('text=Если есть «Беременность» — в стационаре.').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'Почечная колика' && colicTransfer && colicPregnancy && (await page.locator('text=(yes)').count()) === 0,
    `энциклопедия, почечная колика: ${await visibleText(page, 'enc-article-title')} — с инфекцией перевод, беременная — в стационар`);
  await page.goto(`${base}/encyclopedia/article/cond.paraproctitis`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const drainage12 = await page.locator('text=Операция — вскрытие и дренирование парапроктита: в первые 12\u00a0ч после поступления.').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'Острый парапроктит' && drainage12, 'энциклопедия, парапроктит: вскрытие и дренирование в первые 12 ч');
  await page.goto(`${base}/encyclopedia/article/exam.us_kidney`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const usRoom = await page.locator('text=Кабинет УЗИ').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'УЗИ почек и мочевых путей' && usRoom, 'энциклопедия, УЗИ почек: делают в кабинете УЗИ');
  // дивертикулит (0.0.52): где лечить — по форме, неосложнённый проходит сам; у операции — фамилия с большой буквы
  await page.goto(`${base}/encyclopedia/article/cond.diverticulitis`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const bigAbscess = await page.locator('text=При абсцессе больше 3\u00a0см — скорая, перевод в центр.').first().isVisible().catch(() => false);
  const selfHeals = await page.locator('text=При неосложнённом — обычно проходит само.').first().isVisible().catch(() => false);
  const hartmann = await page.locator('text=Операция — резекция по Гартману: в первые 2\u00a0ч после поступления.').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'Острый дивертикулит' && bigAbscess && selfHeals && hartmann,
    `энциклопедия, дивертикулит: ${await visibleText(page, 'enc-article-title')} — большой абсцесс переводят, неосложнённый проходит сам, резекция по Гартману в первые 2 ч`);

  // энциклопедия: раздел «Шкалы», статья NEWS2 — баллы по показателям
  await page.goto(`${base}/encyclopedia/article/score.news2`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  check((await visibleText(page, 'enc-article-title')).startsWith('NEWS2'), `энциклопедия, шкала: ${await visibleText(page, 'enc-article-title')}`);
  // травма (0.0.54): правило решения — в «Шкалах и правилах»; у перелома — тактика по смещению
  await page.goto(`${base}/encyclopedia/article/rule.ottawa_ankle`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const snapNeeded = await page.locator('text=Снимок нужен').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'Оттавские правила для голеностопа' && snapNeeded,
    `энциклопедия, правило: ${await visibleText(page, 'enc-article-title')} — «снимок нужен»`);
  await page.goto(`${base}/encyclopedia/article/cond.distal_radius_fracture`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const byShift = await page.locator('text=Первая линия, при смещении').first().isVisible().catch(() => false);
  const unstableOp = await page.locator('text=При нестабильном переломе — операция.').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'Перелом дистального отдела лучевой кости' && byShift && unstableOp,
    `энциклопедия, перелом лучевой: ${await visibleText(page, 'enc-article-title')} — репозиция при смещении, нестабильный — операция`);
  // травма (0.0.55): операция по смещению — у шейки бедра; правило для стопы
  await page.goto(`${base}/encyclopedia/article/cond.femoral_neck_fracture`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const hipWindow = await page.locator('text=Операция — эндопротезирование тазобедренного сустава: в первые 48 ч после поступления.').first().isVisible().catch(() => false);
  const hipScrews = await page.locator('text=Без смещения — остеосинтез шейки бедра винтами.').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'Перелом шейки бедра' && hipWindow && hipScrews,
    `энциклопедия, перелом шейки бедра: ${await visibleText(page, 'enc-article-title')} — эндопротез в первые 48 ч, без смещения — винты`);
  await page.goto(`${base}/encyclopedia/article/rule.ottawa_foot`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const footSnap = await page.locator('text=Снимок стопы нужен').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'Оттавские правила для стопы' && footSnap,
    `энциклопедия, правило для стопы: ${await visibleText(page, 'enc-article-title')} — «снимок стопы нужен»`);
  // травма груди (0.2.0): место по количеству крови и по числу рёбер
  await page.goto(`${base}/encyclopedia/article/cond.traumatic_hemothorax`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const massive = await page.locator('text=При большом гемотораксе — операция.').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'Травматический гемоторакс' && massive,
    `энциклопедия, гемоторакс: ${await visibleText(page, 'enc-article-title')} — «при большом гемотораксе — операция»`);
  await page.goto(`${base}/encyclopedia/article/cond.rib_fracture`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const three = await page.locator('text=При переломе трёх и более рёбер — в стационаре.').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'Перелом рёбер' && three,
    `энциклопедия, перелом рёбер: ${await visibleText(page, 'enc-article-title')} — «при переломе трёх и более рёбер — в стационаре»`);
  // травма головы (0.2.1): правило КТ с дополнительными признаками; место — по показаниям к КТ
  await page.goto(`${base}/encyclopedia/article/rule.ct_head`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const twoMinor = await page.locator('text=Или не меньше двух из этих').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'КТ при лёгкой черепно-мозговой травме' && twoMinor,
    `энциклопедия, правило КТ: ${await visibleText(page, 'enc-article-title')} — «или не меньше двух из этих»`);
  await page.goto(`${base}/encyclopedia/article/cond.concussion`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const ctTransfer = await page.locator('text=При показаниях к КТ — скорая, перевод в центр.').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'Сотрясение головного мозга' && ctTransfer,
    `энциклопедия, сотрясение: ${await visibleText(page, 'enc-article-title')} — «при показаниях к КТ — скорая, перевод в центр»`);
  // раны (0.2.2): перерезанное сухожилие — перевод; обязательная профилактика при укусе
  await page.goto(`${base}/encyclopedia/article/cond.hand_wound`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const tendon = await page.locator('text=При перерезанном сухожилии — скорая, перевод в центр.').first().isVisible().catch(() => false);
  const prevent = await page.locator('text=Обязательная профилактика, при укусе').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'Открытая рана кисти' && tendon && prevent,
    `энциклопедия, рана кисти: ${await visibleText(page, 'enc-article-title')} — перевод при перерезанном сухожилии, профилактика при укусе`);
  // колено (0.2.3): возраст «55 лет и старше» — признак правила; перелом надколенника со смещением — операция
  await page.goto(`${base}/encyclopedia/article/rule.ottawa_knee`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const kneeAge = await page.locator('text=Возраст 55 лет и старше — тоже основной признак.').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'Оттавские правила для колена' && kneeAge,
    `энциклопедия, правило для колена: ${await visibleText(page, 'enc-article-title')} — «возраст 55 лет и старше — тоже основной признак»`);
  await page.goto(`${base}/encyclopedia/article/cond.patella_fracture`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const patellaOp = await page.locator('text=При смещении — операция.').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'Перелом надколенника' && patellaOp,
    `энциклопедия, перелом надколенника: ${await visibleText(page, 'enc-article-title')} — «при смещении — операция»`);
  // ожог (0.2.4): при обширном — перевод в центр, до приезда скорой — капельница
  await page.goto(`${base}/encyclopedia/article/cond.burn`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const burnWhere = await page.locator('text=При обширном ожоге — скорая, перевод в центр.').first().isVisible().catch(() => false);
  const burnDrip = await page.locator('text=До приезда скорой, при обширном ожоге').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'Термический ожог' && burnWhere && burnDrip,
    `энциклопедия, ожог: ${await visibleText(page, 'enc-article-title')} — перевод при обширном, «до приезда скорой» — капельница`);
  // вены ног (0.2.5): правило Уэллса — когда его не применяют; ТГВ — перевод при подвздошно-бедренном
  // и антикоагулянт до приезда скорой
  await page.goto(`${base}/encyclopedia/article/rule.wells_dvt`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const wellsNa = await page.locator('text=Не применяют, если есть').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'Шкала Уэллса и D-димер при боли в ноге' && wellsNa,
    `энциклопедия, шкала Уэллса: ${await visibleText(page, 'enc-article-title')} — «не применяют, если есть»`);
  await page.goto(`${base}/encyclopedia/article/cond.dvt`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const dvtWhere = await page.locator('text=При подвздошно-бедренном тромбозе — скорая, перевод в центр.').first().isVisible().catch(() => false);
  const dvtPre = await page.locator('text=До приезда скорой, при подвздошно-бедренном тромбозе').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'Тромбоз глубоких вен ноги' && dvtWhere && dvtPre,
    `энциклопедия, ТГВ: ${await visibleText(page, 'enc-article-title')} — перевод при подвздошно-бедренном, «до приезда скорой» — антикоагулянт`);
  // неотложное (0.2.6): ишемия ноги — путают с тромбозом вен, первая линия — гепарин; анафилактический
  // шок — эпинефрин; носовое кровотечение — при заднем источнике перевод
  await page.goto(`${base}/encyclopedia/article/cond.limb_ischemia`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const aliDvt = await page.locator('text=Тромбоз глубоких вен ноги').first().isVisible().catch(() => false);
  const aliHeparin = await page.locator('text=Гепарин натрия в вену').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'Острая ишемия ноги' && aliDvt && aliHeparin,
    `энциклопедия, ишемия ноги: ${await visibleText(page, 'enc-article-title')} — «с чем спутать» — тромбоз вен, первая линия — гепарин`);
  await page.goto(`${base}/encyclopedia/article/cond.anaphylaxis`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const anaEpi = await page.locator('text=Эпинефрин в мышцу бедра').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'Анафилактический шок' && anaEpi,
    `энциклопедия, анафилактический шок: ${await visibleText(page, 'enc-article-title')} — эпинефрин в мышцу бедра`);
  await page.goto(`${base}/encyclopedia/article/cond.epistaxis`);
  await visible(page, 'enc-article-title').waitFor({ timeout: 10_000 });
  const noseWhere = await page.locator('text=При источнике в задних отделах носа — скорая, перевод в центр.').first().isVisible().catch(() => false);
  check((await visibleText(page, 'enc-article-title')) === 'Носовое кровотечение' && noseWhere,
    `энциклопедия, носовое кровотечение: ${await visibleText(page, 'enc-article-title')} — при заднем источнике перевод`);

  // кампания: карьера 1 → глава 1 — письма и задания; письмо наставника; смена открывается;
  // «Продолжить» в меню — карьера (spec 2026-09-campaign)
  await page.goto(base);
  await page.getByTestId('menu-campaign').click();
  await page.getByTestId('career-1').waitFor({ timeout: 10_000 });
  await page.getByTestId('career-1').click();
  // при начале карьеры — тот же «мягкий режим», что в настройках
  check((await page.getByTestId('career-soft').getAttribute('aria-checked')) === 'false', 'кампания: при начале карьеры — «Мягкий режим», выключен');
  await page.getByTestId('career-begin').click();
  await page.getByTestId('chapter').waitFor({ timeout: 10_000 });
  check((await text(page, 'chapter')).startsWith('Глава 1. Участок') && (await page.locator('[data-testid^="mission-"]').count()) === 5,
    `кампания: глава 1 — ${(await text(page, 'chapter-day'))}, заданий ${await page.locator('[data-testid^="mission-"]').count()}`);
  await page.getByTestId('letter-hello').click();
  await page.getByTestId('letter-text').waitFor({ timeout: 5000 });
  check((await text(page, 'letter-text')).startsWith('Здравствуйте, коллега'), 'кампания: письмо наставника');
  await page.screenshot({ path: join(OUT, '15-campaign-letter.png') });
  await page.getByTestId('letter-sheet-close').click();
  await page.getByTestId('letter-sheet').waitFor({ state: 'detached', timeout: 5000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, '15-campaign-chapter.png'), fullPage: true });
  await page.getByTestId('sandbox-open').click();
  await skipToFirst(page);
  check(await page.getByTestId('clinic-map').isVisible(), 'кампания: смена в амбулатории посёлка');
  // первая смена главы — с наставником: подсказки по одной, в первой — «Без подсказок»
  const gotIt = async () => {
    await page.getByTestId('tip-sheet-close').click();
    await page.getByTestId('tip-sheet').waitFor({ state: 'detached', timeout: 5000 });
  };
  await page.getByTestId('shift-call').click();
  await page.getByTestId('tip-text').waitFor({ timeout: 15_000 });
  check((await text(page, 'tip-text')).startsWith('Начните с жалоб') && await page.getByTestId('tip-off').isVisible(),
    'кампания: карта открылась — подсказка наставника «Сначала — расспрос», в первой — «Без подсказок»');
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(OUT, '16-campaign-tip.png') });
  await gotIt();
  await page.getByTestId('exam-exam.ask_onset').click();
  // у пациентки с циститом или пациента с ангиной после первого вопроса — своя подсказка
  await page.waitForTimeout(700);
  if (await page.getByTestId('tip-sheet').count()) await gotIt();
  await page.getByTestId('exam-exam.ask_general').click();
  await page.getByTestId('tip-text').waitFor({ timeout: 5000 });
  check((await text(page, 'tip-text')).startsWith('Расспросили — осмотрите') && (await page.getByTestId('tip-off').count()) === 0,
    'кампания: два вопроса без осмотра — «Теперь — осмотр»');
  await gotIt();
  await page.getByTestId('visit-decide').click();
  await page.getByTestId('tip-text').waitFor({ timeout: 5000 });
  check((await text(page, 'tip-text')).startsWith('Решение — в два шага'), 'кампания: первое «Решение» — подсказка');
  await gotIt();
  await page.locator('[data-testid^="hint-"]').first().click();
  await page.getByTestId('decision-to-plan').click();
  await page.getByTestId('setting-home').click();
  await page.getByTestId('visit-finish').click();
  await page.getByTestId('tip-text').waitFor({ timeout: 10_000 });
  check((await text(page, 'tip-text')).startsWith('Сравните свой путь'), 'кампания: первый разбор — подсказка');
  await gotIt();
  check(await page.getByTestId('visit-truth').isVisible(), 'кампания: подсказка закрыта — итог приёма на месте');
  await page.goto(base);
  await page.getByTestId('menu-continue').waitFor({ timeout: 10_000 });
  check((await text(page, 'menu-continue')).includes('Карьера 1: Глава 1. Участок'), `меню: «Продолжить» — ${(await text(page, 'menu-continue')).replace(/\n/g, ' · ')}`);

  // глава 2 (spec 2026-09-chapter-2, часть 34): карьера 2 с выполненной главой 1 — «Перейти в
  // районную больницу», лист перехода; глава 2 — письма и задания; смена — в районной больнице
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/campaign-2.json', chapterDoneSave()]);
  await page.goto(base);
  await page.getByTestId('menu-campaign').click();
  await page.getByTestId('career-2').waitFor({ timeout: 10_000 });
  check((await text(page, 'career-2')).includes('Глава 1. Участок · день 3 · основные задания: 3 из 3'), `глава 2: карьера 2 — ${(await text(page, 'career-2')).replace(/\n/g, ' · ')}`);
  await page.getByTestId('career-2').click();
  await page.getByTestId('career-continue').click();
  // итоги дня 3 — «Выполнено» и глава с кнопкой перехода
  await page.getByTestId('chapter-next').waitFor({ timeout: 10_000 });
  check((await text(page, 'summary-campaign')).includes('Выполнено: Три дня подряд без антибиотика'), 'глава 1: в итогах дня — выполненное задание');
  check((await text(page, 'chapter-complete')).includes('или перейти в следующую главу') && (await text(page, 'chapter-next')).startsWith('Перейти в районную больницу'),
    `глава 1 выполнена: ${(await text(page, 'chapter-next')).replace(/\n/g, ' · ')}`);
  await page.getByTestId('chapter-next').click();
  await page.getByTestId('chapter-next-text').waitFor({ timeout: 5000 });
  check((await text(page, 'chapter-next-text')).includes('амбулатория в посёлке Заречный — останется в «Смене»'), 'глава 2: лист перехода — что будет новым, что останется');
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, '15-chapter2-move.png') });
  await page.getByTestId('chapter-next-yes').click();
  await page.getByTestId('chapter-next-sheet').waitFor({ state: 'detached', timeout: 5000 });
  await page.waitForTimeout(500);
  check((await text(page, 'chapter')).startsWith('Глава 2. Приёмное') && (await text(page, 'chapter-day')).startsWith('районная больница в Нижнеборске · перед первой сменой')
    && (await page.locator('[data-testid^="mission-"]').count()) === 5 && (await page.getByTestId('chapter-next').count()) === 0,
    `глава 2: ${(await text(page, 'chapter-day'))}, заданий ${await page.locator('[data-testid^="mission-"]').count()}`);
  check((await text(page, 'mission-triage')).includes('лучшая смена: 0 из 4') && (await text(page, 'mission-stay')).includes('0 из 10'), 'глава 2: ход заданий — скорая, выписанные подряд');
  // после перехода — экран главы с новой больницей, а не итоги прежней
  check((await page.getByTestId('summary-seen').count()) === 0 && (await text(page, 'sandbox-summary')).includes('600\u00a0000'),
    `глава 2: перед первой сменой — ${(await text(page, 'sandbox-summary'))}`);
  await page.getByTestId('letter-surgeon').click();
  await page.getByTestId('letter-text').waitFor({ timeout: 5000 });
  check((await text(page, 'letter-text')).startsWith('Здравствуйте. Я заведую хирургией') && (await text(page, 'letter-sheet')).includes('А. И. Зорин'), 'глава 2: письмо заведующего хирургией');
  await page.screenshot({ path: join(OUT, '15-chapter2-letter.png') });
  await page.getByTestId('letter-sheet-close').click();
  await page.getByTestId('letter-sheet').waitFor({ state: 'detached', timeout: 5000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, '15-chapter2.png'), fullPage: true });
  await page.getByTestId('sandbox-open').click();
  await page.getByTestId('clinic-map').waitFor({ timeout: 10_000 });
  check(await page.getByTestId('clinic-map').isVisible(), 'глава 2: смена в районной больнице');
  // первая смена с наставником (часть 34б), сценарий chapter2: скорая → подсказка → сортировка →
  // смотровая → подсказка заведующего хирургией → «В операционную» → палата → обход с подсказкой
  const tipShown = async () => (await page.getByTestId('tip-text').count()) > 0;
  const gotTip = async () => {
    await page.getByTestId('tip-sheet-close').click();
    await page.getByTestId('tip-sheet').waitFor({ state: 'detached', timeout: 5000 });
  };
  // первая скорая с подсказкой может приехать и раньше нажатия
  await fastClock(page);
  check(await runClockUntil(page, tipShown), 'глава 2: первая скорая — в первые минуты смены');
  check((await text(page, 'tip-text')).startsWith('Скорая привезла человека — сначала лист передачи'), 'глава 2: привезли — подсказка «Лист передачи»');
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(OUT, '15-chapter2-tip.png') });
  await gotTip();
  await page.getByTestId('tab-pause').click();
  // привезённого зовём по имени в очереди: пришедший сам «красный» мог встать раньше
  const ambId = (await page.locator('[data-testid^="ambulance-"]').first().getAttribute('data-testid'))!.replace('ambulance-', '');
  await page.getByTestId(`ambulance-${ambId}`).click();
  await page.getByTestId('handover-reason').waitFor({ timeout: 5000 });
  await page.getByTestId('sort-red').click();
  await page.getByTestId('handover-sheet').waitFor({ state: 'detached', timeout: 5000 });
  await page.getByTestId(`queue-${ambId}`).waitFor({ timeout: 10_000 });
  await page.getByTestId(`queue-${ambId}`).click();
  await page.getByTestId('exam-exam.ask_onset').waitFor({ timeout: 30_000 });
  await page.getByTestId('exam-exam.ask_onset').click();
  await page.getByTestId('tip-text').waitFor({ timeout: 5000 });
  check((await text(page, 'tip-text')).startsWith('При подозрении на аппендицит решает время') && (await text(page, 'tip-sheet')).includes('А. И. Зорин'),
    'глава 2: у привезённого с аппендицитом — подсказка заведующего хирургией');
  await gotTip();
  await visible(page, 'visit-decide').click();
  await page.getByTestId('dx-cond.appendicitis').click();
  await page.getByTestId('decision-to-plan').click();
  await page.getByTestId('setting-surgery').click();
  await page.getByTestId('visit-finish').click();
  await page.getByTestId('visit-outcome').waitFor({ timeout: 10_000 });
  check((await text(page, 'visit-outcome')).includes('В операционную, после операции — в палату'), 'глава 2: аппендицит — в операционную, после операции — в палату');
  await page.getByTestId('shift-to-queue').click();
  await page.getByTestId('rounds-open').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, '15-chapter2-shift.png') });
  await page.getByTestId('rounds-open').click();
  await page.getByTestId('tip-text').waitFor({ timeout: 10_000 });
  check((await text(page, 'tip-text')).startsWith('На обходе смотрите не на число суток'), 'глава 2: первый обход — подсказка «Обход»');
  await gotTip();
  check((await page.locator('[data-testid^="round-op-"]').count()) === 1, 'глава 2: на обходе — оперированный');
  await page.goBack();

  // «Случай дня»: последние 30 дней, приём, разбор, отметка в списке (spec 2026-09-campaign, часть 14)
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-daily').click();
  await page.getByTestId('daily-base').waitFor({ timeout: 10_000 });
  const days = page.locator('[data-testid^="daily-20"]');
  const today = days.first();
  check((await days.count()) === 30 && (await today.innerText()).startsWith('Сегодня'), `случай дня: последние ${await days.count()} дней, сегодня первым`);
  await today.click();
  await page.getByTestId('exam-exam.ask_complaints').waitFor({ timeout: 10_000 });
  await page.getByTestId('exam-exam.ask_complaints').click();
  await page.getByTestId('visit-decide').click();
  await page.locator('[data-testid^="hint-"]').first().click();
  await page.getByTestId('decision-to-plan').click();
  await page.getByTestId('setting-home').click();
  await page.getByTestId('visit-finish').click();
  await page.getByTestId('visit-truth').waitFor({ timeout: 10_000 });
  check((await text(page, 'visit-truth')).startsWith('На самом деле:'), `случай дня: разбор — ${await text(page, 'visit-truth')}`);
  await page.getByTestId('daily-to-list').click();
  await page.getByTestId('daily-base').waitFor({ timeout: 10_000 });
  check((await today.innerText()).includes('Сыгран: '), `случай дня: в списке — ${(await today.innerText()).replace(/\n/g, ' · ')}`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, '17-daily.png') });

  // «Смена»: больница главы открыта (карьера есть), своя — есть песочница; смена в посёлке из
  // сохранения в конце дня — «Продолжить», закрыть день, итог по категориям, лучший результат
  await page.goto(base);
  await page.getByTestId('menu-quick').click();
  await page.getByTestId('menu-single').click();
  await page.getByTestId('venue-preset.clinic').waitFor({ timeout: 10_000 });
  // районная больница — с тех пор как карьера 2 перешла в главу 2
  check(!(await page.getByTestId('venue-preset.village').isDisabled()) && !(await page.getByTestId('venue-preset.district').isDisabled())
    && (await page.locator('[data-testid^="venue-"]').count()) === 4,
    `смена: больницы — практика, посёлок, районная, своя (${(await text(page, 'venue-sandbox')).replace(/\n/g, ' · ')})`);
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/single.json', singleEndOfDaySave()]);
  await page.goto(base);
  await page.getByTestId('menu-continue').waitFor({ timeout: 10_000 });
  check((await text(page, 'menu-continue')).includes('смена: Амбулатория в посёлке'), `меню: «Продолжить» — ${(await text(page, 'menu-continue')).replace(/\n/g, ' · ')}`);
  await page.getByTestId('menu-continue').click();
  await page.getByTestId('shift-close-day').waitFor({ timeout: 15_000 });
  await page.getByTestId('shift-close-day').click();
  await page.getByTestId('single-result').waitFor({ timeout: 10_000 });
  check((await page.getByTestId('single-accuracy').count()) === 1 && (await page.getByTestId('single-speed').count()) === 1 && /^[ABCD]$/.test(await text(page, 'single-overall'))
    && (await text(page, 'single-best')) === 'Лучший результат в этой больнице.', `смена: итог — ${(await text(page, 'single-result')).replace(/\n/g, ' · ')}`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, '18-single.png'), fullPage: true });
  check(await page.getByTestId('single-again').isVisible() && (await page.getByTestId('shift-next-day').count()) === 0, 'смена: в итогах — «Новая смена», следующего дня нет');

  // конец дня из сохранения: закрыть день, итоги, разбор случая из итогов, следующий день
  const day = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 });
  await day.addInitScript(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/shift.json', endOfDaySave()]);
  const p2 = await day.newPage();
  p2.on('pageerror', e => errors.push(String(e)));
  await p2.goto(`${base}/shift`);
  await p2.getByTestId('shift-close-day').waitFor({ timeout: 15_000 });
  const late = await text(p2, 'shift-clock');
  check(late >= '15:00', `сохранение смены читается: день 1, ${late}, все приняты — «Закрыть день»`);
  await p2.getByTestId('shift-close-day').click();
  await p2.getByTestId('summary-seen').waitFor({ timeout: 10_000 });
  const seen = await text(p2, 'summary-seen');
  check(/^Принято: \d+ из \d+$/.test(seen), `итоги дня: ${seen}`);
  await p2.screenshot({ path: join(OUT, '09-shift-summary.png'), fullPage: true });
  await p2.locator('[data-testid^="case-"]').first().click();
  await p2.getByTestId('visit-truth').waitFor({ timeout: 10_000 });
  check((await text(p2, 'visit-truth')).startsWith('На самом деле:'), 'итоги дня: разбор каждого приёма');
  await p2.getByTestId('shift-to-summary').click();
  await p2.getByTestId('shift-next-day').click();
  await p2.getByTestId('shift-clock').waitFor({ timeout: 10_000 });
  check((await text(p2, 'shift-clock')) === '08:00', 'следующий день — с 08:00');
  await day.close();

  // перенос на другой телефон: «Сохранить в файл» — файл со всем прогрессом; на «другом
  // телефоне» (чистое хранилище) «Открыть файл» — что в файле, «Заменить» — и в меню сразу
  // свой врач: оговорка и имя пришли из файла (FR-SYS-7)
  await page.goto(base);
  await page.getByTestId('menu-settings').click();
  await page.getByTestId('settings-transfer').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('transfer-save').click()]);
  const transferFile = join(OUT, 'transfer.json');
  await download.saveAs(transferFile);
  await page.getByTestId('transfer-note').waitFor({ timeout: 5000 });
  check(/^Сохранено: anamnez-\d{4}-\d{2}-\d{2}\.json\.$/.test(await text(page, 'transfer-note')) && download.suggestedFilename().startsWith('anamnez-'),
    `перенос: ${await text(page, 'transfer-note')}`);
  const phone2 = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 });
  const p4 = await phone2.newPage();
  p4.on('pageerror', e => errors.push(String(e)));
  await p4.goto(`${base}/transfer`);
  const [chooser] = await Promise.all([p4.waitForEvent('filechooser'), p4.getByTestId('transfer-open').click()]);
  await chooser.setFiles(transferFile);
  await p4.getByTestId('transfer-sheet').waitFor({ timeout: 5000 });
  check((await text(p4, 'transfer-line-0')).startsWith('Врач: Анна Петрова · приёмов: '), `перенос: в файле — ${(await text(p4, 'transfer-sheet')).replace(/\n/g, ' · ')}`);
  await p4.waitForTimeout(700); // лист выезжает снизу
  await p4.screenshot({ path: join(OUT, '20-transfer.png') });
  await p4.getByTestId('transfer-replace').click();
  await p4.getByTestId('transfer-note').waitFor({ timeout: 5000 });
  check((await text(p4, 'transfer-note')) === 'Готово: прогресс из файла на месте.', `перенос: ${await text(p4, 'transfer-note')}`);
  await p4.goto(base);
  await p4.getByTestId('menu-profile').waitFor({ timeout: 10_000 });
  check((await text(p4, 'menu-profile')).includes('Анна Петрова') && (await p4.getByTestId('menu-continue').count()) === 1,
    'перенос: на другом телефоне — сразу меню, свой врач и «Продолжить»');
  await phone2.close();

  // маленький экран 360 × 640: длинный лист — выбор помещения — прокручивается, а не уходит
  // верхом за край; «Отмена» — на экране, последний тип выбирается прокруткой листа
  const small = await browser.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 2 });
  await small.addInitScript(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/sandbox.json', sandboxFreshSave()]);
  const p3 = await small.newPage();
  p3.on('pageerror', e => errors.push(String(e)));
  await p3.goto(`${base}/quick`);
  await p3.getByTestId('menu-sandbox').click();
  await p3.getByTestId('restart-continue').click();
  await p3.getByTestId('sandbox-build').click();
  await p3.getByTestId('build-map').waitFor({ timeout: 10_000 });
  await p3.getByTestId('build-tool-room').click();
  await p3.getByTestId('room-type-room.ecg').waitFor({ timeout: 5000 });
  await p3.waitForTimeout(700); // лист выезжает снизу
  const firstType = (await p3.getByTestId('room-type-room.ecg').boundingBox())!;
  const cancel = (await p3.getByTestId('room-picker-close').boundingBox())!;
  check(firstType.y >= 0 && cancel.y + cancel.height <= 640,
    `маленький экран: выбор помещения — первый тип (верх ${Math.round(firstType.y)}) и «Отмена» (низ ${Math.round(cancel.y + cancel.height)} из 640) на экране`);
  await p3.screenshot({ path: join(OUT, '19-small-picker.png') });
  await p3.getByTestId('room-type-room.xray').click();
  await p3.getByTestId('build-place').waitFor({ timeout: 5000 });
  check(await p3.getByTestId('build-place').isVisible(), 'маленький экран: последний тип в листе выбирается прокруткой — призрак рентген-кабинета');
  await small.close();

  const real = errors.filter(e => !/favicon/.test(e));
  check(real.length === 0, `нет ошибок в консоли${real.length ? `: ${real.slice(0, 3).join(' | ')}` : ''}`);
} catch (e) {
  failures.push(String(e));
  console.error(e);
  await page.screenshot({ path: join(OUT, 'failure.png') }).catch(() => undefined);
} finally {
  await browser.close();
  server.stop(true);
}
console.log(failures.length ? `\nНе прошло: ${failures.length}` : '\nВсё прошло');
process.exit(failures.length ? 1 : 0);
