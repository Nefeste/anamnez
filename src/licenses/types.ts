// Лицензии открытых компонентов (spec 2026-10-licenses, 0.5.6): что показывает экран «Лицензии». Файл licenses.json
// собирает `tools/licenses/build.ts` — из карты кода сборки для Android и `tools/licenses/native.yaml`; с 0.6.6 в нём и
// записи звуков под CC BY (ADR 0019).

export interface LicenseItem {
  name: string;
  version?: string;
  /** идентификатор лицензии SPDX или их сочетание */
  license: string;
  /** правообладатель: строка «Copyright …» из текста лицензии или автор пакета */
  holder: string;
  /**
   * откуда библиотека в игре: React Native, модули Expo, Skia (у библиотек Android); у записи звука — что она в игре и
   * что в ней изменено
   */
  via?: string;
  /** где взята запись — страница с автором и лицензией (только у звуков) */
  source?: string;
  /** ключи текстов лицензий в `Licenses.texts`, по порядку */
  texts: string[];
  /** каталог пакета от корня репозитория (только у кода JS) — по нему тест пересобирает список */
  path?: string;
}

export interface LicenseGroup {
  key: 'fonts' | 'js' | 'android' | 'sounds';
  items: LicenseItem[];
}

export interface Licenses {
  groups: LicenseGroup[];
  /** тексты лицензий по отпечатку: одинаковый текст хранится один раз */
  texts: Record<string, string>;
}
