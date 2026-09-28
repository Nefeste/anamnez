# Шрифты и их лицензии

Правило — ADR 0017 и спецификация `docs/specs/2026-09-own-look.md`: шрифты интерфейса лежат в
сборке, под открытой лицензией SIL Open Font License 1.1; из сети ничего не грузится. Файлы —
без изменений, из пакетов `@expo-google-fonts/*` (Google Fonts). Текст лицензии — рядом.

| Файлы | Шрифт | Авторы | Лицензия |
|-------|-------|--------|----------|
| `PTSerif-Regular.ttf`, `PTSerif-Italic.ttf`, `PTSerif-Bold.ttf` | PT Serif | ParaType Ltd. | OFL 1.1, `OFL-PTSerif.txt` |
| `PTSans-Regular.ttf`, `PTSans-Bold.ttf` | PT Sans | ParaType Ltd. | OFL 1.1, `OFL-PTSans.txt` |
| `PTMono-Regular.ttf` | PT Mono | ParaType Ltd. | OFL 1.1, `OFL-PTMono.txt` |
| `GolosText-Regular.ttf`, `GolosText-Medium.ttf`, `GolosText-SemiBold.ttf`, `GolosText-Bold.ttf` | Golos Text | The Golos Text Project Authors | OFL 1.1, `OFL-GolosText.txt` |
| `JetBrainsMono-Medium.ttf`, `JetBrainsMono-Bold.ttf` | JetBrains Mono | The JetBrains Mono Project Authors | OFL 1.1, `OFL-JetBrainsMono.txt` |

Светлая тема «Медкарта» — PT Serif, PT Sans, PT Mono; тёмная «Монитор» — Golos Text и
JetBrains Mono.
