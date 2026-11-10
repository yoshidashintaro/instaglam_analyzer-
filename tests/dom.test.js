// 画面の配線チェック（ブラウザを起動せずに、よくある取り違えを防ぐ）。
// app.js が参照する id がすべて index.html にあるか、グラフの canvas がそろっているかを見る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(join(ROOT, p), 'utf8');
const matchAll = (text, re) => [...text.matchAll(re)].map((m) => m[1]);

test('app.js が参照する id はすべて index.html にある', async () => {
  const html = await read('public/index.html');
  const app = await read('public/js/app.js');
  const ids = new Set(matchAll(html, /id="([^"]+)"/g));
  const refs = [...new Set(matchAll(app, /\$\$?\('#([A-Za-z0-9_-]+)/g))];
  assert.ok(refs.length > 100, '参照している id を取り出せていません');
  assert.deepEqual(refs.filter((r) => !ids.has(r)), []);
});

test('グラフを描く canvas はすべて index.html にある', async () => {
  const html = await read('public/index.html');
  const app = await read('public/js/app.js');
  const canvases = new Set(matchAll(html, /<canvas id="([^"]+)"/g));
  const used = [
    ...matchAll(app, /charts\.[a-zA-Z]+\('(c-[a-z0-9-]+)'/g),
    ...matchAll(app, /setEmpty\('(c-[a-z0-9-]+)'/g),
  ];
  assert.ok(used.length > 10);
  assert.deepEqual([...new Set(used)].filter((c) => !canvases.has(c)), []);
});

test('「表で見る」に対応するカードは data-chart の値と canvas の id が一致している', async () => {
  const html = await read('public/index.html');
  // <article class="card" data-chart="c-xxx" ...> ... <canvas id="c-xxx">
  const cards = [...html.matchAll(/data-chart="([^"]+)"([\s\S]*?)<\/article>/g)];
  assert.ok(cards.length > 10);
  for (const [, key, body] of cards) {
    assert.ok(body.includes(`<canvas id="${key}"`), `${key} のカードに同じ id の canvas がありません`);
  }
});

test('新しく追加した画面（ストーリーズ・内訳・ベンチマーク）が index.html にある', async () => {
  const html = await read('public/index.html');
  for (const id of ['stories-block', 'stories-table', 'surface-row', 'clicks-card', 'tool-hashtag-card', 'benchmark-block', 'followed-table', 'tagged-table']) {
    assert.ok(html.includes(`id="${id}"`), `${id} がありません`);
  }
});

test('投稿ごとの推移ダイアログの部品が index.html にある', async () => {
  const html = await read('public/index.html');
  for (const id of ['post-dialog', 'post-dlg-head', 'post-dlg-totals', 'post-dlg-mode', 'post-dlg-metrics', 'post-dlg-csv', 'post-dlg-note', 'c-post-history', 'post-history-table']) {
    assert.ok(html.includes(`id="${id}"`), `${id} がありません`);
  }
  // 投稿一覧の「詳細」列（ヘッダーの数と各行の列数がずれないように）
  assert.ok(html.includes('class="col-detail"'), '詳細列の見出しがありません');
});

test('投稿一覧の見出しの数と、app.js が作るセルの数が合っている', async () => {
  const html = await read('public/index.html');
  const app = await read('public/js/app.js');
  const head = html.match(/<table[^>]*id="posts-table"[\s\S]*?<\/thead>/)[0];
  const ths = [...head.matchAll(/<th[\s>]/g)].length;
  // 日時・タイプ・内容 + 指標のループ + ER + 詳細
  const loop = app.match(/for \(const k of \['views', 'reach',[^\]]*\]\)/)[0];
  const metrics = [...loop.matchAll(/'[a-zA-Z]+'/g)].length;
  assert.equal(ths, 3 + metrics + 2, `見出し ${ths}個に対してセルが合いません`);
});

test('Search Console の画面（検索ブロック）が index.html にある', async () => {
  const html = await read('public/index.html');
  for (const id of [
    'search-block', 'search-scope', 'search-sort', 'search-summary', 'search-period', 'search-lead',
    'c-search-queries', 'search-query-table', 'search-gap-table', 'search-post-table', 'c-search-device', 'export-search',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `${id} がありません`);
  }
  // 投稿一覧の検索列
  for (const cls of ['col-searchImpressions', 'col-searchClicks', 'col-searchPosition']) {
    assert.ok(html.includes(cls), `${cls} の列がありません`);
  }
  // ZIP を受け取れること
  assert.match(html, /accept="[^"]*\.zip/, 'ファイル選択が ZIP を受け付けていません');
});

test('形式別の内訳（Top content formats）の画面が index.html にある', async () => {
  const html = await read('public/index.html');
  for (const id of ['formats-row', 'c-formats-views', 'formats-table', 'formats-sub']) {
    assert.ok(html.includes(`id="${id}"`), `${id} がありません`);
  }
});

test('KPI ツリーの画面が index.html にある', async () => {
  const html = await read('public/index.html');
  for (const id of ['kpi-block', 'kpi-lead', 'kpi-funnel', 'kpi-kgi', 'kpi-table', 'kpi-table-sub', 'kpi-edit', 'kpi-note', 'export-kpi']) {
    assert.ok(html.includes(`id="${id}"`), `${id} がありません`);
  }
});

// app.js はブラウザ前提でテストから import できないため、構文だけ別途チェックする。
// 変数の二重宣言のような「読み込んだ瞬間に落ちる」間違いを、ブラウザを開かずに見つける。
test('public/js のすべてのモジュールが構文エラーなく読める', async () => {
  const { readdir } = await import('node:fs/promises');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const walk = async (dir) => {
    const out = [];
    for (const e of await readdir(join(ROOT, dir), { withFileTypes: true })) {
      if (e.isDirectory()) out.push(...(await walk(`${dir}/${e.name}`)));
      else if (e.name.endsWith('.js')) out.push(`${dir}/${e.name}`);
    }
    return out;
  };

  const files = await walk('public/js');
  assert.ok(files.length >= 15, `モジュールを取り出せていません: ${files.length}`);
  for (const f of files) {
    await run(process.execPath, ['--check', join(ROOT, f)]).catch((e) => {
      assert.fail(`${f} に構文エラー: ${String(e.stderr || e).split('\n').slice(0, 3).join(' ')}`);
    });
  }
});

test('ファネルの見出しが5段階になっている', async () => {
  const html = await read('public/index.html');
  assert.match(html, /見る → 残す → 深める → つながる → HPへ/);
  assert.ok(!/投稿を見た人がたどる4段階/.test(html), '説明文が4段階のまま残っている');
});

test('相関カードが KPI ブロックに並んでいる（投稿と行動 → 投稿と流入）', async () => {
  const html = await read('public/index.html');
  for (const id of ['action-correlation-card', 'action-corr-target', 'action-corr-table', 'action-corr-sub', 'action-corr-note', 'brand-terms', 'brand-terms-row', 'brand-terms-note']) {
    assert.ok(html.includes(`id="${id}"`), `${id} がありません`);
  }
  // 「指標ごとの進捗」→「投稿と行動の相関」→「投稿と流入の相関」の順で、すべて KPI ブロックの中にある
  const kpi = html.slice(html.indexOf('id="kpi-block"'), html.indexOf('id="traffic-block"'));
  const order = ['id="kpi-table"', 'id="action-correlation-card"', 'id="correlation-card"'];
  let at = -1;
  for (const key of order) {
    const i = kpi.indexOf(key);
    assert.ok(i > at, `${key} の位置が想定と違います`);
    at = i;
  }
});

test('選べない相関の相手は、理由と必要なデータを画面に出す', async () => {
  const app = await read('public/js/app.js');
  // 黙って選択肢から消すと「実装されていない」ように見えるため、必ず注記を出す
  assert.match(app, /function missingActionNote/);
  assert.match(app, /function missingTargetNote/);
  assert.match(app, /ACTION_TARGET_HINTS/);
  assert.match(app, /TARGET_HINTS/);
  // すべての相手にヒントが用意されている
  const traffic = await read('public/js/traffic.js');
  const keys = [...traffic.matchAll(/\{ key: '([a-zA-Z]+)', label: 'HPへの流入|\{ key: '([a-zA-Z]+)', label: '(?:予約タップ|Google)/g)]
    .map((m) => m[1] || m[2]).filter(Boolean);
  for (const k of keys) assert.ok(app.includes(`${k}:`), `${k} のヒントがありません`);
});

test('非フォロワーへのリーチは、実数が無ければ比率から推定して使えることを案内する', async () => {
  const app = await read('public/js/app.js');
  // 「日次の実数が必要」と誤解させない
  assert.match(app, /リーチ内訳の書き出し（非フォロワー比率の1行サマリー）/);
  assert.match(app, /比率から推定して使えます/);
  // 推定値は（推定）と明示する（他のグラフと同じ扱い）
  assert.match(app, /const estimated = v\.nonFollowerEstimated;/);
  assert.match(app, /（推定）/);
});
