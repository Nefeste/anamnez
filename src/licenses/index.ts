// Лицензии открытых компонентов (spec 2026-10-licenses, 0.5.6): готовый список из licenses.json.
import data from './licenses.json';
import type { Licenses } from './types';

export const LICENSES = data as Licenses;

/** Сколько компонентов в списке — для кнопки в «Об игре». */
export const licenseCount = LICENSES.groups.reduce((n, g) => n + g.items.length, 0);
