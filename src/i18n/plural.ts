// Множественное число по правилам языка — перенос из «Вотчины». Свои правила, а не
// Intl.PluralRules: на него в Hermes под Android полагаться нельзя.

/** Русский: 1 минута, 2 минуты, 5 минут; 11–14 — «много», 21 — снова «один». */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
