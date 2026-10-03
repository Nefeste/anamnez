// из votchina: tools/test/guardrails.test.ts @ 0605847
// Порядок работы с репозиторием (ADR студии 0018 и 0019): пути владельца в CODEOWNERS,
// проверки на PR, автослияние по метке, сборка APK только по тегу. Тест держит то, что
// легко сломать правкой одного файла: список путей, разбор CODEOWNERS для automerge.yml,
// имена, по которым workflow находят друг друга, и машины CI.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { ownedFiles, ownedPatterns } from '../../.github/scripts/owned.mjs';

const root = join(import.meta.dir, '..', '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const wf = (f: string) => YAML.parse(read(`.github/workflows/${f}`));

describe('CODEOWNERS', () => {
  const patterns = ownedPatterns(read('.github/CODEOWNERS'));

  test('пути владельца — все, и у каждого владелец @Nefeste', () => {
    expect(patterns).toEqual(['/deploy/', '/.github/', '/server/', '/src/money/', '/store/forms.md', '/store/privacy*', '/app.json', '/eas.json']);
    for (const line of read('.github/CODEOWNERS').split('\n').filter(l => l.trim() && !l.startsWith('#'))) {
      expect(line.trim().split(/\s+/).slice(1)).toEqual(['@Nefeste']);
    }
  });

  test('разбор: что задевает пути владельца, а что нет', () => {
    const owned = ['.github/workflows/pr.yml', '.github/CODEOWNERS', '.github/scripts/owned.mjs', 'app.json', 'eas.json',
      'store/forms.md', 'store/privacy.ru.md', 'store/privacy.en.md', 'src/money/pay.ts', 'deploy/x.sh', 'server/index.ts'];
    const free = ['src/app/index.tsx', 'src/moneybox.ts', 'store/listing.ru.md', 'store/forms.md.bak', 'docs/server/x.md',
      'tools/test/x.test.ts', 'README.md', 'STATUS.md', 'src/app.json', 'docs/app.json.md', 'content/exams/ecg.yaml'];
    expect(ownedFiles([...owned, ...free], patterns)).toEqual(owned);
    expect(ownedFiles(free, patterns)).toEqual([]);
  });

  test('строка без владельца или с непонятным шаблоном — ошибка, а не пропуск', () => {
    expect(() => ownedPatterns('/server/\n')).toThrow();
    expect(() => ownedPatterns('/a?b @Nefeste\n')).toThrow();
  });
});

describe('workflow', () => {
  test('везде ubuntu-24.04, нигде ubuntu-latest', () => {
    for (const f of readdirSync(join(root, '.github/workflows'))) {
      const text = read(`.github/workflows/${f}`);
      expect({ f, latest: text.includes('ubuntu-latest') }).toEqual({ f, latest: false });
      for (const [job, def] of Object.entries<any>(YAML.parse(text).jobs)) {
        expect({ f, job, runsOn: def['runs-on'] }).toEqual({ f, job, runsOn: 'ubuntu-24.04' });
      }
    }
  });

  test('APK и AAB — только по тегу v*, без ручного запуска', () => {
    const on = wf('android.yml').on;
    expect(Object.keys(on)).toEqual(['push']);
    expect(on.push).toEqual({ tags: ['v*'] });
  });

  test('PR: база, типы, линтер и тесты без сборки, на каждом PR; имя проверки — то, что ждёт автослияние', () => {
    const pr = wf('pr.yml');
    expect(Object.keys(pr.on)).toEqual(['pull_request']);
    // обязательная проверка отвечает на каждом PR, и на документах тоже (ADR студии 0019)
    expect(pr.on.pull_request['paths-ignore']).toBeUndefined();
    expect(pr.on.pull_request.paths).toBeUndefined();
    const steps = JSON.stringify(pr.jobs);
    for (const cmd of ['bun tools/content/build.ts', 'npx tsc --noEmit', 'npx tsc --noEmit -p tools', 'npm run lint', 'bun test tools/test']) {
      expect(steps).toContain(cmd);
    }
    expect(steps).not.toMatch(/gradle|prebuild/i);
    const am = wf('automerge.yml');
    const env = am.jobs.automerge.steps.find((s: any) => s.env?.CHECK).env;
    expect(env.CHECK).toBe(pr.jobs.checks.name);
    expect(env.LABEL).toBe('ревью: ок');
    expect(am.on.workflow_run.workflows).toEqual([pr.name]);
  });

  test('автослияние берёт правила из main и код PR не выгружает', () => {
    const am = wf('automerge.yml');
    expect(Object.keys(am.on).sort()).toEqual(['pull_request_target', 'workflow_run']);
    const checkouts = am.jobs.automerge.steps.filter((s: any) => String(s.uses).startsWith('actions/checkout'));
    expect(checkouts.map((s: any) => [s.with.ref, s.with['sparse-checkout']])).toEqual([
      ['${{ github.event.repository.default_branch }}', '.github'],
    ]);
  });
});
