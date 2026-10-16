// «Спросить» беседой (spec 2026-10-patient-card, 0.6.0): из ответа на вопрос — реплика пациента. Только данные: их
// проверяют тесты в Bun, где нет React Native.
import type { Line } from '@/state/caseView';

/** Сколько «нет» сказать сразу: остальное — числом, касание раскрывает (как «ещё N без особенностей» в «Известно»). */
export const NO_SAID = 3;

/** Реплика: найденное — первым, из «нет» — до трёх; `open` — всё. `more` — сколько не сказано. */
export function replyOf(lines: readonly Line[], open: boolean): { said: Line[]; more: number } {
  const yes = lines.filter(l => l.shown);
  const no = lines.filter(l => !l.shown);
  const said = [...yes, ...(open ? no : no.slice(0, NO_SAID))];
  return { said, more: lines.length - said.length };
}

/** Строки реплики — одной речью: точка между фразами, если своей нет. */
export function joinSaid(texts: readonly string[]): string[] {
  return texts.map((x, i) => (i === texts.length - 1 || /[.!?…]$/.test(x) ? x : `${x}.`));
}
