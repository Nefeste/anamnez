// Валидатор базы (`docs/05-content.md` §6): ловит битые ссылки и нарушения правил,
// а не только опечатки схемы. Проверяется на испорченной копии базы.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { txRole } from '../../src/engine/med/plan';
import { findBrand } from '../content/brands';
import { buildDb, CONTENT_DIR } from '../content/load';

// Каждая испорченная копия собирается целиком (около 0,5 с), а в тесте их бывает до девяти:
// пяти секунд по умолчанию на медленной машине не хватает.
setDefaultTimeout(30_000);

function broken(mutate: (dir: string) => void): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'anamnez-content-'));
  try {
    cpSync(CONTENT_DIR, dir, { recursive: true });
    mutate(dir);
    return buildDb(dir).errors;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const edit = (dir: string, file: string, from: string, to: string) => {
  const p = join(dir, file);
  const s = readFileSync(p, 'utf8');
  if (!s.includes(from)) throw new Error(`в ${file} нет «${from}»`);
  writeFileSync(p, s.replace(from, to));
};

describe('валидатор базы', () => {
  test('настоящая база — без ошибок и предупреждений; у каждой болезни есть источник и отметка проверки', () => {
    const { db, errors, warnings } = buildDb();
    expect(errors).toEqual([]);
    // точная частота — с пояснением, откуда она (note, с 0.0.47)
    expect(warnings).toEqual([]);
    for (const c of Object.values(db.conditions)) {
      expect(c.sources.length).toBeGreaterThan(0);
      expect(['draft', 'checked', 'reviewed']).toContain(c.review);
    }
  });

  test('ссылка на несуществующий признак', () => {
    const errors = broken(d => edit(d, 'conditions/therapy/arvi.yaml', 'f: sym.rhinorrhea', 'f: sym.rhinorrea'));
    expect(errors.some(e => e.includes('sym.rhinorrea') && e.includes('не найден'))).toBe(true);
  });

  test('признак, который не открывает ни одно обследование', () => {
    const errors = broken(d => edit(d, 'exams/throat.yaml', '  - { f: sign.tonsillar_exudate, sens: 90, spec: 95 }\n', ''));
    expect(errors.some(e => e.startsWith('sign.tonsillar_exudate') && e.includes('ни одно обследование'))).toBe(true);
  });

  test('атрибут, которого у признака нет, и значение параметра без подписи', () => {
    const errors = broken(d => edit(d, 'conditions/therapy/pneumonia_cap.yaml', 'side: { right: 55, left: 35, both: 10 }', 'side: { right: 55, left: 35, upper: 10 }'));
    expect(errors.some(e => e.includes('upper'))).toBe(true);
  });

  test('обследование, все признаки которого бывают только у женщин, — только для женщин; возраст не уже признаков', () => {
    const noSex = broken(d => edit(d, 'exams/ask_pregnancy.yaml', 'sex: f\n', ''));
    expect(noSex.some(e => e.startsWith('exam.ask_pregnancy') && e.includes('только у женщин'))).toBe(true);
    const narrow = broken(d => edit(d, 'exams/ask_pregnancy.yaml', 'ageMax: 50', 'ageMax: 40'));
    expect(narrow.some(e => e.startsWith('exam.ask_pregnancy') && e.includes('до 50 лет'))).toBe(true);
  });

  test('торговое название лекарства — ошибка (ADR 0012): с начала слова, в любом регистре и падеже', () => {
    expect(findBrand('Аспирин')).toBe('Аспирин');
    expect(findBrand('после Нурофена')).toBe('Нурофен');
    expect(findBrand('(но-шпа)')).toBe('но-шп');
    // внутри слова — не название: в «утренние» есть «ренни»
    expect(findBrand('утренние часы')).toBeNull();
    const errors = broken(d => edit(d, 'treatments/ibuprofen.yaml', 'name: { ru: "Ибупрофен" }', 'name: { ru: "Ибупрофен (Нурофен)" }'));
    expect(errors).toContain('treatments/ibuprofen.yaml: торговое название «Нурофен» — только МНН или группа (ADR 0012)');
  });

  test('опечатка в имени поля — ошибка, а не молча пропущенное поле', () => {
    const errors = broken(d => edit(d, 'conditions/therapy/arvi.yaml', 'severity: minor', 'severety: minor'));
    expect(errors.some(e => e.includes('arvi.yaml'))).toBe(true);
  });

  test('у признака и обследования есть «Что это?» простыми словами', () => {
    const { db } = buildDb();
    for (const f of Object.values(db.findings)) expect(f.texts.hint?.ru.length ?? 0).toBeGreaterThan(20);
    for (const e of Object.values(db.exams)) expect(e.texts.hint?.ru.length ?? 0).toBeGreaterThan(20);
    const errors = broken(d => edit(d, 'findings/sym/cough.yaml', '  hint:\n', '  hint_draft:\n'));
    expect(errors.some(e => e.includes('cough.yaml'))).toBe(true);
  });

  test('тактика: у всего, с чем приходят; антибиотик не показан при вирусных, выбор — при бактериальных', () => {
    const { db } = buildDb();
    for (const c of Object.values(db.conditions).filter(x => x.presenting)) {
      expect(c.treatment).toBeDefined();
      // лечат дома — есть первая линия; направляют (аппендицит) — первая линия может быть пустой
      if (c.treatment!.setting.default === 'home') expect(c.treatment!.firstLine.length).toBeGreaterThan(0);
    }
    const antibiotics = Object.values(db.treatments).filter(t => t.class?.startsWith('antibiotic.')).map(t => t.id);
    expect(antibiotics.length).toBeGreaterThan(4);
    for (const viral of ['cond.arvi', 'cond.acute_bronchitis', 'cond.influenza', 'cond.covid19', 'cond.sinusitis_acute', 'cond.gastroenteritis']) {
      for (const a of antibiotics) expect(`${viral} ${a} ${txRole(db, viral, a)}`).toBe(`${viral} ${a} notIndicated`);
    }
    for (const bacterial of ['cond.strep_pharyngitis', 'cond.pneumonia_cap', 'cond.sinusitis_bacterial', 'cond.cystitis', 'cond.pyelonephritis']) {
      expect(db.conditions[bacterial].treatment!.firstLine.some(t => antibiotics.includes(t))).toBe(true);
    }
    // при аллергии на пенициллины есть чем заменить: в допустимых — не пенициллин
    const penicillins = Object.values(db.treatments).filter(t => t.class === 'antibiotic.penicillin').map(t => t.id);
    for (const bacterial of ['cond.strep_pharyngitis', 'cond.pneumonia_cap']) {
      expect(db.conditions[bacterial].treatment!.acceptable.some(t => antibiotics.includes(t) && !penicillins.includes(t))).toBe(true);
    }
  });

  test('ссылка на несуществующее лечение и лечение в двух списках', () => {
    const missing = broken(d => edit(d, 'conditions/therapy/arvi.yaml', 'firstLine: [tx.rest_fluids]', 'firstLine: [tx.rest]'));
    expect(missing.some(e => e.includes('tx.rest') && e.includes('не найдено'))).toBe(true);
    const twice = broken(d => edit(d, 'conditions/therapy/arvi.yaml', 'firstLine: [tx.rest_fluids]', 'firstLine: [tx.rest_fluids, tx.paracetamol]'));
    expect(twice.some(e => e.includes('в двух списках'))).toBe(true);
  });

  test('тактика не спорит с действием лечения', () => {
    // осельтамивир действует на грипп — «не показан» при нём быть не может
    const denied = broken(d => {
      edit(d, 'conditions/therapy/influenza.yaml', 'acceptable: [tx.oseltamivir]', 'acceptable: []');
      edit(d, 'conditions/therapy/influenza.yaml', 'notIndicated: [', 'notIndicated: [tx.oseltamivir, ');
    });
    expect(denied.some(e => e.includes('cond.influenza') && e.includes('действует на причину'))).toBe(true);
    // пневмония сама не проходит: первая линия, которая её не лечит, — ошибка
    const useless = broken(d => {
      edit(d, 'conditions/therapy/pneumonia_cap.yaml', 'firstLine: [tx.amoxicillin]', 'firstLine: [tx.rest_fluids]');
      edit(d, 'conditions/therapy/pneumonia_cap.yaml', 'supportive: [tx.paracetamol, tx.rest_fluids]', 'supportive: [tx.paracetamol, tx.amoxicillin]');
    });
    expect(useless.some(e => e.includes('cond.pneumonia_cap') && e.includes('первая линия не действует'))).toBe(true);
  });

  test('место по фактору риска, типичное назначение и «впервые выявленное» проверяются', () => {
    const risk = broken(d => edit(d, 'conditions/therapy/pyelonephritis.yaml', '{ id: risk.pregnancy, setting: ward }', '{ id: risk.pregnant, setting: ward }'));
    expect(risk.some(e => e.includes('неизвестного фактора risk.pregnant'))).toBe(true);
    const plan = broken(d => edit(d, 'conditions/therapy/cystitis.yaml', 'plan: [tx.fosfomycin]', 'plan: [tx.amoxicillin]'));
    expect(plan.some(e => e.includes('в типичном назначении tx.amoxicillin'))).toBe(true);
    const home = broken(d => edit(d, 'conditions/therapy/appendicitis.yaml', 'setting: { default: surgery }', 'setting: { default: home }'));
    expect(home.some(e => e.includes('cond.appendicitis: лечат дома, а первой линии нет'))).toBe(true);
    const excl = broken(d => edit(d, 'conditions/therapy/hypertension_new.yaml', 'excludes: [cond.hypertension]', 'excludes: [cond.acs]'));
    expect(excl.some(e => e.includes('исключающее cond.acs'))).toBe(true);
  });

  test('имя файла и идентификатор должны совпадать', () => {
    const errors = broken(d => edit(d, 'exams/crp.yaml', 'id: exam.crp', 'id: exam.crp_blood'));
    expect(errors.some(e => e.includes('не совпадает с именем файла'))).toBe(true);
  });

  test('полосы переводятся в числа по таблице 04-medical-model.md §4', () => {
    const { db } = buildDb();
    const cough = db.conditions['cond.acute_bronchitis'].findings.find(l => l.f === 'sym.cough')!;
    expect(cough.p).toBe(9500);
    const infiltrate = db.conditions['cond.arvi'].findings.find(l => l.f === 'img.cxr_infiltrate')!;
    expect(infiltrate.p).toBe(0);
    expect(db.exams['exam.flu_rapid'].checks[0]).toEqual({ f: 'lab.flu_ag', sens: 6200, spec: 9800 });
  });
});

// Каталог больницы (spec 2026-09-own-hospital): помещения, аппараты, должности и их связь с
// обследованиями.
describe('каталог больницы', () => {
  test('собран: у помещений — что открывают, у аппаратов — какие обследования, у должностей — где работают', () => {
    const { db } = buildDb();
    expect(Object.keys(db.rooms)).toHaveLength(14);
    // нанятый врач (spec 2026-09-hired-doctors): встаёт на место врача, нужна ординаторская с местами
    expect(db.roles['role.therapist']).toMatchObject({ hire: true, stands: 'role.doctor', needs: 'room.staff', rooms: ['room.office'] });
    expect(db.rooms['room.staff'].sizes.map(z => z.places)).toEqual([2, 4]);
    expect(db.rooms['room.office'].sizes.every(z => z.places === 0)).toBe(true);
    expect(db.rooms['room.lab'].exams).toContain('exam.cbc');
    expect(db.rooms['room.procedure'].collects).toContain('exam.cbc');
    expect(db.rooms['room.lab'].equipment).toContain('eq.biochem_analyzer');
    expect(db.equipment['eq.immuno_analyzer'].exams).toEqual(['exam.d_dimer', 'exam.tsh']);
    expect(db.equipment['eq.xray_digital'].upgradeOf).toBe('eq.xray_analog');
    expect(db.roles['role.nurse'].rooms).toEqual(['room.ecg', 'room.emergency', 'room.procedure', 'room.triage', 'room.ward']);
    // палата (spec 2026-09-chapter-2, часть 26): койки — места лежащих
    expect(db.rooms['room.ward'].sizes.map(z => z.beds)).toEqual([2, 4]);
    expect(db.rooms['room.office'].sizes.every(z => z.beds === 0)).toBe(true);
    // смотровая приёмного (часть 27): койки — места для пациентов скорой, одно, два, три
    expect(db.rooms['room.emergency']).toMatchObject({ emergency: true, beds: false, staff: ['role.nurse'] });
    expect(db.rooms['room.emergency'].sizes.map(z => z.beds)).toEqual([1, 2, 3]);
    // операционная (часть 28): бригада из трёх, стол и наркозный аппарат — каждый на своём месте
    expect(db.rooms['room.or']).toMatchObject({ needsEquipment: true, staff: ['role.surgeon', 'role.anesthetist', 'role.or_nurse'] });
    expect(db.equipment['eq.or_table']).toMatchObject({ slot: 1, exams: [] });
    expect(db.equipment['eq.anesthesia']).toMatchObject({ slot: 0, exams: [] });
    expect(db.treatments['tx.appendectomy'].surgery).toMatchObject({
      room: 'room.or', equipment: ['eq.or_table', 'eq.anesthesia'], minutes: 45, complications: 413, death: 3, complicated: { complications: 1875, death: 6 },
    });
    expect(db.conditions['cond.appendicitis'].surgery).toEqual({ tx: 'tx.appendectomy', window: 24 });
    // перфорация (часть 28б): Bickell 2006 — 2 % за первые 36 ч, дальше 5 % за 12 ч
    expect(db.conditions['cond.appendicitis'].complication).toEqual({ name: { ru: 'перфорация' }, early: { hours: 36, p: 200 }, later: { every: 12, p: 500 }, stay: [3, 5] });
    // кабинет УЗИ (часть 29): врач УЗД сам делает и сам описывает; экспертный аппарат — улучшение базового
    // с частью 33а — и УЗИ вен ног
    expect(db.rooms['room.ultrasound']).toMatchObject({ needsEquipment: true, staff: ['role.sonographer'], equipment: ['eq.us_basic', 'eq.us_expert'], exams: ['exam.us_abdomen', 'exam.us_kidney', 'exam.us_leg_veins'] });
    expect(db.equipment['eq.us_expert']).toMatchObject({ upgradeOf: 'eq.us_basic', speed: 0.85, quality: { sens: 5, spec: 1 }, exams: ['exam.us_abdomen', 'exam.us_kidney', 'exam.us_leg_veins'] });
    expect(db.exams['exam.us_abdomen']).toMatchObject({ kind: 'imaging', radiation: 'none' });
    // отросток — WSES 2020; камни — точность порядка 95 % (877_1); холецистит — 81 и 83 % (819_1, часть 30)
    expect(db.exams['exam.us_abdomen'].checks).toEqual([
      { f: 'img.us_appendicitis', sens: 7600, spec: 9500 }, { f: 'img.us_gallstones', sens: 9500, spec: 9500 }, { f: 'img.us_cholecystitis', sens: 8100, spec: 8300 },
      // дивертикулит — 92 и 90 % (Laméris 2008, часть 30д)
      { f: 'img.us_diverticulitis', sens: 9200, spec: 9000 },
    ]);
    expect(Object.values(db.roles).filter(r => r.reads).map(r => r.id).sort()).toEqual(['role.radiologist', 'role.sonographer']);
    expect(db.roles['role.sonographer'].rooms).toEqual(['room.ultrasound']);
    expect(db.conditions['cond.appendicitis'].findings).toContainEqual(expect.objectContaining({ f: 'img.us_appendicitis' }));
    expect(db.roles['role.doctor'].hire).toBe(false);
    expect(db.rooms['room.waiting'].sizes.map(z => z.seats)).toEqual([6, 10, 18]);
    // у каждого обследования в лаборатории, ЭКГ и рентгене — аппарат
    for (const e of Object.values(db.exams)) if (e.room && db.rooms[e.room].needsEquipment) expect(e.equipment?.length).toBeGreaterThan(0);
  });

  test('пояснение — только у точной частоты; точная без пояснения — предупреждение', () => {
    const loose = broken(d => edit(d, 'conditions/therapy/appendicitis.yaml', '  - { f: lab.crp_high, band: often }', '  - { f: lab.crp_high, band: often, note: "частота по полосе, пояснять нечего" }'));
    expect(loose.some(e => e.includes('cond.appendicitis: у lab.crp_high пояснение (note) — только у точной частоты'))).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'anamnez-content-'));
    try {
      cpSync(CONTENT_DIR, dir, { recursive: true });
      const p = join(dir, 'conditions/therapy/appendicitis.yaml');
      writeFileSync(p, readFileSync(p, 'utf8').replace(/\n {4}note: "[^"]*"/, ''));
      expect(buildDb(dir).warnings.some(w => w.includes('cond.appendicitis: точная частота img.us_appendicitis = 100 %'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('снимки описывает один человек и там, где их делают', () => {
    const two = broken(d => edit(d, 'hospital/roles/radiographer.yaml', 'salary: [1500, 2500]\n', 'salary: [1500, 2500]\nreads: true\n'));
    expect(two.some(e => e.includes('room.xray: снимки описывают сразу role.radiographer и role.radiologist — должен один'))).toBe(true);
    const lab = broken(d => edit(d, 'hospital/roles/lab_tech.yaml', 'salary: [1400, 2300]\n', 'salary: [1400, 2300]\nreads: true\n'));
    expect(lab.some(e => e.includes('role.lab_tech: описывает снимки, а там, где он работает, снимков не делают'))).toBe(true);
  });

  test('помещение принимает отделение без болезней; у болезни, с которой приходят, меньше трёх признаков (часть 30)', () => {
    const empty = broken(d => edit(d, 'hospital/rooms/emergency.yaml', 'admits: [dept.surgery, dept.trauma]', 'admits: [dept.surgery, dept.cardiology]'));
    expect(empty.some(e => e.includes('room.emergency: принимает dept.cardiology, а болезней этого отделения в базе нет'))).toBe(true);
    // хроническому фону — камням в пузыре — двух признаков хватает, с ними не приходят
    const few = broken(d => edit(d, 'conditions/surgery/cholelithiasis.yaml', 'presenting: false\n', ''));
    expect(few.some(e => e.includes('cond.cholelithiasis') && e.includes('меньше трёх признаков'))).toBe(true);
    expect(buildDb().db.conditions['cond.cholelithiasis'].findings).toHaveLength(2);
  });

  test('тактика по параметру (часть 32): условие по объявленному параметру, лечения есть и не повторяются, назначение — из показанного, без операции, причину не «не показано»', () => {
    const R = 'conditions/trauma/distal_radius_fracture.yaml';
    const has = (errors: string[], text: string) => errors.some(e => e.includes(text));
    expect(has(broken(d => edit(d, R, '    - when: { displacement: [displaced] }\n', '    - when: { shift: [displaced] }\n')), 'cond.distal_radius_fracture: тактика по параметру №2 — условие по необъявленному параметру shift')).toBe(true);
    expect(has(broken(d => edit(d, R, '    - when: { displacement: [displaced] }\n', '    - when: { displacement: [bent] }\n')), 'тактика по параметру №2 — у параметра displacement нет значения bent')).toBe(true);
    expect(has(broken(d => edit(d, R, '      firstLine: [tx.closed_reduction]\n', '      firstLine: [tx.traction]\n')), 'тактика по параметру №2 — лечение tx.traction не найдено')).toBe(true);
    expect(has(broken(d => edit(d, R, '      acceptable: [tx.radius_plate]\n      supportive: [tx.cast_splint]\n', '      acceptable: [tx.radius_plate, tx.cast_splint]\n      supportive: [tx.cast_splint]\n')), 'тактика по параметру №2 — лечение tx.cast_splint стоит в двух списках')).toBe(true);
    expect(has(broken(d => edit(d, R, '      plan: [tx.closed_reduction, tx.ibuprofen]\n', '      plan: [tx.closed_reduction, tx.rice]\n')), 'тактика по параметру №2 — в типичном назначении tx.rice — не из первой линии')).toBe(true);
    expect(has(broken(d => edit(d, R, '      plan: [tx.closed_reduction, tx.ibuprofen]\n', '      plan: [tx.radius_plate, tx.ibuprofen]\n')), 'тактика по параметру №2 — операцию tx.radius_plate выбирают «В операционную»')).toBe(true);
    expect(has(broken(d => edit(d, R, '    - when: { displacement: [none] }\n      acceptable: [tx.radius_plate]\n', '    - when: { displacement: [none] }\n      acceptable: [tx.radius_plate]\n      notIndicated: [tx.cast_splint]\n')), 'тактика по параметру №1 — tx.cast_splint при этих значениях действует на причину')).toBe(true);
    // срока операции нет — тогда нет и срока от начала болезни
    expect(has(broken(d => edit(d, R, 'surgery: { tx: tx.radius_plate, stay: [1, 3] }', 'surgery: { tx: tx.radius_plate, from: onset, stay: [1, 3] }')), 'срок от начала болезни и осложнённая стадия — только со сроком операции (window)')).toBe(true);
  });

  test('операция и место по параметру (часть 32б): своя операция, вида «операция», действует на причину; ещё место — не то же, что главное', () => {
    const H = 'conditions/trauma/femoral_neck_fracture.yaml';
    const K = 'conditions/trauma/clavicle_fracture.yaml';
    const has = (errors: string[], text: string) => errors.some(e => e.includes(text));
    const op = '    - { when: { displacement: [none] }, tx: tx.hip_screws }\n';
    expect(has(broken(d => edit(d, H, op, '    - { when: { shift: [none] }, tx: tx.hip_screws }\n')), 'cond.femoral_neck_fracture: операция по параметру №1 — условие по необъявленному параметру shift')).toBe(true);
    expect(has(broken(d => edit(d, H, op, '    - { when: { displacement: [none] }, tx: tx.hip_nail }\n')), 'операция по параметру №1 — операция tx.hip_nail не найдена')).toBe(true);
    expect(has(broken(d => edit(d, H, op, '    - { when: { displacement: [none] }, tx: tx.cast_splint }\n')), 'операция по параметру №1 — tx.cast_splint не операция')).toBe(true);
    expect(has(broken(d => edit(d, H, op, '    - { when: { displacement: [none] }, tx: tx.radius_plate }\n')), 'операция по параметру №1 — tx.radius_plate при этих значениях не действует на причину')).toBe(true);
    expect(has(broken(d => edit(d, H, op, '    - { when: { displacement: [none] }, tx: tx.hip_arthroplasty }\n')), 'операция по параметру №1 — та же операция, что и без условия')).toBe(true);
    const also = '      - { when: { displacement: [displaced] }, settings: [home] }\n';
    expect(has(broken(d => edit(d, K, also, '      - { when: { displacement: [displaced] }, settings: [surgery] }\n')), 'cond.clavicle_fracture: ещё место №1 — surgery и так место при этих значениях')).toBe(true);
    expect(has(broken(d => edit(d, K, also, '      - { when: { displacement: [bent] }, settings: [home] }\n')), 'ещё место №1 — у параметра displacement нет значения bent')).toBe(true);
  });

  test('правило решения (часть 32): жалоба с текстом жалобы, признаки, болезни и обследование, которое проверяет их признаки', () => {
    const O = 'rules/ottawa_ankle.yaml';
    const has = (errors: string[], text: string) => errors.some(e => e.includes(text));
    expect(has(broken(d => edit(d, O, 'complaints: [sym.ankle_pain]', 'complaints: [sign.ankle_swelling]')), 'rule.ottawa_ankle: жалоба sign.ankle_swelling не найдена или без текста жалобы')).toBe(true);
    expect(has(broken(d => edit(d, O, 'any: [sign.malleolus_tenderness, sign.no_weight_bearing]', 'any: [sign.malleolus_pain]')), 'rule.ottawa_ankle: признак sign.malleolus_pain не найден')).toBe(true);
    expect(has(broken(d => edit(d, O, 'about: [cond.ankle_fracture, cond.ankle_sprain]', 'about: [cond.ankle_break]')), 'rule.ottawa_ankle: болезнь cond.ankle_break не найдена')).toBe(true);
    expect(has(broken(d => edit(d, O, 'exams: [exam.xray_ankle]', 'exams: [exam.xray_wrist]')), 'rule.ottawa_ankle: exam.xray_wrist не проверяет ни одного признака cond.ankle_fracture, cond.ankle_sprain')).toBe(true);
  });

  test('правило КТ (часть 32г): дополнительные признаки, возраст, круг применимости, обследование вне игры; производный параметр', () => {
    const R = 'rules/ct_head.yaml';
    const C = 'conditions/trauma/concussion.yaml';
    const has = (errors: string[], text: string) => errors.some(e => e.includes(text));
    const drop = (dir: string, file: string, start: string) => {
      const p = join(dir, file);
      const lines = readFileSync(p, 'utf8').split('\n');
      if (!lines.some(l => l.startsWith(start))) throw new Error(`в ${file} нет строки «${start}…»`);
      writeFileSync(p, lines.filter(l => !l.startsWith(start)).join('\n'));
    };
    const minor = 'minor: { any: [sym.loss_of_consciousness], count: 2 }';
    const age = 'age: { main: 60, minor: [40, 60] }';
    // независимые поломки — в одной копии: сборка каждой копии — полсекунды
    const a = broken(d => {
      edit(d, R, minor, 'minor: { any: [sym.vomiting], count: 2 }');
      drop(d, R, '  na: ');
      drop(d, R, '  exam: ');
    });
    expect(has(a, 'rule.ct_head: sym.vomiting — и основной, и дополнительный признак')).toBe(true);
    expect(has(a, 'rule.ct_head: у правила с кругом применимости нужен текст «не применяется» (texts.na)')).toBe(true);
    expect(has(a, 'rule.ct_head: обследования правила в игре нет — нужен текст о нём (texts.exam)')).toBe(true);
    const b = broken(d => {
      edit(d, R, minor, 'minor: { any: [sym.loss_of_consciousness], count: 3 }');
      edit(d, R, age, 'age: { main: 50, minor: [40, 60] }');
    });
    expect(has(b, 'rule.ct_head: дополнительных признаков меньше, чем их нужно (3)')).toBe(true);
    expect(has(b, 'rule.ct_head: основной возраст (старше 50) пересекается с дополнительным')).toBe(true);
    expect(has(broken(d => edit(d, R, age, 'age: { main: 60, minor: [60, 40] }')), 'rule.ct_head: возраст дополнительного признака — от меньшего к большему')).toBe(true);
    // производный параметр: правило есть, значения — no и yes, признаки от него не зависят
    const c = broken(d => {
      edit(d, C, '  ct: rule.ct_head', '  ct: rule.ct_brain');
      edit(d, C, '{ f: sym.nausea, band: sometimes }', '{ f: sym.nausea, band: sometimes, when: { ct: [yes] } }');
      // обследование только при жалобе — жалоба должна быть
      edit(d, 'exams/ask_head_injury.yaml', 'complaints: [sym.head_injury, sym.head_wound]', 'complaints: [sym.head_trauma, sym.head_wound]');
    });
    expect(has(c, 'exam.ask_head_injury: жалоба sym.head_trauma не найдена или без текста жалобы')).toBe(true);
    expect(has(c, 'cond.concussion: правило rule.ct_brain параметра ct не найдено')).toBe(true);
    expect(has(c, 'cond.concussion: признак sym.nausea зависит от производного параметра ct, а тот — от признаков')).toBe(true);
    expect(has(broken(d => edit(d, C, 'ct: { no: 32, yes: 68 }', 'ct: { none: 32, yes: 68 }')), 'cond.concussion: у производного параметра ct значения — no и yes')).toBe(true);
  });

  test('возраст «и старше» (часть 32д): у колена — с 55 лет; вместе со «старше» или внутри дополнительного — ошибка', () => {
    const has = (errors: string[], text: string) => errors.some(e => e.includes(text));
    const a = broken(d => {
      edit(d, 'rules/ottawa_knee.yaml', 'age: { from: 55 }', 'age: { main: 54, from: 55 }');
      edit(d, 'rules/ct_head.yaml', 'age: { main: 60, minor: [40, 60] }', 'age: { from: 60, minor: [40, 60] }');
    });
    expect(has(a, 'rule.ottawa_knee: возраст — либо «старше» (main), либо «и старше» (from)')).toBe(true);
    expect(has(a, 'rule.ct_head: основной возраст (60 и старше) пересекается с дополнительным')).toBe(true);
  });

  test('до приезда скорой (часть 32д-2): операция, не из типичного назначения или при значениях, которые лечат дома, — ошибка', () => {
    const has = (errors: string[], text: string) => errors.some(e => e.includes(text));
    const B = 'conditions/trauma/burn.yaml';
    const a = broken(d => {
      edit(d, B, 'preHospital: [tx.iv_fluids]', 'preHospital: [tx.appendectomy]');
      edit(d, B, 'preHospital: [tx.burn_dressing, tx.wound_dressing]', 'preHospital: [tx.ors]');
      edit(d, B, '      prevent: [tx.tetanus_toxoid]\n', '      prevent: [tx.tetanus_toxoid]\n      preHospital: [tx.burn_dressing]\n');
    });
    expect(has(a, 'cond.burn: тактика по параметру №1 — до приезда скорой операцию tx.appendectomy не сделать')).toBe(true);
    expect(has(a, 'cond.burn: тактика по параметру №2 — в типичном назначении нет ничего из того, что делают до приезда скорой')).toBe(true);
    expect(has(a, 'cond.burn: тактика по параметру №3 — до приезда скорой: при этих значениях лечат дома')).toBe(true);
    expect(buildDb().errors).toEqual([]);
  });

  test('когда правило не применяют (часть 33а): признак есть в базе и не выполняет правило; без исключений текст «не применяется» лишний', () => {
    const W = 'rules/wells_dvt.yaml';
    const has = (errors: string[], text: string) => errors.some(e => e.includes(text));
    const excludes = 'excludes: [sign.superficial_cord, hx.pregnancy]';
    const a = broken(d => {
      edit(d, W, excludes, 'excludes: [sign.superficial_vein_cord, hx.leg_cast]');
      const p = join(d, W);
      writeFileSync(p, readFileSync(p, 'utf8').split('\n').filter(l => !l.startsWith('  na: ')).join('\n'));
    });
    expect(has(a, 'rule.wells_dvt: признак sign.superficial_vein_cord не найден')).toBe(true);
    expect(has(a, 'rule.wells_dvt: hx.leg_cast — и в правиле, и среди признаков, при которых его не применяют')).toBe(true);
    expect(has(a, 'rule.wells_dvt: у правила с кругом применимости нужен текст «не применяется» (texts.na)')).toBe(true);
    const b = broken(d => edit(d, W, `${excludes}\n`, ''));
    expect(has(b, 'rule.wells_dvt: текст «не применяется» без круга применимости (requires или excludes)')).toBe(true);
  });

  test('смотровая приёмного без мест для скорой; шкала с щелью между полосами или с чужим признаком', () => {
    const bare = broken(d => edit(d, 'hospital/rooms/emergency.yaml', '      - [bed, 2, 2]\n', ''));
    expect(bare.some(e => e.includes('room.emergency S: смотровая приёмного без мест для скорой'))).toBe(true);
    const gap = broken(d => edit(d, 'scores/news2.yaml', '[[null, 8, 3], [9, 11, 1]', '[[null, 8, 3], [10, 11, 1]'));
    expect(gap.some(e => e.includes('score.news2: vital.tachypnea — после 8 следующая полоса должна начинаться с 9'))).toBe(true);
    const alien = broken(d => edit(d, 'scores/news2.yaml', '  - f: vital.fever\n', '  - f: sym.cough\n'));
    expect(alien.some(e => e.includes('score.news2: признак sym.cough не найден или без числового значения'))).toBe(true);
    // скорая везёт только лёгкое, а лёгкого не везут — дня со смотровой не начать
    const nobody = broken(d => edit(d, 'hospital/economy.yaml', 'weight: { minor: 0, moderate: 1, serious: 3, critical: 12 }', 'weight: { minor: 0, moderate: 0, serious: 0, critical: 0 }'));
    expect(nobody.some(e => e.includes('dept.therapy: скорой некого везти'))).toBe(true);
  });

  test('операция: у болезни — не операция; у операции — чужая бригада, аппарат из другого помещения, место аппарата за краем', () => {
    const notOp = broken(d => edit(d, 'conditions/therapy/appendicitis.yaml', 'surgery: { tx: tx.appendectomy, window: 24 }', 'surgery: { tx: tx.paracetamol, window: 24 }'));
    expect(notOp.some(e => e.includes('cond.appendicitis: tx.paracetamol — не операция (kind: surgery)'))).toBe(true);
    const kind = broken(d => edit(d, 'treatments/appendectomy.yaml', 'kind: surgery', 'kind: procedure'));
    expect(kind.some(e => e.includes('tx.appendectomy: у операции (kind: surgery) должен быть блок surgery, и только у неё'))).toBe(true);
    const team = broken(d => edit(d, 'treatments/appendectomy.yaml', 'team: [role.surgeon, role.anesthetist, role.or_nurse]', 'team: [role.surgeon, role.nurse]'));
    expect(team.some(e => e.includes('tx.appendectomy: role.nurse — не из штата room.or'))).toBe(true);
    const alien = broken(d => edit(d, 'treatments/appendectomy.yaml', 'equipment: [eq.or_table, eq.anesthesia]', 'equipment: [eq.or_table, eq.ecg]'));
    expect(alien.some(e => e.includes('tx.appendectomy: аппарат eq.ecg стоит в room.ecg, а операция — в room.or'))).toBe(true);
    const slot = broken(d => edit(d, 'hospital/equipment/or_table.yaml', 'slot: 1', 'slot: 2'));
    expect(slot.some(e => e.includes('eq.or_table: места 2 под аппарат нет у всех размеров room.or'))).toBe(true);
    // осложнённая стадия (часть 28б): у операции нет долей для неё, доля за отрезок — 100 %, срок наоборот
    const stage = broken(d => edit(d, 'treatments/appendectomy.yaml', '  complicated: { complications: { pct: 18.75 }, death: { pct: 0.06 } }\n', ''));
    expect(stage.some(e => e.includes('cond.appendicitis: у болезни есть осложнённая стадия, а у операции tx.appendectomy нет долей для неё (complicated)'))).toBe(true);
    const all = broken(d => edit(d, 'conditions/therapy/appendicitis.yaml', 'early: { hours: 36, p: { pct: 2 } }', 'early: { hours: 36, p: { pct: 100 } }'));
    expect(all.some(e => e.includes('cond.appendicitis: доля осложнённой стадии за отрезок должна быть меньше 100 %'))).toBe(true);
    const back = broken(d => edit(d, 'conditions/therapy/appendicitis.yaml', '  stay: [3, 5]\n', '  stay: [5, 3]\n'));
    expect(back.some(e => e.includes('cond.appendicitis: срок стационара в осложнённой стадии — от большего к меньшему'))).toBe(true);
    // лечит не ту болезнь, что в записи болезни
    const cure = broken(d => edit(d, 'treatments/appendectomy.yaml', 'on: cond.appendicitis, kind: cure', 'on: cond.gastroenteritis, kind: cure'));
    expect(cure.some(e => e.includes('cond.appendicitis: операция tx.appendectomy не действует на причину'))).toBe(true);
  });

  test('обследование с неизвестным аппаратом или аппаратом из чужого помещения', () => {
    const unknown = broken(d => edit(d, 'exams/tsh.yaml', 'equipment: [eq.immuno_analyzer]', 'equipment: [eq.immuno]'));
    expect(unknown.some(e => e.includes('exam.tsh: аппарат eq.immuno не найден'))).toBe(true);
    const foreign = broken(d => {
      edit(d, 'exams/tsh.yaml', 'equipment: [eq.immuno_analyzer]', 'equipment: [eq.ecg]');
      // D-димер (часть 33а) — и на биохимическом анализаторе
      edit(d, 'exams/d_dimer.yaml', 'equipment: [eq.biochem_analyzer, eq.immuno_analyzer]', 'equipment: [eq.biochem_analyzer]');
    });
    expect(foreign.some(e => e.includes('exam.tsh: аппарат eq.ecg стоит в room.ecg'))).toBe(true);
    // и тогда иммунохимическим анализатором ничего не делают
    expect(foreign.some(e => e.includes('eq.immuno_analyzer: ни одно обследование и ни одна операция им не делают'))).toBe(true);
  });

  test('в лаборатории без аппарата не работают — у анализа должен быть анализатор', () => {
    const errors = broken(d => edit(d, 'exams/tsh.yaml', 'equipment: [eq.immuno_analyzer]\n', ''));
    expect(errors.some(e => e.includes('exam.tsh: в room.lab без аппарата не работают'))).toBe(true);
  });

  test('шаблон помещения: предмет в ряду под подпись, место на столе, должность без места', () => {
    const label = broken(d => edit(d, 'hospital/rooms/reception.yaml', '[cabinet, 4, 2]', '[cabinet, 4, 1]'));
    expect(label.some(e => e.includes('room.reception S: cabinet (4, 1) — в ряду под подпись или в проходе у двери'))).toBe(true);
    const walkway = broken(d => edit(d, 'hospital/rooms/reception.yaml', '[plant, 4, 4]', '[plant, 4, 5]'));
    expect(walkway.some(e => e.includes('plant (4, 5) — в ряду под подпись или в проходе у двери'))).toBe(true);
    const onDesk = broken(d => edit(d, 'hospital/rooms/reception.yaml', 'patient: [2, 4]', 'patient: [2, 3]'));
    expect(onDesk.some(e => e.includes('место пациента (2, 3) занято: desk'))).toBe(true);
    const noSpot = broken(d => edit(d, 'hospital/rooms/xray.yaml', ', role.radiologist: [1, 4] }', ' }'));
    expect(noSpot.some(e => e.includes('room.xray M: не сказано, где стоит role.radiologist'))).toBe(true);
  });

  test('неизвестная должность и дверь за стеной', () => {
    const role = broken(d => edit(d, 'hospital/rooms/lab.yaml', 'staff: [role.lab_tech]', 'staff: [role.laborant]'));
    expect(role.some(e => e.includes('room.lab: должность role.laborant не найдена'))).toBe(true);
    const door = broken(d => edit(d, 'hospital/rooms/toilet.yaml', 'door: { x: 3 }', 'door: { x: 5 }'));
    expect(door.some(e => e.includes('room.toilet S: дверь выходит за стену'))).toBe(true);
  });
});

describe('готовые больницы', () => {
  test('помещение на чужом полу и помещение без человека — ошибки валидатора', () => {
    const overlap = broken(d => edit(d, 'hospital/presets/clinic.yaml', '{ type: room.triage, size: S, x: 5, y: 0, rot: 0, door: 3 }', '{ type: room.triage, size: S, x: 4, y: 0, rot: 0, door: 3 }'));
    expect(overlap.some(e => e.includes('preset.clinic: помещение 1 (room.triage) — не ставится: blocked'))).toBe(true);
    const nobody = broken(d => edit(d, 'hospital/presets/clinic.yaml', '  - { role: role.radiologist, room: 7 }\n', ''));
    expect(nobody.some(e => e.includes('preset.clinic: room.xray (r8) не работает: noStaff role.radiologist'))).toBe(true);
    const bench = broken(d => edit(d, 'hospital/presets/clinic.yaml', '[bench, 9, 9]', '[bench, 9, 11]'));
    expect(bench.some(e => e.includes('preset.clinic: bench (9, 11) — не в коридоре'))).toBe(true);
  });
});

describe('кампания', () => {
  test('заданные пациенты главы — болезни приёма её отделения', () => {
    const chronic = broken(d => edit(d, 'campaign/chapters/district.yaml', 'tutorial: [cond.arvi,', 'tutorial: [cond.copd,'));
    expect(chronic.some(e => e.includes('chapter.district: болезнь обучения cond.copd — не из приёма отделения dept.therapy'))).toBe(true);
  });

  test('подсказка: от персонажа игры, о болезни, с которой приходят, со ссылками на статьи; порядок не повторяется', () => {
    const who = broken(d => edit(d, 'campaign/tips/start.yaml', 'from: char.mentor', 'from: char.nurse'));
    expect(who.some(e => e.includes('tip.start: персонаж char.nurse не найден'))).toBe(true);
    const cond = broken(d => edit(d, 'campaign/tips/strep.yaml', 'condition: cond.strep_pharyngitis', 'condition: cond.copd'));
    expect(cond.some(e => e.includes('tip.strep: болезнь cond.copd не найдена или с ней не приходят'))).toBe(true);
    const see = broken(d => edit(d, 'campaign/tips/urine.yaml', 'see: [exam.urine_dipstick,', 'see: [exam.urine_strip,'));
    expect(see.some(e => e.includes('tip.urine: статья exam.urine_strip не найдена'))).toBe(true);
    const order = broken(d => edit(d, 'campaign/tips/review.yaml', 'order: 6', 'order: 5'));
    expect(order.some(e => e.includes('порядок 5 уже у другой подсказки'))).toBe(true);
  });
});

describe('достижения', () => {
  test('помещение, глава и отделение — существующие; порядок не повторяется; вид — известный', () => {
    const room = broken(d => edit(d, 'achievements/lab.yaml', 'room: room.lab', 'room: room.laboratory'));
    expect(room.some(e => e.includes('ach.lab: помещение room.laboratory не найдено'))).toBe(true);
    const chapter = broken(d => edit(d, 'achievements/district.yaml', 'chapter: chapter.district', 'chapter: chapter.city'));
    expect(chapter.some(e => e.includes('ach.district: глава chapter.city не найдена'))).toBe(true);
    const dept = broken(d => edit(d, 'achievements/therapy.yaml', 'department: dept.therapy', 'department: dept.cardiology'));
    expect(dept.some(e => e.includes('ach.therapy: в отделении dept.cardiology нет болезней'))).toBe(true);
    const order = broken(d => edit(d, 'achievements/month.yaml', 'order: 5', 'order: 4'));
    expect(order.some(e => e.includes('порядок 4 уже у другого достижения'))).toBe(true);
    const kind = broken(d => edit(d, 'achievements/month.yaml', 'kind: days', 'kind: streakDays'));
    expect(kind.some(e => e.startsWith('achievements/month.yaml:'))).toBe(true);
  });
});
