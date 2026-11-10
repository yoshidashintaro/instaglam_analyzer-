// 毎週の自動レポート（scripts/weeklyReport.js・scripts/dropbox.js）の、ブラウザや Dropbox を使わない部分
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { INPUT_EXT, apiArg } from '../scripts/dropbox.js';
import { importCounts, publishDelay, reportSettings } from '../scripts/weeklyReport.js';

test('apiArg: 日本語のパスは \\uXXXX にして、ヘッダーに ASCII だけを入れる', () => {
  const v = apiArg({ path: '/インスタ分析/レポート.md' });
  assert.match(v, /^[\x20-\x7e]+$/);
  assert.deepEqual(JSON.parse(v), { path: '/インスタ分析/レポート.md' });
});

test('INPUT_EXT: 画面の「ファイルを選択」と同じ拡張子だけを取り込む', () => {
  for (const n of ['a.csv', 'b.XLSX', 'c.zip', 'd.tsv']) assert.ok(INPUT_EXT.test(n), n);
  for (const n of ['report.md', 'report.docx', 'memo.pdf']) assert.ok(!INPUT_EXT.test(n), n);
});

test('reportSettings: 既定は直近7日。REPORT_DAYS と REPORT_SETTINGS で変えられる', () => {
  assert.deepEqual(reportSettings({}), { days: 7 });
  assert.deepEqual(reportSettings({ REPORT_DAYS: '30', REPORT_SETTINGS: '{"account":"miselclinic_osaka"}' }), { account: 'miselclinic_osaka', days: 30 });
  assert.equal(reportSettings({ REPORT_DAYS: '0' }).days, 0);
  assert.throws(() => reportSettings({ REPORT_DAYS: 'abc' }));
  assert.throws(() => reportSettings({ REPORT_SETTINGS: '{' }));
});

test('publishDelay: 6:00 に取り込み、6:15 まで待ってから保存する。過ぎていれば待たない', () => {
  assert.equal(publishDelay('06:15', new Date(2026, 10, 16, 6, 0, 30)), 14.5 * 60 * 1000);
  assert.equal(publishDelay('06:15', new Date(2026, 10, 16, 6, 20)), 0);
  assert.equal(publishDelay('', new Date()), 0);
  assert.throws(() => publishDelay('6時15分'));
});

test('importCounts: 取り込み画面の表示から件数だけを数える', () => {
  assert.deepEqual(importCounts('12件を取り込み、2件は読めませんでした a.csv / 読めませんでした → x.csv: … 読めませんでした → y.csv: …'), { done: 12, failed: 2 });
  assert.deepEqual(importCounts('a.csv: 投稿 3件'), { done: null, failed: 0 });
});

test('app.js: 自動レポートが使う窓口（取り込み完了の待ち・レポート作成）がある', async () => {
  const src = await readFile(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(src, /window\.iiaAuto = \{/);
  assert.match(src, /state\.importing = handleCSVFiles/);
  assert.match(src, /function makeReport\(format\)/);
});

test('ワークフロー: 月曜 6:00（日本時間）= 日曜 21:00 UTC に動く', async () => {
  const yml = await readFile(new URL('../.github/workflows/weekly-report.yml', import.meta.url), 'utf8');
  assert.match(yml, /cron: '0 21 \* \* 0'/);
  assert.match(yml, /node scripts\/weeklyReport\.js/);
});
