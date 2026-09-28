// Персонал своей больницы (spec 2026-09-own-hospital, часть 8): кандидаты дня, найм, навык 1–5,
// черта, зарплата за смену, скорость и точность работы, рост навыка с отработанными сменами.
// Числа — баланс игры (content/hospital/economy.yaml, `staff`). Имя человека — из словаря игры,
// как у пациентов: здесь только пол и зерно имени.
import type { ContentDb, Id, Preset } from '../../content/types';
import { Rng } from '../core/rng';
import type { Staffing } from './requirements';

export type Trait = 'careful' | 'fast' | 'novice' | 'experienced';
export const TRAITS: Trait[] = ['careful', 'experienced', 'fast', 'novice'];

export interface StaffMember {
  /** s1, s2… — не меняется; у штата готовой амбулатории — p1, p2… */
  id: string;
  role: Id;
  sex: 'm' | 'f';
  /** зерно имени — имя из словаря игры */
  seed: number;
  skill: number;
  trait?: Trait;
  /** зарплата за смену, ₽ */
  salary: number;
  /** где работает — помещение; нет — в резерве: получает зарплату, но не работает */
  room?: string;
  /** отработанных смен с последней ступени навыка */
  days: number;
}

/** Зарплата за смену: между «навык 1» и «навык 5» должности, с поправкой черты; до 50 ₽. */
export function salaryOf(db: ContentDb, role: Id, skill: number, trait?: Trait): number {
  const [lo, hi] = db.roles[role].salary;
  const base = lo + ((hi - lo) * (skill - 1)) / 4;
  const k = trait ? (db.economy.staff.traits[trait].salary ?? 100) : 100;
  return Math.round((base * k) / 100 / 50) * 50;
}

/**
 * Кандидаты дня: на каждую должность, которую нанимают, — от и до `candidates` человек из
 * ветви зерна `candidates:<день>`. Номера продолжают сквозной счёт найма.
 */
export function applicantsOf(db: ContentDb, seed: number, day: number, next: number): { list: StaffMember[]; next: number } {
  const b = db.economy.staff;
  const root = Rng.seeded(seed).fork(`candidates:${day}`);
  const weights: Record<string, number> = { none: b.noTrait };
  for (const t of TRAITS) weights[t] = b.traits[t].weight;
  const list: StaffMember[] = [];
  let n = next;
  for (const role of Object.keys(db.roles).sort()) {
    if (!db.roles[role].hire) continue;
    const r = root.fork(role);
    const count = r.range(b.candidates[0], b.candidates[1]);
    for (let i = 0; i < count; i++) {
      const c = r.fork(`c${i}`);
      const key = c.weightedKey(weights);
      const trait = key === 'none' ? undefined : (key as Trait);
      const range = trait ? b.traits[trait].skills : undefined;
      const skill = range ? c.range(range[0], range[1]) : c.weighted([1, 2, 3, 4, 5], s => b.skills[s - 1]);
      list.push({
        id: `s${n++}`, role, sex: c.chance(5000) ? 'f' : 'm', seed: c.u32(), skill, ...(trait ? { trait } : {}),
        salary: salaryOf(db, role, skill, trait), days: 0,
      });
    }
  }
  return { list, next: n };
}

/** Время обследования у этого человека, % от записанного в базе: навык и черта «быстрый». */
export function speedOf(db: ContentDb, m?: StaffMember): number {
  if (!m) return 100;
  const b = db.economy.staff;
  const trait = m.trait ? (b.traits[m.trait].speed ?? 100) : 100;
  return Math.round((b.speed[m.skill - 1] * trait) / 100);
}

/** Как рентгенолог читает снимок: поправка чувствительности и специфичности, п. п. */
export function readingOf(db: ContentDb, m?: StaffMember): [number, number] {
  if (!m) return [0, 0];
  const b = db.economy.staff;
  const [s, p] = b.reading[m.skill - 1];
  const t = m.trait ? (b.traits[m.trait].reading ?? [0, 0]) : [0, 0];
  return [s + t[0], p + t[1]];
}

/** Смена отработана: навык растёт на ступень за `growthDays` смен (новичок — быстрее), не выше 5. */
export function grow(db: ContentDb, m: StaffMember): StaffMember {
  if (!m.room || m.skill >= 5) return m;
  const b = db.economy.staff;
  const need = Math.max(1, Math.ceil(b.growthDays / (m.trait ? (b.traits[m.trait].growth ?? 1) : 1)));
  const days = m.days + 1;
  return days >= need ? { ...m, skill: m.skill + 1, days: 0 } : { ...m, days };
}

/** Кто на месте: помещение и должность → есть ли человек. */
export function staffingOf(staff: readonly StaffMember[]): Staffing {
  return (room, role) => staff.some(m => m.room === room && m.role === role);
}

/** Кто на месте в помещении на должности — для скорости и точности. */
export function memberAt(staff: readonly StaffMember[], room: string, role: Id): StaffMember | undefined {
  return staff.find(m => m.room === room && m.role === role);
}

/** Штат готовой больницы: навык 3, без черт — работает ровно так, как записано в базе. */
export function presetStaff(db: ContentDb, p: Preset): StaffMember[] {
  return p.staff.map((s, i) => ({
    id: `p${i + 1}`, role: s.role, sex: i % 2 === 0 ? 'f' : 'm', seed: i + 1, skill: 3, salary: salaryOf(db, s.role, 3), room: `r${s.room + 1}`, days: 0,
  }));
}
