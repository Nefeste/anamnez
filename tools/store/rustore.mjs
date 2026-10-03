// из votchina: tools/store/rustore.mjs @ 0605847
// Загрузка APK в черновик новой версии в RuStore (docs/08-process.md, «Выкладывание в RuStore»).
//
//   RUSTORE_KEY_ID=<номер ключа> RUSTORE_API_TOKEN=<приватный ключ, base64> node tools/store/rustore.mjs anamnez-N.apk
//   ... --submit   — сразу отправить черновик на модерацию (по умолчанию нет: владелец смотрит
//                    черновик в консоли и отправляет сам)
//
// Ключ заводится в RuStore Консоли → «API RuStore» → «Сгенерировать ключ»: таблица показывает
// его номер (keyId), приватный ключ выдаётся один раз. API: POST /public/auth/ c подписью
// SHA-512/RSA от keyId + timestamp → JWE на 15 минут в заголовке Public-Token. Черновик у
// приложения может быть только один: если он уже есть, APK грузится в него.
// Обычный JS, не TypeScript: запускается голым node в CI, без сборки и зависимостей.
import { createPrivateKey, createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const API = 'https://public-api.rustore.ru';
const PACKAGE = 'games.gornitsa.anamnez';

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

/** Приватный ключ из консоли: base64 от DER (PKCS#8 или PKCS#1) либо готовый PEM. */
function privateKey(raw) {
  const text = raw.trim();
  if (text.includes('-----BEGIN')) return createPrivateKey(text);
  const der = Buffer.from(text.replace(/\s+/g, ''), 'base64');
  for (const type of ['pkcs8', 'pkcs1']) {
    try { return createPrivateKey({ key: der, format: 'der', type }); } catch { /* следующий формат */ }
  }
  fail('RUSTORE_API_TOKEN не похож на приватный ключ RSA (ожидается base64 из консоли RuStore)');
}

async function call(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(token ? { 'Public-Token': token } : {}), ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { code: String(res.status), message: text.slice(0, 500) }; }
  return { ok: res.ok && String(data.code).toUpperCase() === 'OK', status: res.status, data };
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const submit = args.includes('--submit');
  const keyId = process.env.RUSTORE_KEY_ID?.trim();
  const secret = process.env.RUSTORE_API_TOKEN;
  if (!file) fail('укажите APK: node tools/store/rustore.mjs anamnez-N.apk');
  if (!keyId || !secret) fail('нужны RUSTORE_KEY_ID (номер ключа) и RUSTORE_API_TOKEN (приватный ключ)');

  // 1. токен: подпись keyId + timestamp
  const timestamp = new Date().toISOString().replace('Z', '+00:00');
  const signature = createSign('RSA-SHA512').update(keyId + timestamp, 'utf8').sign(privateKey(secret), 'base64');
  const auth = await call(null, 'POST', '/public/auth/', { keyId, timestamp, signature });
  const token = auth.data.body?.jwe;
  if (!auth.ok || !token) fail(`авторизация не прошла (${auth.status}): ${auth.data.message ?? JSON.stringify(auth.data)}`);
  console.log('авторизация: ок');

  // 2. черновик: новый, а если он уже есть — существующий
  let versionId;
  const draft = await call(token, 'POST', `/public/v1/application/${PACKAGE}/version`, {});
  if (draft.ok && typeof draft.data.body === 'number') {
    versionId = draft.data.body;
    console.log(`черновик создан: ${versionId}`);
  } else {
    const list = await call(token, 'GET', `/public/v1/application/${PACKAGE}/version?pageSize=20`);
    const found = (list.data.body?.content ?? []).find(v => /draft/i.test(String(v.status ?? '')));
    if (!found) fail(`черновик не создан (${draft.status}): ${draft.data.message ?? JSON.stringify(draft.data)}`);
    versionId = found.versionId;
    console.log(`черновик уже был: ${versionId}`);
  }

  // 3. APK
  const form = new FormData();
  form.append('file', new File([readFileSync(file)], basename(file), { type: 'application/vnd.android.package-archive' }));
  const up = await call(token, 'POST', `/public/v1/application/${PACKAGE}/version/${versionId}/apk?isMainApk=true&servicesType=Unknown`, form);
  if (!up.ok) fail(`APK не загружен (${up.status}): ${up.data.message ?? JSON.stringify(up.data)}`);
  console.log(`APK загружен: ${basename(file)}`);

  // 4. на модерацию — только если попросили
  if (submit) {
    const commit = await call(token, 'POST', `/public/v1/application/${PACKAGE}/version/${versionId}/commit`);
    if (!commit.ok) fail(`на модерацию не отправлено (${commit.status}): ${commit.data.message ?? JSON.stringify(commit.data)}`);
    console.log('отправлено на модерацию');
  } else {
    console.log('черновик ждёт в консоли RuStore: проверить «Что нового» и отправить на модерацию');
  }
}

main().catch(e => fail(e instanceof Error ? e.message : String(e)));
