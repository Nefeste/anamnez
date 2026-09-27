// Русский словарь — исходный: остальные языки объявляются с его типом (docs/06-architecture.md §9).
import { about } from './sections/about';
import { common } from './sections/common';
import { encyclopedia } from './sections/encyclopedia';
import { menu } from './sections/menu';
import { names } from './sections/names';
import { profile } from './sections/profile';
import { report } from './sections/report';
import { sandbox } from './sections/sandbox';
import { settings } from './sections/settings';
import { shift } from './sections/shift';
import { spikes } from './sections/spikes';

export const ru = { common, menu, settings, about, encyclopedia, spikes, shift, names, profile, report, sandbox };
