// Значки строк карты пациента (вопрос 49): у каждого признака, обследования, назначения и болезни базы — значок;
// таблицы itemIcons.ts — только из строк базы, без повторов; жалобы, находки осмотра и анамнез — в таблице явно, а не
// значком по умолчанию; рисунки itemIconShapes.ts — абсолютными командами SVG в сетке 24 × 24, как iconShapes.ts.
import { describe, expect, test } from 'bun:test';
import { buildDb } from '../content/load';
import { ICON_GRID } from '../../src/ui/iconShapes';
import { ITEM_SHAPES } from '../../src/ui/itemIconShapes';
import { conditionIcon, EXAMS, examIcon, findingIcon, FINDINGS, iconShape, type ItemIcon, treatmentIcon, TREATMENTS } from '../../src/ui/itemIcons';

const { db } = buildDb();

/** Числа контура по командам: у дуги A флаги — не координаты, их не проверяем. */
function coords(d: string): number[] {
  const out: number[] = [];
  for (const m of d.matchAll(/([MLHVCSQTAZ])([^MLHVCSQTAZ]*)/g)) {
    const nums = (m[2].match(/-?\d*\.?\d+/g) ?? []).map(Number);
    if (m[1] === 'A') for (let i = 0; i + 6 < nums.length + 1; i += 7) out.push(nums[i + 5], nums[i + 6]);
    else out.push(...nums);
  }
  return out;
}

const drawn = (icon: ItemIcon) => {
  const s = iconShape(icon);
  return !!s && s.stroke.length > 0;
};

describe('значки строк карты', () => {
  test('рисунки — абсолютными командами SVG, координаты — в сетке 24 × 24', () => {
    for (const [k, shape] of Object.entries(ITEM_SHAPES)) {
      const all = [...shape.stroke, ...('fill' in shape ? shape.fill : [])];
      expect(all.length, k).toBeGreaterThan(0);
      for (const d of all) {
        expect(d, k).toMatch(/^M[\d.\sMLHVCSQTAZ-]+$/);
        for (const x of coords(d)) expect(x >= 0 && x <= ICON_GRID, `${k}: ${x}`).toBe(true);
      }
    }
  });

  test('таблицы — только из строк базы, каждая строка — один раз', () => {
    for (const [name, table, rows] of [['признаки', FINDINGS, db.findings], ['обследования', EXAMS, db.exams], ['лечение', TREATMENTS, db.treatments]] as const) {
      const ids = Object.values(table).flat();
      expect({ name, stale: ids.filter(id => !(id in rows)) }).toEqual({ name, stale: [] });
      expect({ name, twice: ids.filter((id, i) => ids.indexOf(id) !== i) }).toEqual({ name, twice: [] });
      for (const icon of Object.keys(table) as ItemIcon[]) expect({ icon, drawn: drawn(icon) }).toEqual({ icon, drawn: true });
    }
  });

  test('жалобы, находки осмотра и анамнез — в таблице явно: значок по месту и природе, а не по умолчанию', () => {
    const listed = new Set(Object.values(FINDINGS).flat());
    const missing = Object.entries(db.findings).filter(([id, f]) => ['sym', 'sign', 'hx'].includes(f.kind) && !listed.has(id)).map(([id]) => id);
    expect(missing).toEqual([]);
  });

  test('у каждой строки базы — нарисованный значок', () => {
    const lack: string[] = [];
    for (const id of Object.keys(db.findings)) if (!drawn(findingIcon(id))) lack.push(id);
    for (const id of Object.keys(db.exams)) if (!drawn(examIcon(id))) lack.push(id);
    for (const id of Object.keys(db.treatments)) if (!drawn(treatmentIcon(id))) lack.push(id);
    for (const id of Object.keys(db.conditions)) if (!drawn(conditionIcon(id))) lack.push(id);
    expect(lack).toEqual([]);
  });

  test('анализ, снимок и ЭКГ — значком обследования, которое их находит', () => {
    expect(findingIcon('img.cxr_infiltrate')).toBe('xray');
    expect(findingIcon('img.ct_blood')).toBe('ct');
    expect(findingIcon('img.egd_ulcer')).toBe('scope');
    expect(findingIcon('img.us_gallstones')).toBe('us');
    expect(findingIcon('lab.crp_high')).toBe('blood');
    expect(findingIcon('lab.urine_leuk')).toBe('urine');
    expect(findingIcon('lab.flu_ag')).toBe('rapid');
    expect(findingIcon('ecg.st_elevation')).toBe('ecg');
    expect(findingIcon('vital.fever')).toBe('temp');
    expect(findingIcon('vital.spo2_low')).toBe('spo2');
    expect(findingIcon('vital.bp_high')).toBe('pressure');
  });

  test('лечение — по пути введения, операции — скальпелем, болезнь — по системе органов', () => {
    expect(treatmentIcon('tx.amoxicillin')).toBe('pill');
    expect(treatmentIcon('tx.antibiotic_iv')).toBe('drip');
    expect(treatmentIcon('tx.epinephrine_im')).toBe('syringe');
    expect(treatmentIcon('tx.salbutamol')).toBe('inhaler');
    expect(treatmentIcon('tx.nasal_steroid')).toBe('spray');
    expect(treatmentIcon('tx.oxygen_mask')).toBe('oxygen');
    expect(treatmentIcon('tx.appendectomy')).toBe('scalpel');
    expect(conditionIcon('cond.pneumonia_cap')).toBe('sys.lungs');
    expect(conditionIcon('cond.asthma')).toBe('sys.lungs');
    expect(conditionIcon('cond.hypertension')).toBe('sys.heart');
  });
});
