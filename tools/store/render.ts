// npm run store — иконка, графика и снимки экрана для магазина и сайта (store/README.md,
// 11-publishing.md §8). Сначала `npm run export:web`: снимки — с настоящей игры в
// веб-сборке (стенд, ADR 0003) размером телефона 360 × 640 при плотности 3 — 1080 × 1920,
// шрифтами игры в её двух темах (spec 2026-09-own-look): ЭКГ — в тёмном «Мониторе»,
// остальное — в светлой «Медкарте». Графика магазина — шрифтом Roboto, по
// брендбуку студии. Состояния смены пишет движок (tools/store/states.ts).
//
// Флаги: --only icons|graphics|shots (по умолчанию — всё).
import { mkdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';
import { buildDb } from '../content/load';
import { BRAND, iconSvg, markSvg } from './art';
import { CAPTIONS } from './captions';
import { acsCase, districtState, envelope, pneumoniaCase, sandboxState, strokeCtCase } from './states';

const ROOT = join(import.meta.dir, '../..');
const DIST = join(ROOT, 'dist-web');
const FONTS = join(ROOT, 'node_modules/@fontsource/roboto');
const STORE = join(ROOT, 'store');
const ASSETS = join(ROOT, 'assets');
const only = (() => {
  const i = process.argv.indexOf('--only');
  return i >= 0 ? process.argv[i + 1] : undefined;
})();
const want = (part: 'icons' | 'graphics' | 'shots') => !only || only === part;


const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png',
  '.wav': 'audio/wav', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
};

/** Roboto для графики магазина — по брендбуку: @font-face из @fontsource с путями к серверу. */
function fontCss(): string {
  const faces = [400, 500, 600, 700, 800, 900].map(w => readFileSync(join(FONTS, `${w}.css`), 'utf8')).join('\n').replaceAll('url(./files/', 'url(/__fonts/');
  return `${faces}\n* { font-family: 'Roboto', sans-serif !important; }`;
}

function serve() {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      if (path.startsWith('/__fonts/')) {
        const f = join(FONTS, 'files', path.slice('/__fonts/'.length));
        return new Response(Bun.file(f), { headers: { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream' } });
      }
      const wanted = join(DIST, path === '/' ? 'index.html' : path);
      const name = (await Bun.file(wanted).exists()) ? wanted : join(DIST, 'index.html');
      return new Response(Bun.file(name), { headers: { 'content-type': TYPES[extname(name)] ?? 'application/octet-stream' } });
    },
  });
}

/** SVG → PNG: без прозрачности (RGB) или с ней (RGBA) — как требует место. */
async function svgPng(browser: Browser, svg: string, size: number, file: string, transparent: boolean) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;${transparent ? 'background:transparent' : `background:${BRAND.teal}`}">${svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)}</body></html>`);
  mkdirSync(join(file, '..'), { recursive: true });
  await page.screenshot({ path: file, omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
  console.log(`  ${file.replace(`${ROOT}/`, '')}`);
}

async function icons(browser: Browser) {
  console.log('Иконки');
  await svgPng(browser, iconSvg('full'), 1024, join(ASSETS, 'icon.png'), false);
  await svgPng(browser, iconSvg('foreground'), 1024, join(ASSETS, 'adaptive-icon.png'), true);
  await svgPng(browser, iconSvg('background'), 1024, join(ASSETS, 'adaptive-icon-background.png'), false);
  await svgPng(browser, iconSvg('monochrome'), 1024, join(ASSETS, 'adaptive-icon-monochrome.png'), true);
  await svgPng(browser, iconSvg('full'), 48, join(ASSETS, 'favicon.png'), false);
  await svgPng(browser, iconSvg('full'), 512, join(STORE, 'icon/icon-512.png'), false);
}

const ecgLine = (w: number, y: number, amp: number) => {
  const beat = [[0, 0], [60, 0], [70, -0.12], [80, 0], [95, 0], [102, 0.2], [112, -1], [122, 0.7], [132, 0], [160, 0], [178, -0.22], [196, 0], [260, 0]];
  const pts: string[] = [];
  for (let x0 = -40; x0 < w; x0 += 260) for (const [x, v] of beat) pts.push(`${x0 + x},${y + v * amp}`);
  return `<svg width="${w}" height="${y + amp + 10}" style="position:absolute;left:0;top:0"><polyline points="${pts.join(' ')}" fill="none" stroke="${BRAND.trace}" stroke-opacity="0.35" stroke-width="5" stroke-linejoin="round"/></svg>`;
};

const phone = (png: Buffer, width: number, style = '') =>
  `<img src="data:image/png;base64,${png.toString('base64')}" style="width:${width}px;border-radius:${width * 0.05}px;border:${Math.round(width * 0.012)}px solid #0B3F3D;box-shadow:0 ${width * 0.03}px ${width * 0.08}px rgba(0,0,0,.35);${style}"/>`;

async function page(browser: Browser, w: number, h: number, body: string, file: string) {
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await p.setContent(`<html><head><style>${fontCss().replaceAll('url(/__fonts/', `url(file://${FONTS}/files/`)}</style></head>
    <body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;position:relative;background:linear-gradient(155deg, ${BRAND.tealLight}, ${BRAND.tealDark});color:#fff">${body}</body></html>`);
  await p.evaluate(() => document.fonts.ready);
  mkdirSync(join(file, '..'), { recursive: true });
  await p.screenshot({ path: file });
  await p.close();
  console.log(`  ${file.replace(`${ROOT}/`, '')}`);
}

async function graphics(browser: Browser, screens: Record<string, Buffer>) {
  console.log('Графика');
  // 1024 × 500 — графика Google Play и шапка для сайта: знак, название, одна строка
  await page(browser, 1024, 500, `
    ${ecgLine(1024, 462, 34)}
    <div style="position:absolute;left:70px;top:95px">${markSvg(300)}</div>
    <div style="position:absolute;left:430px;top:150px;right:40px">
      <div style="font-weight:800;font-size:92px;letter-spacing:-1px">Анамнез</div>
      <div style="font-size:34px;line-height:1.3;margin-top:8px;opacity:.95">Симулятор врача:<br/>каждый пациент — загадка</div>
    </div>`, join(STORE, 'graphics/feature-1024x500.png'));
  // 1920 × 1080 — обложка для сайта и соцсетей: слева слова, справа два экрана игры
  const a = screens['02-xray.png'];
  const b = screens['07-outcome.png'];
  await page(browser, 1920, 1080, `
    ${ecgLine(1920, 960, 90)}
    <div style="position:absolute;left:130px;top:230px;width:820px">
      <div style="display:flex;align-items:center;gap:36px">${markSvg(170)}<div style="font-weight:800;font-size:130px;letter-spacing:-2px">Анамнез</div></div>
      <div style="font-size:52px;line-height:1.28;margin-top:36px">Симулятор врача<br/>с честной диагностикой</div>
      <div style="font-size:34px;line-height:1.4;margin-top:34px;opacity:.9">Каждый пациент — загадка: расспросите, осмотрите, назначьте анализы и снимки, поставьте диагноз и вылечите.</div>
    </div>
    ${a ? `<div style="position:absolute;left:1040px;top:140px">${phone(a, 400)}</div>` : ''}
    ${b ? `<div style="position:absolute;left:1440px;top:230px">${phone(b, 380)}</div>` : ''}`, join(STORE, 'graphics/cover-1920x1080.png'));
}

/** Снимок экрана — в рамке с подписью: 1080 × 1920, как просит RuStore. */
async function framed(browser: Browser, raw: Buffer, caption: string, file: string) {
  const text = caption.split('\n').map(l => `<div>${l}</div>`).join('');
  await page(browser, 1080, 1920, `
    <div style="position:absolute;top:120px;left:60px;right:60px;text-align:center;font-weight:700;font-size:64px;line-height:1.2">${text}</div>
    <div style="position:absolute;left:50%;top:400px;transform:translateX(-50%)">${phone(raw, 820)}</div>`, file);
}

/**
 * Партия из сохранения в слоте `slot` — на экране `path` (оговорка и имя врача — только у
 * меню). Тема — как у телефона (`scheme`): «Как в телефоне» стоит по умолчанию.
 */
async function openShift(browser: Browser, base: string, save: string, slot = 'shift', path = '/shift', scheme: 'light' | 'dark' = 'light'): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, colorScheme: scheme });
  await ctx.addInitScript(([key, value]) => localStorage.setItem(key, value), [`anamnez:saves/${slot}.json`, save]);
  const p = await ctx.newPage();
  await p.goto(`${base}${path}`);
  await p.evaluate(() => document.fonts.ready);
  return p;
}

/** Своя больница из сохранения — как её открывает игрок: «Быстрая игра» → «Песочница» → «Продолжить». */
async function openSandbox(browser: Browser, base: string, save: string): Promise<Page> {
  const p = await openShift(browser, base, save, 'sandbox', '/quick');
  await p.getByTestId('menu-sandbox').click();
  await p.getByTestId('restart-continue').click();
  return p;
}

/** Карьера из сохранения — как её открывает игрок: «Кампания» → «Карьера 1» → «Продолжить». */
async function openCampaign(browser: Browser, base: string, save: string): Promise<Page> {
  const p = await openShift(browser, base, save, 'campaign-1', '/campaign');
  await p.getByTestId('career-1').click();
  await p.getByTestId('career-continue').click();
  return p;
}

const snap = async (p: Page) => Buffer.from(await p.screenshot({ type: 'png' }));

/**
 * Дотянуть призрак помещения до клетки `target` — как пальцем. Участок весь на экране и по
 * центру карты; где призрак — из подписи карты для чтения с экрана («клетка 16, 10»). Жест в
 * вебе может отстать на клетку — тогда ещё раз с того места, где призрак оказался.
 */
async function ghostTo(p: Page, [plotW, plotH]: readonly [number, number], target: [number, number]) {
  const map = p.getByTestId('build-map');
  const point = async (x: number, y: number) => {
    const box = (await map.boundingBox())!;
    const c = 16 * Math.min(box.width / (plotW * 16), box.height / (plotH * 16));
    return { x: box.x + (box.width - plotW * c) / 2 + (x + 0.5) * c, y: box.y + (box.height - plotH * c) / 2 + (y + 0.5) * c };
  };
  const at = async () => {
    const m = /клетка (\d+), (\d+)/.exec((await map.getAttribute('aria-label')) ?? '');
    return m ? [Number(m[1]), Number(m[2])] : undefined;
  };
  for (let i = 0; i < 4; i++) {
    const now = await at();
    if (!now || (now[0] === target[0] && now[1] === target[1])) return;
    const a = await point(now[0] + 2, now[1] + 2);
    const b = await point(target[0] + 2, target[1] + 2);
    await p.mouse.move(a.x, a.y);
    await p.mouse.down();
    await p.mouse.move(b.x, b.y, { steps: 14 });
    await p.waitForTimeout(150);
    await p.mouse.up();
    await p.waitForTimeout(400);
  }
  throw new Error(`08-build: призрак не встал в клетку ${target.join(', ')} — он в ${(await at())?.join(', ')}`);
}

/** Все прокрутки — наверх: нажатие кнопки прокручивает к ней список. */
const toTop = (p: Page) => p.evaluate(() => {
  for (const el of Array.from(document.querySelectorAll('*'))) if ((el as HTMLElement).scrollTop > 0) (el as HTMLElement).scrollTop = 0;
});

async function shots(browser: Browser): Promise<Record<string, Buffer>> {
  console.log('Снимки экрана');
  const { db } = buildDb();
  const server = serve();
  const base = `http://127.0.0.1:${server.port}`;
  const raw: Record<string, Buffer> = {};
  try {
    // 1. районная больница главы 2 на третий день: в палатах лежат, через минуту-две скорая
    // привезёт больного — автопауза, внизу «сортировать» (открывают, как игрок: «Кампания» →
    // «Карьера 1» → «Продолжить»)
    let p = await openCampaign(browser, base, envelope(districtState(db)));
    await p.getByTestId('shift-sort').waitFor({ timeout: 30_000 });
    await p.waitForTimeout(600);
    raw['01-emergency.png'] = await snap(p);
    await p.context().close();

    // 2, 5–7. пневмония: снимок пришёл; решение, лечение, итог
    p = await openShift(browser, base, envelope(pneumoniaCase(db)));
    await p.getByTestId('shift-continue').click();
    await p.getByTestId('result-xray').waitFor({ timeout: 20_000 });
    await p.getByTestId('visit-fresh').first().evaluate(el => el.scrollIntoView({ block: 'start' }));
    await p.mouse.wheel(0, -64);
    await p.waitForTimeout(700);
    raw['02-xray.png'] = await snap(p);
    await p.getByTestId('visit-decide').click();
    await p.getByTestId('hint-cond.pneumonia_cap').click();
    await toTop(p);
    await p.waitForTimeout(300);
    raw['05-diagnosis.png'] = await snap(p);
    await p.getByTestId('decision-to-plan').click();
    await p.getByTestId('tx-tx.amoxicillin').click();
    await p.getByTestId('tx-tx.rest_fluids').click();
    await p.getByTestId('setting-home').click();
    await toTop(p);
    await p.waitForTimeout(300);
    raw['06-plan.png'] = await snap(p);
    await p.getByTestId('visit-finish').click();
    await p.getByTestId('visit-truth').waitFor({ timeout: 20_000 });
    await p.waitForTimeout(300);
    raw['07-outcome.png'] = await snap(p);
    await p.context().close();

    // 3. инсульт в первую смену сосудистого отделения (глава 3): КТ пришла срезом — крови внутри черепа нет
    // (открывают, как игрок: «Кампания» → «Карьера 1» → «Продолжить»)
    p = await openCampaign(browser, base, envelope(strokeCtCase(db)));
    await p.getByTestId('shift-continue').click();
    await p.getByTestId('result-ct').waitFor({ timeout: 20_000 });
    // сверху — «Новое»: строка обследования со временем, срез и строка находки
    await p.getByTestId('visit-fresh').first().evaluate(el => el.scrollIntoView({ block: 'start' }));
    await p.waitForTimeout(700);
    raw['03-ct.png'] = await snap(p);
    await p.context().close();

    // 4. боль в груди: на ЭКГ подъём ST — в тёмной теме, как на мониторе; лист двенадцати
    // отведений целиком (часть 36), под ним — строка находки
    p = await openShift(browser, base, envelope(acsCase(db)), 'shift', '/shift', 'dark');
    await p.getByTestId('shift-continue').click();
    await p.getByTestId('result-ecg').waitFor({ timeout: 20_000 });
    await p.getByTestId('result-ecg').evaluate(el => el.scrollIntoView({ block: 'start' }));
    await p.mouse.wheel(0, -40);
    await p.waitForTimeout(500);
    raw['04-ecg.png'] = await snap(p);
    await p.context().close();

    // 8. своя больница: готовая амбулатория на участке песочницы — экран стройки, как его
    // открывает игрок: «Быстрая игра» → «Песочница» → «Продолжить» → «Стройка»; призрак
    // второго кабинета врача — на свободном месте справа внизу
    p = await openSandbox(browser, base, envelope(sandboxState(db)));
    await p.getByTestId('sandbox-build').click();
    await p.getByTestId('build-map').waitFor({ timeout: 20_000 });
    await p.waitForTimeout(700);
    await p.getByTestId('build-tool-room').click();
    await p.getByTestId('room-type-room.office').click();
    await p.getByTestId('build-place').waitFor({ timeout: 5000 });
    await ghostTo(p, db.economy.sandbox.plot, [31, 19]);
    await p.waitForTimeout(500);
    raw['08-build.png'] = await snap(p);
    await p.context().close();
  } finally {
    server.stop(true);
  }
  for (const { file, caption } of CAPTIONS) await framed(browser, raw[file], caption, join(STORE, 'screenshots/phone', file));
  return raw;
}

if (import.meta.main) {
  const browser = await chromium.launch();
  try {
    if (want('icons')) await icons(browser);
    const screens = want('shots') || want('graphics') ? await shots(browser) : {};
    if (want('graphics')) await graphics(browser, screens);
  } finally {
    await browser.close();
  }
}
