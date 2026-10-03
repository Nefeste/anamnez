// из votchina: .github/scripts/owned.d.mts @ 0605847
// Типы для owned.mjs — его импортирует tools/test/guardrails.test.ts.
export function ownedPatterns(text: string): string[];
export function patternRegex(pattern: string): RegExp;
export function ownedFiles(files: string[], patterns: string[]): string[];
