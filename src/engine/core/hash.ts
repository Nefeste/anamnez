// Хеши для детерминизма: имена ветвей генератора и отпечатки состояния (ADR 0004).
// Только целочисленная арифметика (Math.imul, сдвиги) — одинаково в Hermes, V8 и Bun.

/** FNV-1a, 32 бита, по кодам символов строки. */
export function fnv1a(text: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Отпечаток значения: стабильный JSON (ключи по алфавиту) → FNV-1a, 8 шестнадцатеричных знаков. */
export function fingerprint(value: unknown): string {
  return fnv1a(stableJson(value)).toString(16).padStart(8, '0');
}

/** JSON с отсортированными ключами: порядок вставки в объект не влияет на отпечаток. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}
