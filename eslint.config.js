// https://docs.expo.dev/guides/using-eslint/
// Кроме правил Expo и React Compiler — границы слоёв (docs/09-testing.md §1).
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

const ENGINE_PURE = 'Движок — чистый TypeScript без платформы (ADR 0004)';
const DETERMINISM = 'В движке случайность — только из Rng, время — только игровое (ADR 0004)';
const MATH = 'Math.exp/log/pow и тригонометрия в коде, меняющем состояние, запрещены (ADR 0004)';

module.exports = defineConfig([
  expoConfig,
  { ignores: ['dist/*', 'dist-web/*', 'src/content/generated/*'] },
  {
    files: ['src/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['react', 'react-*', 'react-native', 'react-native-*', 'expo', 'expo-*', '@shopify/*'], message: ENGINE_PURE },
          { group: ['@/state/*', '@/ui/*', '@/render/*', '@/app/*', '@/i18n/*', '@/audio/*', '**/state/*', '**/ui/*', '**/render/*'], message: ENGINE_PURE },
        ],
      }],
      'no-restricted-properties': ['error',
        { object: 'Math', property: 'random', message: DETERMINISM },
        { object: 'Date', property: 'now', message: DETERMINISM },
        { object: 'performance', property: 'now', message: DETERMINISM },
        { object: 'Math', property: 'exp', message: MATH },
        { object: 'Math', property: 'log', message: MATH },
        { object: 'Math', property: 'pow', message: MATH },
        { object: 'Math', property: 'sin', message: MATH },
        { object: 'Math', property: 'cos', message: MATH },
      ],
      'no-restricted-syntax': ['error', { selector: "NewExpression[callee.name='Date']", message: DETERMINISM }],
    },
  },
  {
    // Вывод и оценка состояние не меняют — им можно логарифмы (ADR 0004).
    files: ['src/engine/med/infer.ts', 'src/engine/med/policy.ts', 'src/engine/med/text.ts'],
    rules: {
      'no-restricted-properties': ['error',
        { object: 'Math', property: 'random', message: DETERMINISM },
        { object: 'Date', property: 'now', message: DETERMINISM },
      ],
    },
  },
  {
    // Интерфейс не читает правду пациента — только «вид» (docs/06-architecture.md §7).
    files: ['src/app/**/*.tsx', 'src/ui/**/*.tsx', 'src/render/**/*.tsx'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['**/engine/med/generate', '**/engine/med/exams', '**/engine/med/policy'], message: 'Интерфейс получает пациента только через src/state (вид), не через генератор' }],
      }],
    },
  },
]);
