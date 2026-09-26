// Постоянный ключ подписи релизной сборки (ADR 0015) — перенос из «Вотчины».
//
// Папки android/ в репозитории нет — её создаёт `expo prebuild`, поэтому подпись
// настраивается здесь, а не правкой build.gradle. В отличие от «Вотчины», отладочным
// ключом шаблона релиз не подписывается никогда: CI без секретов ключа релиз не собирает.
//
// Ключ приходит свойствами Gradle — в CI это переменные ORG_GRADLE_PROJECT_ANAMNEZ_UPLOAD_*
// из секретов репозитория (.github/workflows/android.yml).
const { withAppBuildGradle } = require('expo/config-plugins');

const STORE = 'ANAMNEZ_UPLOAD_STORE_FILE';

/**
 * Дописывает в build.gradle релизную подпись. Шаблон build.gradle меняется от версии
 * к версии Expo; если он изменился так, что подпись встать не может, — исключение.
 */
function addReleaseSigning(gradle) {
  if (gradle.includes(STORE)) return gradle;
  const configs = /signingConfigs\s*\{/;
  const release = /(buildTypes\s*\{[\s\S]*?\brelease\s*\{[\s\S]*?)signingConfig\s+signingConfigs\.debug/;
  if (!configs.test(gradle) || !release.test(gradle)) {
    throw new Error('with-release-signing: шаблон android/app/build.gradle изменился — подпись релиза не настроена');
  }
  return gradle
    .replace(configs, m => `${m}
        release {
            if (project.hasProperty('${STORE}')) {
                storeFile file(project.property('${STORE}'))
                storePassword project.property('ANAMNEZ_UPLOAD_STORE_PASSWORD')
                keyAlias project.property('ANAMNEZ_UPLOAD_KEY_ALIAS')
                keyPassword project.property('ANAMNEZ_UPLOAD_KEY_PASSWORD')
            }
        }`)
    .replace(release, `$1signingConfig(project.hasProperty('${STORE}') ? signingConfigs.release : signingConfigs.debug)`);
}

const withReleaseSigning = config => withAppBuildGradle(config, c => {
  if (c.modResults.language !== 'groovy') throw new Error('with-release-signing: ожидался build.gradle на Groovy');
  c.modResults.contents = addReleaseSigning(c.modResults.contents);
  return c;
});

module.exports = withReleaseSigning;
module.exports.addReleaseSigning = addReleaseSigning;
