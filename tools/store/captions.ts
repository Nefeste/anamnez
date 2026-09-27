// Подписи к снимкам экрана магазина: их рисует tools/store/render.ts, они же перечислены
// в store/listing.ru.md (сверяет tools/test/store.test.ts).
export const CAPTIONS = [
  { file: '01-queue.png', caption: 'Смена в поликлинике:\nсрочных — первыми' },
  { file: '02-xray.png', caption: 'Спросите, осмотрите,\nназначьте снимок' },
  { file: '03-ecg.png', caption: 'Боль в груди?\nЭКГ покажет, звать ли скорую' },
  { file: '04-diagnosis.png', caption: 'Диагноз ставите вы —\nпо тому, что узнали' },
  { file: '05-plan.png', caption: 'Лечение и место:\nдома, стационар, скорая' },
  { file: '06-outcome.png', caption: 'Честный разбор:\nчто было на самом деле' },
  { file: '07-summary.png', caption: 'Итоги дня — и что стало\nс прошлыми пациентами' },
] as const;
