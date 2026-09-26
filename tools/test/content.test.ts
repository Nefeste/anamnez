// Валидатор базы (`docs/05-content.md` §6): ловит битые ссылки и нарушения правил,
// а не только опечатки схемы. Проверяется на испорченной копии базы.
import { describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { txRole } from '../../src/engine/med/plan';
import { buildDb, CONTENT_DIR } from '../content/load';

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
  test('настоящая база — без ошибок; у каждой болезни есть источник и отметка проверки', () => {
    const { db, errors } = buildDb();
    expect(errors).toEqual([]);
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
    const home = broken(d => edit(d, 'conditions/therapy/appendicitis.yaml', 'setting: { default: ambulance }', 'setting: { default: home }'));
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
