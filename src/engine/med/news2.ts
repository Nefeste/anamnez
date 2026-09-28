// Шкала раннего предупреждения NEWS2 (content/scores/news2.yaml; 04-medical-model.md §6): баллы
// по измеренным витальным и цвет сортировки — как отсортировала бы медсестра по шкале и красным
// флагам (spec 2026-09-chapter-2, часть 27). Считается только измеренное: чего нет в листе,
// за то ноль баллов. Сознание и кислород — отдельные строки шкалы: признаков для них в базе
// пока нет, поэтому «в сознании» и «дышит воздухом».
import type { ContentDb, Id } from '../../content/types';
import type { Observation } from './types';

export type Urgency = 'red' | 'yellow' | 'green';

export interface EarlyWarning {
  /** сумма баллов */
  points: number;
  /** баллы по каждому измеренному признаку шкалы */
  parts: { f: Id; value: number; points: number }[];
  /**
   * уровень ответа: 0–4 — низкий, 5–6 или 3 по одному параметру — средний, 7 и больше — высокий.
   * У RCP 3 по одному параметру — отдельный уровень «низкий-средний» со срочным осмотром; в игре
   * он вместе со средним — жёлтый
   */
  level: 'low' | 'medium' | 'high';
}

export const NEWS2 = 'score.news2';

/** Баллы по измеренным значениям признаков шкалы. */
export function news2(db: ContentDb, values: Readonly<Record<Id, number>>, opts: { oxygen?: boolean; confused?: boolean } = {}): EarlyWarning | undefined {
  const sc = db.scores[NEWS2];
  if (!sc) return undefined;
  const parts = sc.params.flatMap(par => {
    const v = values[par.f];
    if (v === undefined) return [];
    // полосы идут по возрастанию без щелей: первая, чья верхняя граница не ниже значения
    const band = par.points.find(([, hi]) => hi === null || v <= hi) ?? par.points[par.points.length - 1];
    return [{ f: par.f, value: v, points: band[2] }];
  });
  const oxygen = opts.oxygen ? sc.oxygen : 0;
  const confused = opts.confused ? sc.confusion : 0;
  const points = parts.reduce((a, x) => a + x.points, oxygen + confused);
  const single = parts.some(x => x.points >= sc.levels.single) || confused >= sc.levels.single;
  const level = points >= sc.levels.high ? 'high' : points >= sc.levels.medium || single ? 'medium' : 'low';
  return { points, parts, level };
}

const RANK: Record<Urgency, number> = { red: 0, yellow: 1, green: 2 };
const LEVEL: Record<EarlyWarning['level'], Urgency> = { high: 'red', medium: 'yellow', low: 'green' };

/**
 * Цвет по шкале: витальные — баллами NEWS2 (7 и больше — красный, 5–6 или 3 по одному
 * показателю — жёлтый), жалобы и прочее увиденное — флагами признаков («давящая боль за
 * грудиной» — красный). Витальные флагами не считаются: для них есть шкала. `flag` — признак,
 * что поднял цвет выше шкалы: без него разбор «NEWS2 — 0 баллов, по шкале красный» непонятен.
 */
export function scaleTriage(db: ContentDb, complaints: readonly Id[], obs: readonly Observation[]): { triage: Urgency; news2: number; flag?: Id } {
  const scale = new Set(db.scores[NEWS2]?.params.map(p => p.f) ?? []);
  const values: Record<Id, number> = {};
  for (const o of obs) if (o.value !== undefined && scale.has(o.f)) values[o.f] = o.value;
  const w = news2(db, values);
  let triage: Urgency = w ? LEVEL[w.level] : 'green';
  let flag: Id | undefined;
  const seen = [...complaints, ...obs.filter(o => o.shown).map(o => o.f)].filter(f => !scale.has(f));
  for (const f of seen) {
    const level = db.findings[f]?.triage;
    if (level && RANK[level] < RANK[triage]) {
      triage = level;
      flag = f;
    }
  }
  return { triage, news2: w?.points ?? 0, ...(flag ? { flag } : {}) };
}
