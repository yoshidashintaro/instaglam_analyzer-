// 公開用の設定（noindex）を確認する
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '../scripts/bundle.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('検索エンジンに載せない（noindex）', async () => {
  const robots = /<meta name="robots" content="noindex, nofollow, noarchive" \/>/;
  assert.match(await readFile(join(ROOT, 'public/index.html'), 'utf8'), robots);
  assert.match(await bundle(), robots);
  assert.match(await readFile(join(ROOT, 'deploy/.htaccess'), 'utf8'), /X-Robots-Tag "noindex, nofollow, noarchive"/);
});

test('ベーシック認証の設定が .htaccess に入っている', async () => {
  const ht = await readFile(join(ROOT, 'deploy/.htaccess'), 'utf8');
  assert.match(ht, /AuthType Basic/);
  assert.match(ht, /AuthName "/);
  assert.match(ht, /AuthUserFile /);
  assert.match(ht, /Require valid-user/);
  // パスワードファイル自体は配信させない（Apache 2.2 / 2.4 の両方に備える）
  assert.match(ht, /<Files "\.htpasswd">/);
  assert.match(ht, /Require all denied/);
  assert.match(ht, /Deny from all/);
  // 絶対パスは環境ごとに違うので、書き換えが必要なことが分かる状態にしておく
  assert.match(ht, /書き換え/);
});

test('パスワードファイルはビルド出力（docs/）に含めない', async () => {
  const build = await readFile(join(ROOT, 'scripts/build.js'), 'utf8');
  assert.ok(!/cp\([^)]*htpasswd/.test(build), 'docs/ は公開リポジトリに入るため .htpasswd を含めてはいけない');
  // .gitignore で除外されている
  assert.match(await readFile(join(ROOT, '.gitignore'), 'utf8'), /deploy\/\.htpasswd/);
});

test('サーバーの共有データ（data.json）を読み込む導線がある', async () => {
  const html = await readFile(join(ROOT, 'public/index.html'), 'utf8');
  const app = await readFile(join(ROOT, 'public/js/app.js'), 'utf8');
  assert.match(html, /id="load-shared"/);
  assert.match(html, /id="empty-shared"/);
  assert.match(html, /data\.json/);
  // index.html と同じ場所を相対で見る（サブフォルダ設置でも動く）
  assert.match(app, /new URL\('data\.json', location\.href\)/);
  // ファイルを直接開いたときは取りに行かない
  assert.match(app, /location\.protocol !== 'file:'/);
});

test('共有データ（data.json）は公開リポジトリに入れない', async () => {
  const ignore = await readFile(join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /docs\/data\.json/, 'GitHub Pages に実データを載せてしまわないようにする');
});
