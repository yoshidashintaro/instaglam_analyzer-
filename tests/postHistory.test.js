// 投稿ごとの日次スナップショット（いいね・保存の推移）のテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_FIELDS,
  snapshotPosts,
  mergeHistory,
  postTimeline,
  historyIndex,
  historyDates,
  historyStatus,
  pruneHistory,
  snapshotDate,
} from '../public/js/postHistory.js';

const post = (id, ts) => ({ id, timestamp: ts });

test('snapshotPosts は値のある指標だけを残す', () => {
  const rows = snapshotPosts(
    [
      { id: 'a', likes: 10, saves: 2, comments: 0, shares: null, reach: 500 },
      { id: 'b', likes: '1,200', saves: '30' },
      { id: '', likes: 5 }, // ID の無い行は捨てる
      { id: 'c' }, // 指標がひとつも無い行は捨てる
    ],
    '2026-10-01',
  );
  assert.deepEqual(rows, [
    { id: 'a', date: '2026-10-01', likes: 10, saves: 2, comments: 0, reach: 500 },
    { id: 'b', date: '2026-10-01', likes: 1200, saves: 30 },
  ]);
  // 反応計は保存しない（4指標から足して出す）
  assert.ok(!('interactions' in rows[0]));
});

test('snapshotPosts は日付が無ければ何も作らない', () => {
  assert.deepEqual(snapshotPosts([{ id: 'a', likes: 1 }], null), []);
});

test('mergeHistory は同じ投稿・同じ日を 1 行にまとめ、欠けている指標だけ埋める', () => {
  // 投稿一覧（いいね・コメント）と投稿インサイト（リーチ・保存）を別々に取り込む
  const first = snapshotPosts([{ id: 'a', likes: 10, comments: 1 }], '2026-10-01');
  const second = snapshotPosts([{ id: 'a', reach: 800, saves: 4 }], '2026-10-01');
  const merged = mergeHistory(first, second);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], { id: 'a', date: '2026-10-01', likes: 10, comments: 1, reach: 800, saves: 4 });
});

test('mergeHistory は新しい値で上書きし、日付が違えば別の行になる', () => {
  const rows = mergeHistory(
    snapshotPosts([{ id: 'a', likes: 10 }], '2026-10-01'),
    snapshotPosts([{ id: 'a', likes: 14 }], '2026-10-02'),
  );
  assert.deepEqual(rows.map((r) => [r.date, r.likes]), [
    ['2026-10-01', 10],
    ['2026-10-02', 14],
  ]);
  // 同じ日をもう一度取り込めば上書き（重複しない）
  const again = mergeHistory(rows, snapshotPosts([{ id: 'a', likes: 11 }], '2026-10-01'));
  assert.equal(again.length, 2);
  assert.equal(again[0].likes, 11);
});

test('postTimeline は経過日数と前回からの増加を付ける', () => {
  const rows = mergeHistory(
    [],
    [
      ...snapshotPosts([{ id: 'a', likes: 10, saves: 2, comments: 0, shares: 0 }], '2026-10-01'),
      ...snapshotPosts([{ id: 'a', likes: 26, saves: 5, comments: 1, shares: 1 }], '2026-10-02'),
      ...snapshotPosts([{ id: 'a', likes: 31, saves: 9, comments: 1, shares: 1 }], '2026-10-04'),
      ...snapshotPosts([{ id: 'b', likes: 99 }], '2026-10-04'),
    ],
  );
  // 投稿は 9/30 21:00 JST
  const line = postTimeline(rows, post('a', '2026-09-30T12:00:00.000Z'));
  assert.deepEqual(line.map((r) => [r.date, r.day, r.likes, r.d_likes, r.saves, r.d_saves]), [
    ['2026-10-01', 1, 10, null, 2, null],
    ['2026-10-02', 2, 26, 16, 5, 3],
    ['2026-10-04', 4, 31, 5, 9, 4],
  ]);
  // 反応計は 4 指標がそろった行だけ出る
  assert.deepEqual(line.map((r) => r.interactions), [12, 33, 42]);
  assert.deepEqual(line.map((r) => r.d_interactions), [null, 21, 9]);
  // 他の投稿は混ざらない
  assert.equal(postTimeline(rows, post('b', '2026-10-03T00:00:00.000Z')).length, 1);
});

test('postTimeline は途中の取り込みに指標が無くても増加が途切れない', () => {
  const rows = mergeHistory(
    [],
    [
      ...snapshotPosts([{ id: 'a', likes: 10, reach: 100 }], '2026-10-01'),
      ...snapshotPosts([{ id: 'a', likes: 20 }], '2026-10-02'), // リーチの無いファイル
      ...snapshotPosts([{ id: 'a', likes: 24, reach: 180 }], '2026-10-03'),
    ],
  );
  const line = postTimeline(rows, post('a', '2026-10-01T00:00:00.000Z'));
  assert.deepEqual(line.map((r) => r.reach), [100, null, 180]);
  // 10/2 は値が無いので null、10/3 は「前に分かっていた 10/1 の 100」との差
  assert.deepEqual(line.map((r) => r.d_reach), [null, null, 80]);
});

test('postTimeline は投稿が見つからなければ空', () => {
  assert.deepEqual(postTimeline([], post('a', '2026-10-01T00:00:00.000Z')), []);
  assert.deepEqual(postTimeline(snapshotPosts([{ id: 'a', likes: 1 }], '2026-10-01'), { id: '' }), []);
});

test('postTimeline は投稿日時が分からなくても推移を返す（経過日数は null）', () => {
  const rows = snapshotPosts([{ id: 'a', likes: 1 }], '2026-10-01');
  assert.deepEqual(postTimeline(rows, 'a'), [
    { date: '2026-10-01', day: null, ...Object.fromEntries(HISTORY_FIELDS.map((k) => [k, k === 'likes' ? 1 : null])), ...Object.fromEntries(HISTORY_FIELDS.map((k) => [`d_${k}`, null])) },
  ]);
});

test('historyIndex / historyDates / historyStatus が収集状況を返す', () => {
  const rows = mergeHistory(
    [],
    [
      ...snapshotPosts([{ id: 'a', likes: 1 }, { id: 'b', likes: 2 }], '2026-10-01'),
      ...snapshotPosts([{ id: 'a', likes: 3 }], '2026-10-03'),
    ],
  );
  const idx = historyIndex(rows);
  assert.deepEqual(idx.get('a'), { count: 2, first: '2026-10-01', last: '2026-10-03' });
  assert.deepEqual(idx.get('b'), { count: 1, first: '2026-10-01', last: '2026-10-01' });
  assert.deepEqual(historyDates(rows), ['2026-10-01', '2026-10-03']);
  assert.deepEqual(historyStatus(rows), { rows: 3, posts: 2, days: 2, first: '2026-10-01', last: '2026-10-03' });
});

test('pruneHistory は投稿一覧から消えた投稿の履歴を捨てる', () => {
  const rows = snapshotPosts([{ id: 'a', likes: 1 }, { id: 'gone', likes: 2 }], '2026-10-01');
  const kept = pruneHistory(rows, [post('a', '2026-10-01T00:00:00.000Z')]);
  assert.deepEqual(kept.map((r) => r.id), ['a']);
});

test('pruneHistory は上限を超えたら古い投稿を丸ごと落とす', () => {
  const posts = [post('old', '2026-01-01T00:00:00.000Z'), post('new', '2026-06-01T00:00:00.000Z')];
  const rows = mergeHistory(
    [],
    [
      ...snapshotPosts([{ id: 'old', likes: 1 }], '2026-10-01'),
      ...snapshotPosts([{ id: 'old', likes: 2 }], '2026-10-02'),
      ...snapshotPosts([{ id: 'new', likes: 3 }], '2026-10-01'),
      ...snapshotPosts([{ id: 'new', likes: 4 }], '2026-10-02'),
    ],
  );
  const kept = pruneHistory(rows, posts, { maxRows: 2 });
  assert.deepEqual([...new Set(kept.map((r) => r.id))], ['new'], '新しい投稿の推移を残す');
  assert.equal(kept.length, 2, '残した投稿の推移は途切れさせない');
});

test('pruneHistory は投稿一覧が空なら間引かない（取り込み途中で消さないため）', () => {
  const rows = snapshotPosts([{ id: 'a', likes: 1 }], '2026-10-01');
  assert.deepEqual(pruneHistory(rows, []), rows);
});

test('snapshotDate は書き出しの期間末 → 取得日 → 今日の順に使う', () => {
  const now = new Date('2026-10-19T00:30:00.000Z'); // JST では 10/19 9:30
  assert.equal(snapshotDate({ end: '2026-10-08', fetchedAt: '2026-10-09' }, now), '2026-10-08');
  assert.equal(snapshotDate({ end: null, fetchedAt: '2026-10-09' }, now), '2026-10-09');
  assert.equal(snapshotDate({}, now), '2026-10-19');
  // UTC で前日になる時刻でも日本時間の日付になる
  assert.equal(snapshotDate({}, new Date('2026-10-18T20:00:00.000Z')), '2026-10-19');
});

// ---------- デモデータ ----------

test('デモデータには投稿ごとの推移が入っており、最新の値が投稿一覧と一致する', async () => {
  const { generateDemo } = await import('../public/js/data/demo.js');
  const ds = generateDemo({ endDate: new Date('2026-10-19T12:00:00+09:00') });
  assert.ok(ds.postHistory.length > 100, '推移データが少なすぎます');

  const status = historyStatus(ds.postHistory);
  assert.equal(status.days, 30, '直近30日分のスナップショット');
  assert.equal(status.last, '2026-10-19');

  // 推移が2回分以上ある投稿を選ぶ
  const idx = historyIndex(ds.postHistory);
  const post = ds.posts.find((p) => (idx.get(p.id)?.count || 0) >= 5);
  assert.ok(post, '推移のある投稿が見つかりません');

  const line = postTimeline(ds.postHistory, post);
  // 累計なので減らない
  for (const k of ['likes', 'saves', 'reach']) {
    const vals = line.map((r) => r[k]);
    assert.ok(vals.every((v) => v !== null), `${k} に欠けている時点があります`);
    for (let i = 1; i < vals.length; i++) assert.ok(vals[i] >= vals[i - 1], `${k} が ${line[i].date} で減っています`);
    assert.ok(line.at(-1)[k] >= line[0][k]);
  }
  // 最終時点は投稿一覧の値そのもの（集計の合計と食い違わない）
  assert.equal(line.at(-1).likes, post.likes);
  assert.equal(line.at(-1).saves, post.saves);
  assert.equal(line.at(-1).reach, post.reach);
  // 増加は1回目だけ空
  assert.equal(line[0].d_likes, null);
  assert.ok(line.slice(1).every((r) => r.d_likes !== null && r.d_likes >= 0));
});

test('デモデータの推移は保存上限に収まる', async () => {
  const { generateDemo } = await import('../public/js/data/demo.js');
  const ds = generateDemo();
  assert.ok(ds.postHistory.length <= 8000, `行数が多すぎます: ${ds.postHistory.length}`);
  assert.deepEqual(pruneHistory(ds.postHistory, ds.posts), ds.postHistory, '間引きの対象にならない');
});
