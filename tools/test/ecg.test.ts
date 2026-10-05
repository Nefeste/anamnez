// ЭКГ в двенадцати отведениях кодом (spec 2026-10-chapter-3, часть 36; 06-architecture.md §11): сердце —
// диполь, отведения — проекции. Проверки — по сигналу, как у врача на ленте: подъём ST в отведениях своей
// стенки и зеркальная депрессия напротив, ритм и проведение — по интервалам; и лист без экрана.
import { beforeAll, describe, expect, test } from 'bun:test';
import { db } from '../../src/content';
import { generatePatient } from '../../src/engine/med/generate';
import type { Observation } from '../../src/engine/med/types';
import { ECG_HZ, type EcgFindings, type EcgTrace, type Lead, LEADS, synthEcg12 } from '../../src/render/ecg/model';
import { makeCaseView } from '../../src/state/caseView';
import { loadSkia, luma, rasterize } from '../imaging/headless';

const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);

/** Изолиния перед комплексом — сегмент PQ (у трепетания и фибрилляции его нет). */
function baseline(s: Float32Array, qrs: number): number {
  let sum = 0, n = 0;
  for (let i = Math.round((qrs - 0.03) * ECG_HZ); i < Math.round((qrs - 0.005) * ECG_HZ); i++) {
    sum += s[i];
    n++;
  }
  return sum / n;
}

/** Средние по комплексам середины ленты: смещение ST через 60 мс после точки J, площадь QRS, размах, T. */
function measure(tr: EcgTrace, lead: Lead) {
  const s = tr.leads[lead];
  const beats = tr.beats.filter(b => b.qrs > 0.5 && b.j + 0.5 < tr.seconds);
  let st = 0, area = 0, max = 0, min = 0, t = 0;
  for (const b of beats) {
    const base = baseline(s, b.qrs);
    st += s[Math.round((b.j + 0.06) * ECG_HZ)] - base;
    let hi = -Infinity, lo = Infinity;
    for (let i = Math.round(b.qrs * ECG_HZ); i <= Math.round(b.j * ECG_HZ); i++) {
      area += (s[i] - base) / ECG_HZ;
      hi = Math.max(hi, s[i] - base);
      lo = Math.min(lo, s[i] - base);
    }
    max += hi;
    min += lo;
    let tm = 0;
    for (let i = Math.round((b.j + 0.1) * ECG_HZ); i < Math.round((b.j + 0.3) * ECG_HZ); i++) if (Math.abs(s[i] - base) > Math.abs(tm)) tm = s[i] - base;
    t += tm;
  }
  const k = beats.length;
  return { st: st / k, area: (area / k) * 1000, max: max / k, min: min / k, t: t / k };
}

const trace = (f: EcgFindings, seed = 1) => synthEcg12(f, seed, 10);
const rr = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i]);
const cv = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) / m;
};
const perMinute = (times: number[]) => 60 / (rr(times).reduce((a, b) => a + b, 0) / (times.length - 1));

describe('ЭКГ: вектор сердца и двенадцать отведений', () => {
  test('одно зерно и те же находки — та же лента; другое зерно — другая', () => {
    const a = trace({ stemi: 'inferior' }, 5), b = trace({ stemi: 'inferior' }, 5), c = trace({ stemi: 'inferior' }, 6);
    for (const lead of LEADS) expect(Array.from(a.leads[lead])).toEqual(Array.from(b.leads[lead]));
    expect(Array.from(a.leads.II)).not.toEqual(Array.from(c.leads.II));
  });

  test('норма: QRS вверх в I, II, aVF, V5, V6 и вниз в aVR и V1; R растёт от V1 к V5', () => {
    for (const seed of SEEDS) {
      const tr = trace({}, seed);
      for (const lead of ['I', 'II', 'aVF', 'V5', 'V6'] as const) expect(measure(tr, lead).area).toBeGreaterThan(0);
      for (const lead of ['aVR', 'V1'] as const) expect(measure(tr, lead).area).toBeLessThan(0);
      expect(measure(tr, 'V1').area).toBeLessThan(measure(tr, 'V3').area);
      expect(measure(tr, 'V3').area).toBeLessThan(measure(tr, 'V5').area);
      // изолиния ровная: ST и PQ на одном уровне
      for (const lead of LEADS) expect(Math.abs(measure(tr, lead).st)).toBeLessThan(0.05);
      // T — вверх там, где комплекс вверх, и вниз в aVR
      expect(measure(tr, 'II').t).toBeGreaterThan(0.1);
      expect(measure(tr, 'aVR').t).toBeLessThan(-0.1);
    }
  });

  test('инфаркт нижней стенки: ST поднят в II, III, aVF, в III выше, чем во II; в aVL — зеркальная депрессия; V4–V6 — на изолинии', () => {
    for (const seed of SEEDS) {
      const tr = trace({ stemi: 'inferior' }, seed);
      for (const lead of ['II', 'III', 'aVF'] as const) expect(measure(tr, lead).st).toBeGreaterThan(0.15);
      expect(measure(tr, 'III').st).toBeGreaterThan(measure(tr, 'II').st);
      expect(measure(tr, 'aVL').st).toBeLessThan(-0.08);
      // рядом с подъёмом стоит строка «Депрессии сегмента ST и инверсии зубца T в V4–V6 нет» — меньше 0,5 мм
      for (const lead of ['V4', 'V5', 'V6'] as const) expect(Math.abs(measure(tr, lead).st)).toBeLessThan(0.05);
    }
  });

  test('инфаркт передней стенки: ST поднят в V2–V4, в III не поднят', () => {
    for (const seed of SEEDS) {
      const tr = trace({ stemi: 'anterior' }, seed);
      for (const lead of ['V2', 'V3', 'V4'] as const) expect(measure(tr, lead).st).toBeGreaterThan(0.2);
      expect(measure(tr, 'III').st).toBeLessThan(0.02);
    }
  });

  test('инфаркт боковой стенки: ST поднят в I, aVL, V5, V6, опущен в III', () => {
    for (const seed of SEEDS) {
      const tr = trace({ stemi: 'lateral' }, seed);
      for (const lead of ['I', 'aVL', 'V5', 'V6'] as const) expect(measure(tr, lead).st).toBeGreaterThan(0.1);
      expect(measure(tr, 'III').st).toBeLessThan(-0.1);
    }
  });

  test('ишемия без подъёма ST: депрессия в I и V4–V6, в aVR подъём меньше 1 мм', () => {
    for (const seed of SEEDS) {
      const tr = trace({ stDepression: true }, seed);
      for (const lead of ['I', 'V4', 'V5', 'V6'] as const) expect(measure(tr, lead).st).toBeLessThan(-0.07);
      // рядом стоит строка «Подъёма сегмента ST нет»: зеркальный подъём в aVR не дотягивает до 1 мм
      expect(measure(tr, 'aVR').st).toBeGreaterThan(0.06);
      expect(measure(tr, 'aVR').st).toBeLessThan(0.1);
    }
  });

  test('ишемия с инверсией T в боковых: T отрицательный в I, aVL и V4–V6; с нижним инфарктом — обе картины', () => {
    for (const seed of SEEDS) {
      const tr = trace({ stDepression: true, tInversion: 'lateral' }, seed);
      for (const lead of ['I', 'aVL', 'V4', 'V5', 'V6'] as const) expect(measure(tr, lead).t).toBeLessThan(-0.1);
      const both = trace({ stemi: 'inferior', stDepression: true, tInversion: 'lateral' }, seed);
      for (const lead of ['II', 'III', 'aVF'] as const) expect(measure(both, lead).st).toBeGreaterThan(0.1);
      for (const lead of ['V4', 'V5', 'V6'] as const) {
        expect(measure(both, lead).st).toBeLessThan(-0.07);
        expect(measure(both, lead).t).toBeLessThan(-0.1);
      }
    }
  });

  test('перикардит: ST поднят в большинстве отведений, в aVR опущен; PQ ниже изолинии во II', () => {
    for (const seed of SEEDS) {
      const tr = trace({ pericarditis: true }, seed);
      const up = LEADS.filter(l => measure(tr, l).st > 0.05);
      expect(up.length).toBeGreaterThanOrEqual(7);
      expect(measure(tr, 'aVR').st).toBeLessThan(-0.1);
      // PQ: сразу перед комплексом — ниже, чем перед зубцом P
      const s = tr.leads.II;
      const b = tr.beats.find(x => x.p !== undefined && x.p > 0.2)!;
      expect(s[Math.round((b.qrs - 0.015) * ECG_HZ)]).toBeLessThan(s[Math.round((b.p! - 0.02) * ECG_HZ)] - 0.02);
    }
  });

  test('гипертрофия левого желудочка: S в V1 и R в V5 вместе — больше 3,5 мВ (Соколов — Лайон)', () => {
    for (const seed of SEEDS) {
      const tr = trace({ lvh: true }, seed);
      expect(-measure(tr, 'V1').min + measure(tr, 'V5').max).toBeGreaterThan(3.5);
    }
  });

  test('блокада левой ножки: комплекс шире 120 мс, QS в V1, широкий R в V6, T в V6 против комплекса', () => {
    for (const seed of SEEDS) {
      const tr = trace({ bundle: 'lbbb' }, seed);
      expect(tr.beats[1].j - tr.beats[1].qrs).toBeGreaterThanOrEqual(0.12);
      expect(measure(tr, 'V1').area).toBeLessThan(0);
      expect(measure(tr, 'V6').area).toBeGreaterThan(0);
      expect(measure(tr, 'V6').t).toBeLessThan(0);
    }
  });

  test('блокада правой ножки: комплекс шире 120 мс, в V1 в конце — R′', () => {
    for (const seed of SEEDS) {
      const tr = trace({ bundle: 'rbbb' }, seed);
      const b = tr.beats[2];
      expect(b.j - b.qrs).toBeGreaterThanOrEqual(0.12);
      const s = tr.leads.V1;
      expect(s[Math.round((b.qrs + 0.105) * ECG_HZ)] - baseline(s, b.qrs)).toBeGreaterThan(0.2);
    }
  });

  test('перегрузка правого желудочка: S в I, отрицательный T в III и V1', () => {
    for (const seed of SEEDS) {
      const tr = trace({ rvStrain: true, rate: 110 }, seed);
      expect(measure(tr, 'I').min).toBeLessThan(-0.25);
      expect(measure(tr, 'III').t).toBeLessThan(0);
      expect(measure(tr, 'V1').t).toBeLessThan(-0.15);
    }
  });

  test('выпот: комплексы от конечностей ниже 0,5 мВ, высота чередуется от удара к удару', () => {
    const tr = trace({ lowVoltage: true, rate: 105 }, 3);
    for (const lead of ['I', 'II', 'III', 'aVR', 'aVL', 'aVF'] as const) expect(Math.max(measure(tr, lead).max, -measure(tr, lead).min)).toBeLessThan(0.5);
    const s = tr.leads.V5;
    const peaks = tr.beats.filter(b => b.qrs > 0.5 && b.j < 9.5).map(b => {
      let hi = -Infinity;
      for (let i = Math.round(b.qrs * ECG_HZ); i <= Math.round(b.j * ECG_HZ); i++) hi = Math.max(hi, s[i]);
      return hi;
    });
    for (let i = 1; i < peaks.length; i++) expect(Math.abs(peaks[i] - peaks[i - 1]) / Math.max(peaks[i], peaks[i - 1])).toBeGreaterThan(0.2);
  });
});

describe('ЭКГ: ритм и проведение', () => {
  test('синусовый 72: около двенадцати комплексов за 10 с, интервалы почти равны, у каждого свой P', () => {
    const tr = trace({ rate: 72 }, 1);
    expect(tr.beats.length).toBeGreaterThanOrEqual(11);
    expect(tr.beats.length).toBeLessThanOrEqual(13);
    expect(cv(rr(tr.beats.map(b => b.qrs)))).toBeLessThan(0.04);
    for (const b of tr.beats.filter(x => x.p !== undefined)) expect(b.qrs - b.p!).toBeGreaterThanOrEqual(0.12);
  });

  test('фибрилляция предсердий: интервалы неравные, зубцов P нет', () => {
    for (const seed of SEEDS) {
      const tr = trace({ rhythm: 'af', rate: 110 }, seed);
      expect(cv(rr(tr.beats.map(b => b.qrs)))).toBeGreaterThan(0.15);
      expect(tr.atria).toEqual([]);
      expect(tr.beats.every(b => b.p === undefined)).toBe(true);
    }
  });

  test('трепетание: волны 300 в минуту, к желудочкам — каждая вторая', () => {
    const tr = trace({ rhythm: 'flutter', rate: 150 }, 2);
    expect(perMinute(tr.atria)).toBeCloseTo(300, -1);
    expect(perMinute(tr.beats.map(b => b.qrs))).toBeCloseTo(150, -1);
  });

  test('наджелудочковая тахикардия: узкие комплексы, ритм правильный, 180 в минуту', () => {
    const tr = trace({ rhythm: 'svt', rate: 180 }, 4);
    expect(perMinute(tr.beats.map(b => b.qrs))).toBeCloseTo(180, -1);
    expect(cv(rr(tr.beats.map(b => b.qrs)))).toBeLessThan(0.02);
    expect(tr.beats[2].j - tr.beats[2].qrs).toBeLessThan(0.12);
  });

  test('желудочковая тахикардия: широкие комплексы, предсердия сами по себе', () => {
    const tr = trace({ rhythm: 'vt', rate: 170 }, 5);
    expect(perMinute(tr.beats.map(b => b.qrs))).toBeCloseTo(170, -1);
    expect(tr.beats[2].j - tr.beats[2].qrs).toBeGreaterThanOrEqual(0.14);
    expect(tr.beats.every(b => b.p === undefined)).toBe(true);
    expect(perMinute(tr.atria)).toBeLessThan(100);
  });

  test('АВ-блокада I степени: PR длиннее 200 мс у каждого комплекса', () => {
    const tr = trace({ rhythm: 'avb1' }, 6);
    expect(tr.beats.length).toBeGreaterThan(8);
    for (const b of tr.beats) expect(b.qrs - b.p!).toBeGreaterThan(0.2);
  });

  test('Мобитц I: PR удлиняется, потом P без комплекса; Мобитц II: PR постоянный, P без комплекса', () => {
    const w = trace({ rhythm: 'avb2w' }, 7);
    const prs = w.beats.map(b => b.qrs - b.p!);
    expect(new Set(prs.map(x => x.toFixed(2))).size).toBeGreaterThan(1);
    expect(w.atria.length).toBeGreaterThan(w.beats.length);
    const m = trace({ rhythm: 'avb2m' }, 8);
    expect(new Set(m.beats.map(b => (b.qrs - b.p!).toFixed(2))).size).toBe(1);
    expect(m.atria.length).toBeGreaterThan(m.beats.length);
  });

  test('полная АВ-блокада: предсердий больше, чем комплексов, комплексы редкие и широкие, не связаны с P', () => {
    const tr = trace({ rhythm: 'avb3', rate: 38 }, 9);
    expect(perMinute(tr.atria)).toBeGreaterThan(70);
    expect(perMinute(tr.beats.map(b => b.qrs))).toBeLessThan(45);
    expect(tr.beats.every(b => b.p === undefined && b.j - b.qrs >= 0.14)).toBe(true);
  });

  test('полная АВ-блокада с узким выскальзывающим ритмом (часть 42в): комплексы узкие, около 45 в минуту, не связаны с P', () => {
    const tr = trace({ rhythm: 'avb3', escape: 'narrow' }, 9);
    expect(perMinute(tr.atria)).toBeGreaterThan(70);
    const rate = perMinute(tr.beats.map(b => b.qrs));
    expect(rate).toBeGreaterThan(38);
    expect(rate).toBeLessThan(52);
    expect(tr.beats.every(b => b.p === undefined && b.j - b.qrs < 0.12)).toBe(true);
  });

  test('фибрилляция предсердий с полной блокадой (часть 42в): зубцов P нет, ритм желудочков ровный и редкий', () => {
    const tr = trace({ rhythm: 'af', escape: 'wide', rate: 40 }, 4);
    expect(tr.atria).toEqual([]);
    expect(cv(rr(tr.beats.map(b => b.qrs)))).toBeLessThan(0.03);
    expect(Math.round(perMinute(tr.beats.map(b => b.qrs)))).toBe(40);
    expect(tr.beats.every(b => b.p === undefined && b.j - b.qrs >= 0.14)).toBe(true);
    // без блокады при той же частоте — неровно
    expect(cv(rr(trace({ rhythm: 'af', rate: 40 }, 4).beats.map(b => b.qrs)))).toBeGreaterThan(0.15);
  });
});

describe('ЭКГ в карте пациента: лента и строки находок согласны', () => {
  const ECG = 'exam.ecg';
  const ED = ['dept.therapy', 'dept.surgery', 'dept.trauma'];
  /** Отведения, названные в строке находки: «II, III, aVF», «V4–V6». */
  const leadsIn = (text: string): Lead[] => {
    const out: Lead[] = [];
    for (const m of text.matchAll(/V([1-6])[–-]V([1-6])|\b(aV[RLF]|V[1-6]|III|II|I)\b/g)) {
      if (m[1]) for (let k = Number(m[1]); k <= Number(m[2]); k++) out.push(`V${k}` as Lead);
      else out.push(m[3] as Lead);
    }
    return out;
  };
  /** Карта с лентой: `attrs` — атрибуты строк (стенка инфаркта, часть 39а); нет — запись до них. */
  const card = (seed: number, shown: Record<string, boolean>, attrs: Record<string, Record<string, string>> = {}) => {
    const patient = generatePatient(db, seed, { department: 'dept.therapy', departments: ED, season: 'summer', primary: 'cond.acs' });
    const obs: Observation[] = Object.entries(shown).map(([f, on]) => ({ f, shown: on, exam: ECG, ...(attrs[f] ? { attrs: attrs[f] } : {}) }));
    const g = makeCaseView({
      version: 0, patient, clock: 600, minutesSpent: 0, money: 0, step: 1,
      arrived: [{ exam: ECG, step: 1, at: 600, obs }], pending: [], meanwhile: [], done: [ECG],
      draft: { treatments: [], setting: 'home' }, departments: ED,
    }).groups.find(x => x.exam === ECG)!;
    if (g.image?.kind !== 'ecg') throw new Error('нет ленты');
    return { image: g.image, tr: synthEcg12(g.image.ecg, g.image.seed, 10), line: (f: string) => g.lines.find(l => l.f === f)!.text };
  };
  const text = (f: string, k: 'present' | 'absent') => db.findings[f].texts[k]![0].ru;

  test('подъём ST: отведения из строки находки подняты у каждого пациента — у каждой стенки (часть 39а)', () => {
    const walls = Object.keys(db.findings['ecg.st_elevation'].attrs!.wall).sort();
    expect(walls).toEqual(['anterior', 'inferior', 'lateral']);
    expect(leadsIn(text('ecg.st_depression', 'absent'))).toEqual(['V4', 'V5', 'V6']);
    for (const wall of walls) for (const seed of SEEDS) {
      const { image, tr, line } = card(seed, { 'ecg.st_elevation': true, 'ecg.st_depression': false, 'ecg.lvh': false, 'ecg.af': false }, { 'ecg.st_elevation': { wall } });
      expect(image.ecg).toMatchObject({ stemi: wall });
      const up = leadsIn(line('ecg.st_elevation'));
      expect(up.length).toBeGreaterThanOrEqual(3);
      for (const lead of up) expect(measure(tr, lead).st).toBeGreaterThan(0.1);
      // нижняя: рядом строка «Депрессии ST и инверсии T в V4–V6 нет» — там изолиния
      if (wall === 'inferior') for (const lead of ['V4', 'V5', 'V6'] as const) expect(Math.abs(measure(tr, lead).st)).toBeLessThan(0.05);
    }
  });

  test('запись до стенки (сохранение до 0.3.5): строка называет II, III, aVF, лента — нижняя стенка', () => {
    const { image, tr, line } = card(5, { 'ecg.st_elevation': true });
    expect(line('ecg.st_elevation')).toBe('Подъём сегмента ST в отведениях II, III, aVF');
    expect(image.ecg).toMatchObject({ stemi: 'inferior' });
    for (const lead of leadsIn(line('ecg.st_elevation'))) expect(measure(tr, lead).st).toBeGreaterThan(0.1);
  });

  test('депрессия ST: в отведениях из строки находки ST опущен и T отрицательный; подъёма нет', () => {
    const down = leadsIn(text('ecg.st_depression', 'present'));
    expect(down).toEqual(['V4', 'V5', 'V6']);
    for (const seed of SEEDS) {
      const { image, tr } = card(seed, { 'ecg.st_elevation': false, 'ecg.st_depression': true });
      expect(image.ecg).toMatchObject({ stDepression: true, tInversion: 'lateral' });
      expect(image.ecg).not.toHaveProperty('stemi');
      for (const lead of down) {
        expect(measure(tr, lead).st).toBeLessThan(-0.07);
        expect(measure(tr, lead).t).toBeLessThan(-0.1);
      }
      // строка «Подъёма сегмента ST нет»: нигде нет 1 мм
      for (const lead of LEADS) expect(measure(tr, lead).st).toBeLessThan(0.1);
    }
  });

  test('обе находки разом — обе на ленте; без находок — ни той, ни другой', () => {
    expect(card(3, { 'ecg.st_elevation': true, 'ecg.st_depression': true }).image.ecg).toMatchObject({ stemi: 'inferior', stDepression: true, tInversion: 'lateral' });
    const none = card(3, { 'ecg.st_elevation': false, 'ecg.st_depression': false }).image.ecg;
    expect(none).not.toHaveProperty('stemi');
    expect(none).not.toHaveProperty('stDepression');
  });
});

describe('ЭКГ: лист', () => {
  beforeAll(async () => {
    await loadSkia();
  });

  test('шесть строк по два отведения и полоса ритма: подписи на месте, лента в каждой строке', async () => {
    const { ecgSheetLayout, recordEcgSheet, ECG_SHEET_ASPECT } = await import('../../src/render/ecg/sheet');
    const W = 400;
    const layout = ecgSheetLayout(W);
    expect(layout.height).toBe(Math.round(W * ECG_SHEET_ASPECT));
    expect(layout.labels.map(l => l.lead)).toEqual(['I', 'V1', 'II', 'V2', 'III', 'V3', 'aVR', 'V4', 'aVL', 'V5', 'aVF', 'V6', 'II']);
    const { rgba } = await rasterize(recordEcgSheet(W, trace({ stemi: 'inferior' }, 2)), W, layout.height);
    // под каждой подписью, у изолинии строки, есть тёмная линия ленты — самый тёмный пиксель столбца
    const px = (x: number, y: number) => {
      const i = (y * W + x) * 4;
      return 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    };
    for (const l of layout.labels) {
      const x = Math.round(l.x + 20 * layout.mm);
      let darkest = 255;
      for (let y = Math.round(l.y + 4 * layout.mm); y < Math.round(l.y + 16 * layout.mm); y++) darkest = Math.min(darkest, px(x, y));
      expect({ lead: l.lead, dark: darkest < 120 }).toEqual({ lead: l.lead, dark: true });
    }
    // бумага — светлая миллиметровка
    expect(luma(rgba, W, layout.height, 0.995, 0.995)).toBeGreaterThan(200);
  });
});
