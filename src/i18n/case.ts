// Название посреди фразы (часть 30д): с маленькой буквы — только первая и только если за ней
// строчная. Сокращения («ЭКГ», «Кабинет УЗИ» → «кабинет УЗИ»), «С-реактивный белок», единицы («°C») и
// фамилии («операция Гартмана», «симптом Мерфи») остаются как есть — `toLowerCase()` их портил.

/** «Лихорадка 38 °C и выше» → «лихорадка 38 °C и выше»; «ЭКГ» → «ЭКГ». */
export function lowerFirst(s: string): string {
  if (s.length < 2) return s.toLowerCase();
  const next = s[1];
  const lowerLetter = next !== next.toUpperCase() && next === next.toLowerCase();
  return lowerLetter ? `${s[0].toLowerCase()}${s.slice(1)}` : s;
}
