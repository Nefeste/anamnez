# Звуки, музыка и их лицензии

Правило — ADR 0013: только свои звуки или CC0. Каждый файл — строка в таблице.

| Файл | Источник | Лицензия |
|------|----------|----------|
| `tap.wav` | синтезирован `tools/audio/gen.ts` | собственность проекта |
| `ready.wav` | синтезирован `tools/audio/gen.ts` | собственность проекта |
| `urgent.wav` | синтезирован `tools/audio/gen.ts` | собственность проекта |
| `arrived.wav` | собран `tools/audio/clinic.ts` из `doorOpen_1.ogg` набора Kenney «RPG Audio» | CC0 |
| `ambient.wav` | собран `tools/audio/clinic.ts`: гул вентиляции из `tools/audio/gen.ts` и звуки набора Kenney «RPG Audio» — `footstep00`–`footstep09`, `doorClose_1`–`doorClose_4`, `bookFlip1`–`bookFlip3`, `creak3` | собственность проекта и CC0 |
| `music-menu.mp3` | «Vaporware» (Calm Piano 1), The Cynic Project — <https://opengameart.org/content/calm-piano-1-vaporware>, файл `003_Vaporware_2.mp3`; перекодирован `tools/audio/music.mjs` | CC0 |
| `music-shift.mp3` | «Contemplation», Joth — <https://opengameart.org/content/contemplation-0>, файл `Contemplation.mp3`; перекодирован `tools/audio/music.mjs` | CC0 |
| `alarm.wav` | синтезирован `tools/audio/gen.ts` | собственность проекта |

## Наборы CC0

| Набор | Автор | Где | Лицензия |
|-------|-------|-----|----------|
| RPG Audio | Kenney (kenney.nl) | <https://kenney.nl/assets/rpg-audio> | CC0 1.0 — <https://creativecommons.org/publicdomain/zero/1.0/> |
| Calm Piano 1 (Vaporware) | The Cynic Project (cynicmusic.com) | <https://opengameart.org/content/calm-piano-1-vaporware> | CC0 1.0 — на странице работы, сверено 13.10.2026 |
| Contemplation | Joth | <https://opengameart.org/content/contemplation-0> | CC0 1.0 — на странице работы, сверено 13.10.2026 |

Автор «Vaporware» просит упоминания; CC0 его не требует, но имя — здесь и в «Об игре» (`about.ts`, источники звука).

## Как пересобрать

Файлы в `assets/audio` — готовые, пересобирать их для сборки игры не нужно. Чтобы поменять
звук амбулатории:

1. Скачать набор «RPG Audio» с kenney.nl и распаковать.
2. Во временной папке поставить декодер OGG — он не зависимость проекта:
   `npm i @wasm-audio-decoders/ogg-vorbis@0.1.20`.
3. Там же перевести нужные OGG в WAV:
   `node <проект>/tools/audio/ogg2wav.mjs src <набор>/Audio/doorOpen_1.ogg …`
   (все файлы из таблицы выше).
4. В проекте: `bun tools/audio/clinic.ts <временная папка>/src`.

Моменты шагов, дверей и страниц в фоне — из генератора игры с фиксированным зерном: при тех
же исходниках файлы получаются те же.

Музыка (часть 62): в меню — «Vaporware», на смене и в «Случае дня» — «Contemplation», тише. Чтобы поменять трек:

1. Скачать MP3 со страницы работы — лицензия на ней должна быть CC0.
2. Во временной папке поставить декодер и кодировщик — они не зависимости проекта:
   `npm i mpg123-decoder@1.0.3 @breezystack/lamejs@1.2.7`.
3. Там же: `node <проект>/tools/audio/music.mjs <скачанный.mp3> <проект>/assets/audio/music-menu.mp3`
   (или `music-shift.mp3`). Тишина по краям срезается, громкость выравнивается до −20 дБ, края петли — плавные,
   MP3 — 128 кбит/с; при том же исходнике файл получается тот же.
4. Строку в таблице выше — поправить.
