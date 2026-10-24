// Сценарии «Быстрой игры» (часть 91, spec 2026-10-scenarios, вопрос 55, вариант 2): неделя — пять смен подряд в одной
// больнице с особым условием и своей целью. «Зимний грипп» — ОРВИ, гриппа и пневмонии вдвое больше; «Закрыли соседнюю
// больницу» — пришедших и машин скорой в полтора раза больше; «Рентген сломался» — неделя без рентгена.
import type { ContentDb, Id } from '../../content/types';
import { slotKey } from '../hospital/requirements';
import type { Prior } from '../med/infer';

export type Scenario = 'flu' | 'neighbor' | 'xray';
export const SCENARIOS: readonly Scenario[] = ['flu', 'neighbor', 'xray'];

/** Неделя сценария — пять смен, с понедельника по пятницу. */
export const SCENARIO_DAYS = 5;

/**
 * «Зимний грипп»: у пришедших сами эти болезни — вдвое чаще: на каждого такого приходит ещё один с одной из них, по их
 * частотам. Врач об эпидемии знает: в выводе они вдвое вероятнее у каждого.
 */
export const FLU_IDS: readonly Id[] = ['cond.arvi', 'cond.influenza', 'cond.pneumonia_cap'];
export const FLU_X = 2;

/** «Закрыли соседнюю больницу»: записанных, пришедших без записи и машин скорой — в полтора раза больше, %. */
export const NEIGHBOR_FLOW = 150;

/** Аппараты рентгена: «Рентген сломался» — они в ремонте всю неделю. */
const XRAY_EQUIPMENT: ReadonlySet<Id> = new Set(['eq.xray_analog', 'eq.xray_digital']);
export const isXray = (equipment: Id) => XRAY_EQUIPMENT.has(equipment);

/** Что сценарий говорит выводу: «Зимний грипп» — болезни эпидемии вдвое вероятнее; иначе — ничего. */
export function scenarioPrior(scenario: Scenario | undefined): Prior | undefined {
  return scenario === 'flu' ? { ids: FLU_IDS, x: FLU_X } : undefined;
}

/** Поток пришедших сами, % обычного. */
export function scenarioFlow(scenario: Scenario | undefined): number {
  return scenario === 'neighbor' ? NEIGHBOR_FLOW : 100;
}

/** Машин скорой за смену — сколько обычно, у «Закрыли соседнюю больницу» — в полтора раза больше. */
export function scenarioAmbulance(scenario: Scenario | undefined, [lo, hi]: readonly [number, number]): [number, number] {
  if (scenario !== 'neighbor') return [lo, hi];
  return [Math.round((lo * NEIGHBOR_FLOW) / 100), Math.round((hi * NEIGHBOR_FLOW) / 100)];
}

/**
 * Где сценарий играть: «Закрыли соседнюю больницу» — где принимают скорую (смотровая приёмного), «Рентген сломался» — где
 * есть рентген-кабинет; «Зимний грипп» — где угодно.
 */
export function scenarioFits(scenario: Scenario, rooms: ReadonlySet<Id>): boolean {
  if (scenario === 'neighbor') return rooms.has('room.emergency');
  if (scenario === 'xray') return rooms.has('room.xray');
  return true;
}

/** «Рентген сломался»: места аппаратов рентгена в плане больницы — ключи «помещение:место», как у поломок с утра. */
export function xrayBroken(db: ContentDb, scenario: Scenario | undefined, rooms: readonly { id: string; equipment: readonly (Id | null)[] }[]): string[] {
  if (scenario !== 'xray') return [];
  const out: string[] = [];
  for (const r of rooms) {
    r.equipment.forEach((id, slot) => {
      if (id && XRAY_EQUIPMENT.has(id) && db.equipment[id]) out.push(slotKey(r.id, slot));
    });
  }
  return out;
}
