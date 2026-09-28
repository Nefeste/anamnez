// Шрифты интерфейса в веб-сборке (spec 2026-09-own-look): те же файлы, что в APK, правилами
// @font-face с начертаниями — fontFamily и fontWeight работают, как на Android, где семейства
// собирает плагин expo-font (app.json). Файлы — из сборки, не из сети.
import { Asset } from 'expo-asset';

const FACES: { family: string; weight: number; italic?: boolean; file: number }[] = [
  { family: 'PT Serif', weight: 400, file: require('../../assets/fonts/PTSerif-Regular.ttf') },
  { family: 'PT Serif', weight: 400, italic: true, file: require('../../assets/fonts/PTSerif-Italic.ttf') },
  { family: 'PT Serif', weight: 700, file: require('../../assets/fonts/PTSerif-Bold.ttf') },
  { family: 'PT Sans', weight: 400, file: require('../../assets/fonts/PTSans-Regular.ttf') },
  { family: 'PT Sans', weight: 700, file: require('../../assets/fonts/PTSans-Bold.ttf') },
  { family: 'PT Mono', weight: 400, file: require('../../assets/fonts/PTMono-Regular.ttf') },
  { family: 'Golos Text', weight: 400, file: require('../../assets/fonts/GolosText-Regular.ttf') },
  { family: 'Golos Text', weight: 500, file: require('../../assets/fonts/GolosText-Medium.ttf') },
  { family: 'Golos Text', weight: 600, file: require('../../assets/fonts/GolosText-SemiBold.ttf') },
  { family: 'Golos Text', weight: 700, file: require('../../assets/fonts/GolosText-Bold.ttf') },
  { family: 'JetBrains Mono', weight: 500, file: require('../../assets/fonts/JetBrainsMono-Medium.ttf') },
  { family: 'JetBrains Mono', weight: 700, file: require('../../assets/fonts/JetBrainsMono-Bold.ttf') },
];

let installed = false;

export function installFonts(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const css = FACES.map(f => `@font-face{font-family:'${f.family}';src:url('${Asset.fromModule(f.file).uri}') format('truetype');font-weight:${f.weight};font-style:${f.italic ? 'italic' : 'normal'};font-display:swap}`);
  const el = document.createElement('style');
  el.setAttribute('data-fonts', 'anamnez');
  el.textContent = css.join('\n');
  document.head.appendChild(el);
}
