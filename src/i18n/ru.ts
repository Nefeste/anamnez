// Русский словарь — исходный: остальные языки объявляются с его типом (docs/06-architecture.md §9).
import { about } from './sections/about';
import { common } from './sections/common';
import { menu } from './sections/menu';
import { names } from './sections/names';
import { settings } from './sections/settings';
import { shift } from './sections/shift';
import { spikes } from './sections/spikes';

export const ru = { common, menu, settings, about, spikes, shift, names };
