// Значки строк карты пациента по виду приёма (0.6.8, вопрос 49): признак — есть у пациента или нет; обследование — что
// показало: не сделано или ещё не пришло — неизвестно, пришло и что-то нашло — есть, ничего не нашло — нет.
import type { Id } from '@/content/types';
import type { Known, Line, VisitView } from '@/state/caseView';
import { examIcon, findingIcon, type ItemIcon } from '@/ui/itemIcons';

export interface Mark {
  icon: ItemIcon;
  state: Known;
}

/** Строка результата: найденное — есть, «без особенностей» — нет. */
export const lineMark = (l: Pick<Line, 'f' | 'shown'>): Mark => ({ icon: findingIcon(l.f), state: l.shown ? 'present' : 'absent' });

/** Обследование по тому, что пришло. */
export function examMark(v: Pick<VisitView, 'done' | 'groups'>, id: Id): Mark {
  const lines = v.done.includes(id) ? v.groups.filter(g => g.exam === id).flatMap(g => g.lines) : [];
  return { icon: examIcon(id), state: lines.length === 0 ? 'unknown' : lines.some(l => l.shown) ? 'present' : 'absent' };
}
