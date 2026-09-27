// npm run e2e — сценарий Playwright по веб-сборке (09-testing.md §4): все пять прототипов
// этапа 1 и смена этапа 2. Сначала `npm run export:web`. Снимки экранов — в tools/e2e/out/.
import { mkdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { clinicLayout } from '../../src/engine/hospital/clinic';
import { apply, newSandbox, newShift } from '../../src/engine/shift/engine';
import { SHIFT_SCHEMA_VERSION } from '../../src/engine/shift/types';
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

/** Часы смены на ×4, пока не выполнится условие; автопаузу («срочный», «результаты») снимаем. */
async function runClockUntil(page: Page, done: () => Promise<boolean>, ms = 60_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await done()) return true;
    if ((await page.getByTestId('shift-pause-reason').count()) > 0) await page.getByTestId('tab-x4').click();
    await page.waitForTimeout(250);
  }
  return false;
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
  check((await page.getByTestId('menu-shift').count()) === 0, 'первый запуск: оговорка — до меню');
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
  await page.screenshot({ path: join(OUT, '01-doctor.png') });
  await page.getByTestId('doctor-submit').click();
  await page.getByTestId('menu-settings').waitFor({ timeout: 5000 });
  check((await text(page, 'menu-profile')).includes('Анна Петрова'), `меню: профиль — «${(await text(page, 'menu-profile')).replace(/\n/g, ' · ')}»`);
  await page.screenshot({ path: join(OUT, '01-menu.png') });
  check(await page.getByTestId('menu-campaign').isDisabled(), 'меню: практика, настройки; кампания — «скоро»');
  await page.goto(base);
  await page.getByTestId('menu-shift').waitFor({ timeout: 30_000 });
  check((await page.getByTestId('accept-disclaimer').count()) === 0, 'оговорка — только при первом запуске');

  // настройки сохраняются; «Об игре» — версия, оговорка, почта, источники базы
  await page.getByTestId('menu-settings').click();
  await page.getByTestId('settings-vibration').waitFor({ timeout: 5000 });
  const vibration = () => page.getByTestId('settings-vibration').getAttribute('aria-checked');
  const quiet = () => page.getByTestId('sound-1').getAttribute('aria-selected');
  check((await vibration()) === 'true' && (await page.getByTestId('sound-3').getAttribute('aria-selected')) === 'true', 'настройки: по умолчанию вибрация включена, звук громкий');
  await page.getByTestId('settings-vibration').click();
  await page.getByTestId('sound-1').click();
  await page.screenshot({ path: join(OUT, '10-settings.png'), fullPage: true });
  await page.goto(`${base}/settings`);
  await page.getByTestId('settings-vibration').waitFor({ timeout: 10_000 });
  check((await vibration()) === 'false' && (await quiet()) === 'true', 'настройки: вибрация и громкость — те же после перезапуска');
  await page.getByTestId('settings-vibration').click();
  await page.getByTestId('sound-3').click();
  // размер текста: «Крупный» — шрифт в 1,3 раза больше; вернуть «Обычный»
  const fontOf = () => page.getByTestId('settings-about').locator('div[dir="auto"]').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  const normal = await fontOf();
  await page.getByTestId('text-size-2').click();
  const large = await fontOf();
  check(Math.abs(large / normal - 1.3) < 0.02, `настройки: размер текста «Крупный» — ${normal} → ${large} px`);
  await page.getByTestId('text-size-0').click();
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

  // П5: снимки, ЭКГ, портреты
  await page.goto(`${base}/spikes/imaging`);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(OUT, '06-imaging.png'), fullPage: true });
  check(true, 'П5: экран снимков открылся (смотреть 06-imaging.png)');

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
  await page.getByTestId('menu-shift').click();
  await page.getByTestId('shift-start').waitFor({ timeout: 15_000 });
  // сложность выбирают при начале практики; по умолчанию — «Студент» с подсказками
  check((await page.getByTestId('difficulty-student').getAttribute('aria-selected')) === 'true' && (await text(page, 'difficulty-text')).startsWith('Подсказки'), 'смена: сложность по умолчанию — «Студент»');
  await page.getByTestId('shift-start').click();
  // в очереди никого — «промотать до следующего» (отзыв на 0.0.7: ждали 40 секунд)
  await page.getByTestId('shift-skip').click();
  await page.getByTestId('shift-call').waitFor({ timeout: 5_000 });
  const opened = await text(page, 'shift-clock');
  check(/^\d\d:\d\d$/.test(opened) && opened > '08:00', `смена: «промотать до следующего» — пришёл первый (${opened})`);
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
  // первый пришедший доходит до стойки, до медсестры и садится в зале — тогда его и касаемся
  let seatedWho = '';
  for (let i = 0; i < 50 && !seatedWho.includes('Ждёт приёма'); i++) {
    await tapCell(CLINIC.seats[0]);
    await page.waitForTimeout(400);
    seatedWho = (await page.getByTestId('map-who').count()) > 0 ? await text(page, 'map-who') : '';
  }
  check(seatedWho.includes('Ждёт приёма') && (await page.getByTestId('map-invite').isVisible()), `смена: коснулись ждущего в зале — «${seatedWho.replace(/\n/g, ' · ')}»`);
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
  await page.locator('[data-testid^="hint-"]').first().click();
  await page.getByTestId('decision-to-plan').click();
  await page.getByTestId('setting-home').click();
  await page.getByTestId('visit-finish').click();
  await page.getByTestId('visit-truth').waitFor({ timeout: 10_000 });
  check((await text(page, 'visit-outcome')).includes('итогах следующих дней'), 'смена: исход «домой» — в итогах следующих дней');
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
  await page.screenshot({ path: join(OUT, '09-profile.png') });
  await archived.first().click();
  await page.getByTestId('visit-truth').waitFor({ timeout: 10_000 });
  check(await page.getByTestId('visit-truth').isVisible(), `профиль: приём из архива — ${await text(page, 'visit-truth')}`);
  await page.getByTestId('visit-truth-article').click();
  await visible(page, 'enc-practice').waitFor({ timeout: 10_000 });
  const practice = await visibleText(page, 'enc-practice');
  check(practice.startsWith('Встречалось в вашей практике: 1'), `энциклопедия: «${practice}»`);
  await page.goto(base);
  await page.getByTestId('menu-shift').waitFor({ timeout: 10_000 });
  // начать заново — только после вопроса: сохранение одно
  await page.getByTestId('menu-shift').click();
  await page.getByTestId('restart-sheet').waitFor({ timeout: 5000 });
  await page.getByTestId('restart-sheet-close').click();
  await page.getByTestId('restart-sheet').waitFor({ state: 'detached', timeout: 5000 });
  check(await page.getByTestId('menu-continue').isVisible(), 'меню: «Отмена» — практика на месте');
  await page.getByTestId('menu-shift').click();
  await page.getByTestId('restart-confirm').click();
  await page.getByTestId('shift-clock').waitFor({ timeout: 10_000 });
  check((await text(page, 'shift-clock')) === '08:00' && (await text(page, 'shift-counts')).startsWith('Принято: 0'), 'меню: «Начать заново» — день 1, 08:00');

  // песочница: пустой участок → регистратура (призрак тянут пальцем) → коридор кистью → отмена
  // и снова → карточка помещения → «Готово»; в меню «Продолжить» — песочница
  await page.goto(base);
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
  const cellPoint = async (x: number, y: number) => {
    const box = (await page.getByTestId('build-map').boundingBox())!;
    const z = Math.min(box.width / (plotW * 16), box.height / (plotH * 16));
    return { x: box.x + (box.width - plotW * 16 * z) / 2 + (x + 0.5) * 16 * z, y: box.y + (box.height - plotH * 16 * z) / 2 + (y + 0.5) * 16 * z };
  };
  const drag = async (cells: [number, number][]) => {
    const a = await cellPoint(...cells[0]);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    for (const c of cells.slice(1)) {
      const b = await cellPoint(...c);
      await page.mouse.move(b.x, b.y, { steps: 14 });
    }
    await page.mouse.up();
    await page.waitForTimeout(400);
  };
  const cash0 = await text(page, 'build-cash');
  await page.getByTestId('build-tool-room').click();
  await page.getByTestId('room-type-room.reception').click();
  await page.getByTestId('build-place').waitFor({ timeout: 5000 });
  // призрак — посреди участка (17, 10); тянем на пять клеток влево
  await drag([[19, 13], [14, 13]]);
  await page.screenshot({ path: join(OUT, '12-build-ghost.png') });
  await page.getByTestId('build-place').click();
  await page.getByTestId('build-tool-corridor').waitFor({ timeout: 5000 });
  const cash1 = await text(page, 'build-cash');
  check(cash1 !== cash0 && (await page.getByTestId('build-undo').innerText()).includes('(1)'), `стройка: регистратура построена — ${cash0} → ${cash1}`);
  await page.getByTestId('build-tool-corridor').click();
  const corridor: [number, number][] = [[4, 13], [4, 17], [24, 17]];
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
  await page.goto(base);
  await page.getByTestId('menu-continue').waitFor({ timeout: 10_000 });
  check((await text(page, 'menu-continue')).includes('песочница: перед открытием'), `меню: «Продолжить» — последняя партия: ${(await text(page, 'menu-continue')).replace(/\n/g, ' · ')}`);

  // песочница заново — с готовой амбулаторией: штат на местах; продали иммунохимический
  // анализатор — ТТГ в карте пациента серым с причиной; «Открыть смену» — день 1 на своём плане
  await page.getByTestId('menu-sandbox').click();
  await page.getByTestId('restart-confirm').click();
  await page.getByTestId('sandbox-from-clinic').click();
  await page.getByTestId('sandbox-start').click();
  await page.getByTestId('sandbox-build').waitFor({ timeout: 10_000 });
  await page.getByTestId('sandbox-build').click();
  await page.getByTestId('build-map').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  const lab = await cellPoint(25, 3);
  await page.mouse.click(lab.x, lab.y);
  await page.getByTestId('room-sell-3').click();
  await page.getByTestId('room-card-close').click();
  await page.getByTestId('build-done').click();
  await page.getByTestId('sandbox-open').waitFor({ timeout: 5000 });
  await page.getByTestId('sandbox-open').click();
  await page.getByTestId('shift-skip').click();
  await page.getByTestId('shift-call').waitFor({ timeout: 5000 });
  check(await page.getByTestId('clinic-map').isVisible(), 'песочница: смена открыта — карта своей больницы');
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
  await page.getByTestId('menu-sandbox').waitFor({ timeout: 10_000 });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), ['anamnez:saves/sandbox.json', sandboxEndOfDaySave()]);
  await page.goto(base);
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
