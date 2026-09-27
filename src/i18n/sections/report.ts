// «Сообщить об ошибке» (06-architecture.md §8): игрок видит весь текст и отправляет его сам.
export const report = {
  title: 'Сообщить об ошибке',
  intro: (email: string) =>
    `Опишите, что случилось, и отправьте — на почту ${email} или в мессенджер. Игра сама ничего не отправляет: ниже весь текст, который уйдёт, в нём нет ничего, кроме версии, телефона и журнала дня.`,
  describe: 'Что случилось (можно не писать)',
  placeholder: 'Что делали, чего ждали, что вышло',
  share: 'Поделиться',
  shareTitle: 'Анамнез: сообщение об ошибке',
  cantShare: (email: string) => `Не открылось. Перепишите текст и отправьте на ${email}.`,
  noDescription: '(описания нет)',
  version: (v: string, build: number) => `Анамнез ${v}, сборка ${build}`,
  base: (version: number, hash: string) => `Медицинская база: версия ${version} (${hash})`,
  device: (d: string) => `Телефон: ${d}`,
  practice: (day: number, clock: string, level: string, seed: number, schema: number) =>
    `Практика: день ${day}, ${clock}, «${level}»; зерно ${seed}, схема ${schema}`,
  noPractice: 'Практики нет',
  noErrors: 'Сбоев не было',
  errors: 'Последние сбои:',
  fatal: '(игра закрылась)',
  journal: 'Журнал дня:',
};
