// Релизная сборка без доступа к сети (ADR 0006).
//
// blockedPermissions в app.json убрал бы INTERNET из обеих сборок, а отладочной он нужен,
// чтобы брать код у Metro. Поэтому разрешения вырезаются манифестом варианта release:
// сборщик манифестов Android сливает android/app/src/release/AndroidManifest.xml поверх
// основного, и tools:node="remove" убирает разрешение — в том числе пришедшее из библиотек.
const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('expo/config-plugins');

const REMOVED = ['android.permission.INTERNET', 'android.permission.ACCESS_NETWORK_STATE'];

const manifest = () => `<?xml version="1.0" encoding="utf-8"?>
<!-- Создано plugins/with-release-no-internet.js (ADR 0006). Не править руками. -->
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools">
${REMOVED.map(p => `    <uses-permission android:name="${p}" tools:node="remove" />`).join('\n')}
</manifest>
`;

const withReleaseNoInternet = config => withDangerousMod(config, ['android', async c => {
  const dir = path.join(c.modRequest.platformProjectRoot, 'app', 'src', 'release');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'AndroidManifest.xml'), manifest());
  return c;
}]);

module.exports = withReleaseNoInternet;
module.exports.REMOVED = REMOVED;
