// Русский словарь — исходный: остальные языки объявляются с его типом (docs/06-architecture.md §9).
import { common } from './sections/common';
import { menu } from './sections/menu';
import { names } from './sections/names';
import { shift } from './sections/shift';
import { spikes } from './sections/spikes';

export const ru = { common, menu, spikes, shift, names };
