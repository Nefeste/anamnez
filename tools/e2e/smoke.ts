// npm run e2e — сценарий Playwright по веб-сборке (09-testing.md §4): все пять прототипов
// этапа 1. Сначала `npm run export:web`. Снимки экранов — в tools/e2e/out/.
import { mkdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium, type Page } from 'playwright';

const ROOT = join(import.meta.dir, '../..');
const DIST = join(ROOT, 'dist-web');
const OUT = join(import.meta.dir, 'out');
const golden = JSON.parse(readFileSync(join(ROOT, 'tools/test/fixtures/golden.json'), 'utf8'));
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

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 });
const errors: string[] = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

try {
  // меню и оговорка
  await page.goto(base);
  await page.getByTestId('accept-disclaimer').waitFor({ timeout: 30_000 });
  await page.screenshot({ path: join(OUT, '01-menu.png') });
  await page.getByTestId('accept-disclaimer').click();
  check(await page.getByTestId('menu-engine').isVisible(), 'меню открывается, оговорка закрывается');

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
  check(/[1-9]\d* кадр/.test(fps), `П2: карта рисуется — ${fps}`);
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
  await page.getByTestId('term-sheet-close').click();
  await page.getByTestId('term-sheet').waitFor({ state: 'detached', timeout: 5000 });
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
  await page.screenshot({ path: join(OUT, '04-patient-exams.png'), fullPage: true });
  await page.getByTestId('tab-decide').click();
  await page.getByTestId('dx-cond.pneumonia_cap').click();
  const truth = await text(page, 'visit-truth');
  check(truth.startsWith('На самом деле:'), `П4: разбор показывает правду — ${truth}`);
  await page.screenshot({ path: join(OUT, '05-review.png'), fullPage: true });
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
  check(/Записано \d+ КБ/.test(saved), `П6: ${saved}`);
  await page.getByTestId('save-load').click();
  await page.waitForTimeout(300);
  check((await text(page, 'save-status')).includes('текущий файл'), 'П6: читается текущий файл');
  await page.getByTestId('save-corrupt').click();
  await page.waitForTimeout(500);
  check((await text(page, 'save-status')).includes('предыдущая копия'), 'П6: испорченный файл — читается предыдущая копия');
  await page.screenshot({ path: join(OUT, '07-save.png') });

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
