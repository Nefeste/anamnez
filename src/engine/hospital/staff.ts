// Персонал своей больницы (spec 2026-09-own-hospital, часть 8): кандидаты дня, найм, навык 1–5,
// черта, зарплата за смену, скорость и точность работы, рост навыка с отработанными сменами.
// Числа — баланс игры (content/hospital/economy.yaml, `staff`). Имя человека — из словаря игры,
// как у пациентов: здесь только пол и зерно имени.
import type { ContentDb, Id, Preset } from '../../content/types';
import { Rng } from '../core/rng';
import type { Plan } from './build';
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
 * Кандидаты дня: на каждую должность, которую нанимают (и `allow` пропускает), — от и до
 * `candidates` человек из ветви зерна `candidates:<день>`. Номера продолжают сквозной счёт.
 */
export function applicantsOf(db: ContentDb, seed: number, day: number, next: number, allow: (role: Id) => boolean = () => true): { list: StaffMember[]; next: number } {
  const b = db.economy.staff;
  const root = Rng.seeded(seed).fork(`candidates:${day}`);
  const weights: Record<string, number> = { none: b.noTrait };
  for (const t of TRAITS) weights[t] = b.traits[t].weight;
  const list: StaffMember[] = [];
  let n = next;
  for (const role of Object.keys(db.roles).sort()) {
    if (!db.roles[role].hire || !allow(role)) continue;
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

/** Как читает снимок тот, кто его описывает (рентгенолог, врач УЗД): поправка чувствительности и специфичности, п. п. */
export function readingOf(db: ContentDb, m?: StaffMember): [number, number] {
  if (!m) return [0, 0];
  const b = db.economy.staff;
  const [s, p] = b.reading[m.skill - 1];
  const t = m.trait ? (b.traits[m.trait].reading ?? [0, 0]) : [0, 0];
  return [s + t[0], p + t[1]];
}

/**
 * Как ведёт приём нанятый врач (spec 2026-09-hired-doctors): при какой уверенности ставит
 * диагноз, какая польза обследования (биты) для него ещё стоит цены, как часто забывает
 * спросить о противопоказаниях перед лечением (%). Навык и черта — числа `economy.yaml`.
 */
export function doctorOf(db: ContentDb, m: StaffMember): { threshold: number; minGain: number; forget: number } {
  const d = db.economy.staff.doctor;
  const t = m.trait ? db.economy.staff.traits[m.trait] : undefined;
  const i = m.skill - 1;
  return {
    threshold: Math.min(95, Math.max(50, d.threshold[i] + (t?.threshold ?? 0))) / 100,
    minGain: d.minGain[i] / 1000,
    forget: Math.min(100, Math.max(0, d.forget[i] + (t?.forget ?? 0))),
  };
}

/** Смена отработана: навык растёт на ступень за `growthDays` смен (новичок — быстрее), не выше 5. */
export function grow(db: ContentDb, m: StaffMember): StaffMember {
  if (!m.room || m.skill >= 5) return m;
  const b = db.economy.staff;
  const need = Math.max(1, Math.ceil(b.growthDays / (m.trait ? (b.traits[m.trait].growth ?? 1) : 1)));
  const days = m.days + 1;
  return days >= need ? { ...m, skill: m.skill + 1, days: 0 } : { ...m, days };
}

/** Мест для нанятых врачей в помещениях этого типа, до двери которых можно дойти. */
export function placesOf(db: ContentDb, plan: Plan, type: Id): number {
  return plan.rooms
    .filter(r => r.type === type && r.door.length > 0 && plan.connected[r.id])
    .reduce((n, r) => n + (db.rooms[type]?.sizes.find(z => z.id === r.size)?.places ?? 0), 0);
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Кто на месте: помещение и должность → есть ли человек. Встающий на чужое место (терапевт —
 * на место врача) на нём и считается. Кому нужно место в помещении (терапевту — в
 * ординаторской), тот работает, только если место досталось: места раздаются по номеру
 * помещения, где он работает, затем по номеру человека (spec 2026-09-hired-doctors).
 */
export function staffingOf(db: ContentDb, plan: Plan, staff: readonly StaffMember[]): Staffing {
  const unplaced = new Set<string>();
  const left: Record<string, number> = {};
  const needing = staff.filter(m => m.room !== undefined && db.roles[m.role]?.needs).sort((a, b) => cmp(a.room!, b.room!) || cmp(a.id, b.id));
  for (const m of needing) {
    const type = db.roles[m.role].needs!;
    left[type] ??= placesOf(db, plan, type);
    if (left[type] > 0) left[type]--;
    else unplaced.add(m.id);
  }
  const fills = (m: StaffMember, role: Id) => m.role === role || db.roles[m.role]?.stands === role;
  const staffed: Staffing = (room, role) => staff.some(m => m.room === room && fills(m, role) && !unplaced.has(m.id));
  staffed.unplaced = room => staff.some(m => m.room === room && unplaced.has(m.id));
  return staffed;
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
