# Звуки и их лицензии

Правило — ADR 0013: только свои звуки или CC0. Каждый файл — строка в таблице.

| Файл | Источник | Лицензия |
|------|----------|----------|
| `tap.wav` | синтезирован `tools/audio/gen.ts` | собственность проекта |
| `ready.wav` | синтезирован `tools/audio/gen.ts` | собственность проекта |
| `urgent.wav` | синтезирован `tools/audio/gen.ts` | собственность проекта |
| `arrived.wav` | собран `tools/audio/clinic.ts` из `doorOpen_1.ogg` набора Kenney «RPG Audio» | CC0 |
| `ambient.wav` | собран `tools/audio/clinic.ts`: гул вентиляции из `tools/audio/gen.ts` и звуки набора Kenney «RPG Audio» — `footstep00`–`footstep09`, `doorClose_1`–`doorClose_4`, `bookFlip1`–`bookFlip3`, `creak3` | собственность проекта и CC0 |

## Наборы CC0

| Набор | Автор | Где | Лицензия |
|-------|-------|-----|----------|
| RPG Audio | Kenney (kenney.nl) | <https://kenney.nl/assets/rpg-audio> | CC0 1.0 — <https://creativecommons.org/publicdomain/zero/1.0/> |

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
