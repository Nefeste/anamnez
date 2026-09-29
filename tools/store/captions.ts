// Подписи к снимкам экрана магазина: их рисует tools/store/render.ts, они же перечислены
// в store/listing.ru.md (сверяет tools/test/store.test.ts).
export const CAPTIONS = [
  { file: '01-emergency.png', caption: 'Скорая привезла:\nкого смотреть первым?' },
  { file: '02-xray.png', caption: 'Спросите, осмотрите,\nназначьте снимок' },
  { file: '03-fracture.png', caption: 'Перелом на снимке:\nгипс или операция?' },
  { file: '04-ecg.png', caption: 'Боль в груди?\nЭКГ покажет, звать ли скорую' },
  { file: '05-diagnosis.png', caption: 'Диагноз ставите вы —\nпо тому, что узнали' },
  { file: '06-plan.png', caption: 'Лечение и место:\nдома, стационар, скорая' },
  { file: '07-outcome.png', caption: 'Честный разбор:\nчто было на самом деле' },
  { file: '08-build.png', caption: 'Своя больница: стройте,\nнанимайте, ведите кассу' },
] as const;
