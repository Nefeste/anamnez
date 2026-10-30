// из votchina: tools/test/guardrails.test.ts @ 1cd15dc
// Порядок работы с репозиторием (ADR студии 0018 и 0019): пути владельца в CODEOWNERS,
// проверки на PR, автослияние по метке, сборка APK только по тегу. Тест держит то, что
// легко сломать правкой одного файла: список путей, разбор CODEOWNERS (тот же, что в наборе),
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
        // задание из набора gornitsa-kit (`uses:`) выбирает машину само — там тоже ubuntu-24.04
        if (def.uses) continue;
        expect({ f, job, runsOn: def['runs-on'] }).toEqual({ f, job, runsOn: 'ubuntu-24.04' });
      }
    }
  });

  test('APK — только по тегу v*, без ручного запуска; AAB не собирается (решение владельца 03.10.2026)', () => {
    const on = wf('android.yml').on;
    expect(Object.keys(on)).toEqual(['push']);
    expect(on.push).toEqual({ tags: ['v*'] });
    const src = readFileSync(join(root, '.github', 'workflows', 'android.yml'), 'utf8');
    expect(src).not.toContain('bundleRelease');
    // тег сверяется с версией до проверок и сборки, а не рядом с ними: иначе ошибка тега сжигает минуты
    const jobs = wf('android.yml').jobs;
    expect(jobs.version.needs).toBeUndefined();
    for (const job of ['checks', 'web', 'key']) expect({ job, needs: jobs[job].needs }).toEqual({ job, needs: 'version' });
  });

  // Место под артефакты Actions общее на все закрытые репозитории аккаунта и считается за месяц:
  // в октябре 2026 оно кончилось, и сборки встали (docs/05-process.md, «Место под артефакты»).
  test('файлы сборки — «Релизу» кэшем, а не артефактом; артефакт — только снимки упавшего сценария', () => {
    for (const f of readdirSync(join(root, '.github/workflows'))) {
      const all = Object.values<any>(wf(f).jobs).flatMap(j => j.steps ?? []);
      const uses = (a: string) => all.filter((s: any) => String(s.uses).startsWith(a));
      expect({ f, download: uses('actions/download-artifact').length }).toEqual({ f, download: 0 });
      for (const s of uses('actions/upload-artifact')) {
        expect({ f, if: s.if, continueOnError: s['continue-on-error'], days: s.with['retention-days'] })
          .toEqual({ f, if: 'failure()', continueOnError: true, days: 7 });
      }
    }
    const jobs = wf('android.yml').jobs;
    const steps = (job: string, uses: string) => jobs[job].steps.filter((s: any) => String(s.uses).startsWith(uses));
    const [save] = steps('build', 'actions/cache/save');
    expect(save.if).toBe("needs.key.outputs.ready == 'yes'");
    const restored = steps('release', 'actions/cache/restore');
    expect(restored.map((r: any) => r.with.key)).toEqual(['apk', 'aab'].map(t => save.with.key.replace('${{ matrix.target }}', t)));
    for (const r of restored) {
      expect(r.with.path).toBe(save.with.path);
      expect(r.with['fail-on-cache-miss']).toBe(true);
      // перезапуск одного «Релиза» берёт сборку прежней попытки
      expect(r.with['restore-keys']).toBe(r.with.key.replace('${{ github.run_attempt }}', ''));
    }
    // APK есть всегда; AAB — если он в матрице задания «Ключ подписи» (строки там — JSON без пробелов)
    expect(restored[0].if).toBeUndefined();
    expect(restored[1].if).toBe(`contains(needs.key.outputs.matrix, '"target":"aab"')`);
    expect(jobs.key.steps[0].run).toContain('{"target":"apk"');
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
    expect(am.jobs.automerge.with.check).toBe(pr.jobs.checks.name);
    expect(am.jobs.automerge.with.label).toBe('ревью: ок');
    expect(am.on.workflow_run.workflows).toEqual([pr.name]);
  });

  // Сама логика — в наборе студии gornitsa-kit (ADR студии 0022): там выгружается только
  // `.github` из main, а код PR не запускается. Здесь — что вызов идёт из main, а не из PR.
  test('автослияние — из набора gornitsa-kit, на событиях, которые берут файл из main', () => {
    const am = wf('automerge.yml');
    expect(Object.keys(am.on).sort()).toEqual(['pull_request_target', 'workflow_run']);
    expect(Object.keys(am.jobs)).toEqual(['automerge']);
    expect(am.jobs.automerge.uses).toBe('Nefeste/gornitsa-kit/.github/workflows/automerge.yml@v1');
  });

  test('RuStore — из набора gornitsa-kit, только руками, пакет игры', () => {
    const rs = wf('rustore.yml');
    expect(Object.keys(rs.on)).toEqual(['workflow_dispatch']);
    expect(rs.jobs.upload.uses).toBe('Nefeste/gornitsa-kit/.github/workflows/rustore.yml@v1');
    expect(rs.jobs.upload.with.package).toBe(JSON.parse(read('app.json')).expo.android.package);
  });

  test('ключ, подпись и содержимое APK — действия набора; без сети, белый список — файлом', () => {
    const steps = wf('android.yml').jobs.build.steps;
    const kit = (name: string) => steps.find((s: any) => s.uses === `Nefeste/gornitsa-kit/actions/${name}@v1`);
    expect(kit('android-keystore').with['gradle-prefix']).toBe('ANAMNEZ');
    expect(kit('android-signature').with['keystore-file']).toBe('${{ steps.keystore.outputs.file }}');
    const contents = kit('android-contents').with;
    expect(contents.forbid).toContain('INTERNET');
    expect(read(contents['allow-file'])).toContain('android.permission.VIBRATE');
  });
});
