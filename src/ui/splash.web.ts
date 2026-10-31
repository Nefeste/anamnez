// Страница загрузки веб-сборки (public/index.html, spec 2026-10-premium-polish): ход — ступенями, какие видны коду:
// 1 — код загружен и выполняется, 2 — CanvasKit готов, 3 — экран собран; тогда страница гаснет и убирается.
const splash = () => (typeof document === 'undefined' ? null : document.getElementById('splash'));

export function splashStage(stage: 1 | 2 | 3): void {
  splash()?.setAttribute('data-stage', String(stage));
}

export function hideSplash(): void {
  const el = splash();
  if (!el || el.dataset.done === '1') return;
  el.setAttribute('data-stage', '3');
  el.setAttribute('data-done', '1');
  el.setAttribute('aria-busy', 'false');
  setTimeout(() => el.remove(), 400);
}
