// Математика движка (ADR 0004, `06-architecture.md` §5): только + − × ÷ и сравнения, поэтому
// одинаково в Hermes, V8 и JavaScriptCore. `Math.log2` по стандарту приблизителен и может
// разниться в последнем знаке между движками, а по пользе обследования решают нанятые врачи
// (spec 2026-09-hired-doctors).

const LN2 = 0.6931471805599453;
const SQRT2 = 1.4142135623730951;
const HALF_SQRT2 = SQRT2 / 2;
const TWO32 = 4294967296;
const INV_TWO32 = 1 / TWO32;

/**
 * Двоичный логарифм положительного числа с ошибкой порядка 1e-16. Число раскладывается на
 * m · 2^e, m ∈ [√½, √2) — умножение и деление на степень двойки точны, — а ln m = 2 · atanh z,
 * z = (m − 1)/(m + 1), |z| < 0,172: ряд z + z³/3 + z⁵/5 + … за 12 членов точнее 1e-18.
 */
export function log2(x: number): number {
  if (Number.isNaN(x) || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return Infinity;
  let e = 0;
  let m = x;
  while (m >= TWO32) {
    m *= INV_TWO32;
    e += 32;
  }
  while (m < INV_TWO32) {
    m *= TWO32;
    e -= 32;
  }
  while (m >= SQRT2) {
    m /= 2;
    e += 1;
  }
  while (m < HALF_SQRT2) {
    m *= 2;
    e -= 1;
  }
  const z = (m - 1) / (m + 1);
  const z2 = z * z;
  let term = z;
  let sum = z;
  for (let k = 3; k <= 25; k += 2) {
    term *= z2;
    sum += term / k;
  }
  return e + (2 * sum) / LN2;
}
