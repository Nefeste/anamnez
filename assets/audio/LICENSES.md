# Звуки, музыка и их лицензии

Правило — ADR 0019 (с 0.6.6, вместо правила ADR 0013 для звуков): свои звуки, CC0 или CC BY — с названием, автором,
ссылкой и тем, что изменено, на экране «Лицензии» (`tools/licenses/native.yaml`, раздел `sounds`). CC BY-SA,
«некоммерческие» и метка Public Domain Mark у свежих записей — нет. Каждый файл — строка в таблице.

| Файл | Источник | Лицензия |
|------|----------|----------|
| `tap.wav` | синтезирован `tools/audio/gen.ts` | собственность проекта |
| `ready.wav` | синтезирован `tools/audio/gen.ts` | собственность проекта |
| `urgent.wav` | синтезирован `tools/audio/gen.ts` | собственность проекта |
| `arrived.wav` | собран `tools/audio/clinic.ts` из `doorOpen_1.ogg` набора Kenney «RPG Audio» | CC0 |
| `ambient.wav` | собран `tools/audio/clinic.ts`: гул вентиляции из `tools/audio/gen.ts`; далёкие голоса — запись Ed Visoso «Av. Pradera 1101, Azteca, 37520 León de los Aldama, Gto., Mexico - Gente formada esperando su turno…» <https://archive.org/details/aporee_66705_77139>, отрезок 452–494 с — глуше, тише, стуки приглушены (с 0.6.6); звуки набора Kenney «RPG Audio» — `footstep00`–`footstep09`, `doorClose_1`–`doorClose_4`, `bookFlip1`–`bookFlip3`, `creak3` | собственность проекта, CC BY 3.0 и CC0 |
| `music-menu.mp3` | «Vaporware» (Calm Piano 1), The Cynic Project — <https://opengameart.org/content/calm-piano-1-vaporware>, файл `003_Vaporware_2.mp3`; перекодирован `tools/audio/music.mjs` | CC0 |
| `music-shift.mp3` | «Contemplation», Joth — <https://opengameart.org/content/contemplation-0>, файл `Contemplation.mp3`; перекодирован `tools/audio/music.mjs` | CC0 |
| `alarm.wav` | синтезирован `tools/audio/gen.ts` | собственность проекта |
| `phone.wav` | собран `tools/audio/clinic.ts` из записи Cloud16 Films «Automatic Electric (AE) Telephone Ringing» <https://archive.org/details/yellow-ae-80>, файл `Yellow_AE80.mp3`: звонок укорочен до секунды, три звонка через 5 с, глуше (с 0.6.6) | CC BY 4.0 |

## Наборы CC0

| Набор | Автор | Где | Лицензия |
|-------|-------|-----|----------|
| RPG Audio | Kenney (kenney.nl) | <https://kenney.nl/assets/rpg-audio> | CC0 1.0 — <https://creativecommons.org/publicdomain/zero/1.0/> |
| Calm Piano 1 (Vaporware) | The Cynic Project (cynicmusic.com) | <https://opengameart.org/content/calm-piano-1-vaporware> | CC0 1.0 — на странице работы, сверено 13.10.2026 |
| Contemplation | Joth | <https://opengameart.org/content/contemplation-0> | CC0 1.0 — на странице работы, сверено 13.10.2026 |

Автор «Vaporware» просит упоминания; CC0 его не требует, но имя — здесь и в «Об игре» (`about.ts`, источники звука).

## Записи под CC BY

| Запись | Автор | Где | Лицензия |
|--------|-------|-----|----------|
| «Av. Pradera 1101, Azteca, 37520 León de los Aldama, Gto., Mexico - Gente formada esperando su turno en el área para sacar cita con un doctor especialista que necesite ver en el hospital del ISSSTE.» — очередь записи к врачу в больнице, 660 с, 10.02.2025 | Ed Visoso | <https://archive.org/details/aporee_66705_77139> (radio aporee), файл MP3, MD5 `b6901699265aa5ce807e474443e1491d` | CC BY 3.0 — <https://creativecommons.org/licenses/by/3.0/>, на странице записи, сверено 17.10.2026 |
| «Automatic Electric (AE) Telephone Ringing» — звонок телефона Automatic Electric 80, 12 с | Cloud16 Films | <https://archive.org/details/yellow-ae-80>, файл `Yellow_AE80.mp3`, MD5 `f19040816a041e478a64f71f6f7e8140` | CC BY 4.0 — <https://creativecommons.org/licenses/by/4.0/>, на странице записи, сверено 17.10.2026 |

Обе — с названием, автором, ссылкой и тем, что изменено, — на экране «Лицензии» вместе с текстом лицензии; авторы — и в
«Об игре».

## Как пересобрать

Файлы в `assets/audio` — готовые, пересобирать их для сборки игры не нужно. Чтобы поменять
звук амбулатории:

1. Скачать набор «RPG Audio» с kenney.nl и распаковать в папку `rpg-audio`; скачать MP3 обеих записей под CC BY со
   страниц из таблицы выше.
2. Во временной папке поставить декодеры OGG и MP3 — они не зависимости проекта:
   `npm i @wasm-audio-decoders/ogg-vorbis@0.1.20 mpg123-decoder@1.0.3`.
3. Там же перевести нужные OGG в WAV:
   `node <проект>/tools/audio/ogg2wav.mjs src rpg-audio/Audio/doorOpen_1.ogg …`
   (все файлы из таблицы выше), а записи — под их именами:
   `node <проект>/tools/audio/mp32wav.mjs src <запись Ed Visoso>.mp3=visoso__issste-leon Yellow_AE80.mp3=cloud16__yellow-ae80`.
4. В проекте: `bun tools/audio/clinic.ts <временная папка>/src` — пишет `arrived.wav`, `ambient.wav` и `phone.wav`.

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
