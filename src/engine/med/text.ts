// Тексты признаков из шаблонов базы (`docs/06-architecture.md` §9).
//
// Шаблон: `{м|ж}` — форма по полу пациента, `{атрибут}` — подпись значения атрибута
// признака, `{value}` и `{unit}` — числовой показатель, `{dia}` и подобные — производное
// от него число (`value.derived`). Вариант текста выбирается из зерна пациента, поэтому
// один и тот же пациент говорит одинаково.
import type { ContentDb, Text } from '../../content/types';
import { fnv1a } from '../core/hash';
import type { Observation, Sex } from './types';

export type Lang = 'ru' | 'en';

const pick = (variants: Text[] | undefined, key: string, lang: Lang): string | undefined => {
  if (!variants || variants.length === 0) return undefined;
  const v = variants[fnv1a(key) % variants.length];
  return v[lang] ?? v.ru;
};

/** Число с запятой, как на русском бланке. */
export function formatNumber(n: number, decimals: number, lang: Lang = 'ru'): string {
  const s = n.toFixed(decimals);
  return lang === 'ru' ? s.replace('.', ',') : s;
}

export function renderTemplate(db: ContentDb, template: string, o: Observation, sex: Sex, lang: Lang = 'ru'): string {
  const f = db.findings[o.f];
  return template.replace(/\{([^{}]+)\}/g, (_, token: string) => {
    if (token.includes('|')) {
      const [m, w] = token.split('|');
      return sex === 'm' ? m : w;
    }
    if (token === 'value' && o.value !== undefined && f.value) return formatNumber(o.value, f.value.decimals, lang);
    if (token === 'unit' && f.value) return f.value.unit;
    // производное число: нижнее давление из верхнего — только для показа, в вывод не идёт
    const k = f.value?.derived?.[token];
    if (k !== undefined && o.value !== undefined) return formatNumber(Math.round(o.value * k), 0, lang);
    // запись до появления атрибута (часть 39а) — значение, что строка называла тогда
    const attr = o.attrs?.[token] ?? f.fallback?.[token];
    const label = attr ? f.attrs?.[token]?.[attr] : undefined;
    return label ? (label[lang] ?? label.ru) : '';
  }).replace(/\s{2,}/g, ' ').replace(/\s+([,.])/g, '$1').trim();
}

/** Строка результата: «В нижних отделах справа — крепитация» или «Хрипов нет». */
export function observationText(db: ContentDb, o: Observation, sex: Sex, seed: number, lang: Lang = 'ru'): string {
  const f = db.findings[o.f];
  const variants = o.shown ? f.texts.present : (f.texts.absent ?? []);
  const template = pick(variants, `${seed}:${o.f}:${o.shown}`, lang) ?? (o.shown ? f.name[lang] ?? f.name.ru : '');
  return renderTemplate(db, template, o, sex, lang);
}

/** Как пациент сам говорит о жалобе. */
export function complaintText(db: ContentDb, o: Observation, sex: Sex, seed: number, lang: Lang = 'ru'): string {
  const f = db.findings[o.f];
  const template = pick(f.texts.complaint, `${seed}:say:${o.f}`, lang) ?? f.name[lang] ?? f.name.ru;
  return renderTemplate(db, template, o, sex, lang);
}
