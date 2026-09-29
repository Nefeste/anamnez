// npm run content — собрать медицинскую базу и каталог больницы в src/content/generated/bundle.json (ADR 0007).
// Ошибки валидатора останавливают сборку: база с битой ссылкой в игру не попадает.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDb } from './load';

const OUT = join(import.meta.dir, '../../src/content/generated');

const { db, errors, warnings, files } = buildDb();
for (const w of warnings) console.warn(`предупреждение: ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`ошибка: ${e}`);
  console.error(`\nБаза не собрана: ${errors.length} ошибок в ${files} файлах.`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'bundle.json'), JSON.stringify(db));
const n = (r: object) => Object.keys(r).length;
const drafts = [...Object.values(db.conditions), ...Object.values(db.findings), ...Object.values(db.exams), ...Object.values(db.treatments)].filter(x => x.review === 'draft').length;
console.log(`База ${db.contentVersion} (${db.hash}): состояний ${n(db.conditions)}, признаков ${n(db.findings)}, обследований ${n(db.exams)}, факторов риска ${n(db.risks)}, лечений ${n(db.treatments)}, шкал ${n(db.scores)}, правил ${n(db.rules)}; черновиков ${drafts}. Больница: помещений ${n(db.rooms)}, аппаратов ${n(db.equipment)}, должностей ${n(db.roles)}. Кампания: глав ${n(db.chapters)}, персонажей ${n(db.characters)}, подсказок ${n(db.tips)}. Достижений ${n(db.achievements)}.`);
