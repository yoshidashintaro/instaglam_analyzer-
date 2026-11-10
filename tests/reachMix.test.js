// リーチのフォロワー／非フォロワー内訳の取り込みと、非フォロワー数の推定
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeCSV, parseCSV, looksGarbled } from '../public/js/data/csv.js';
import { readReachBreakdown, mergeReachBreakdown, parsePeriod, breakdownFor, applyNonFollowerEstimate, describeBreakdowns, soleAccount } from '../public/js/data/reachMix.js';

test('readReachBreakdown: 期間集計の CSV（添付の形式）を読む', async () => {
  const rows = parseCSV(decodeCSV(await readFile(new URL('./fixtures/reach_breakdown.csv', import.meta.url))));
  const [b] = readReachBreakdown(rows);
  assert.deepEqual(b, {
    account: 'miselclinic_osaka', start: '2026-09-04', end: '2026-10-01',
    total: 38400, followers: 2656, nonFollowers: 36541, ratio: 93.2, fetchedAt: '2026-10-02',
    // オーガニック／広告の列が無い書き出しでは null
    organic: null, ads: null, adRatio: null, source: '',
  });
  assert.deepEqual(describeBreakdowns([b]), ['@miselclinic_osaka 2026/09/04〜2026/10/01 の非フォロワー比率 93.2%']);
  // 投稿や日次の CSV は対象外
  assert.equal(readReachBreakdown([['日付', 'リーチ'], ['2026-09-01', '100']]), null);
});

test('readReachBreakdown: 比率の列が無ければ フォロワー以外 ÷（フォロワー＋フォロワー以外）', () => {
  const [b] = readReachBreakdown([['アカウント', '開始日', '終了日', 'From followers', 'From non-followers'], ['@a', '2026/08/01', '2026/08/31', '100', '300']]);
  assert.equal(b.account, 'a');
  assert.equal(b.start, '2026-08-01');
  assert.equal(b.ratio, 75);
  assert.deepEqual(parsePeriod('2026年9月4日〜2026年10月1日'), { start: '2026-09-04', end: '2026-10-01' });
});

test('breakdownFor: 期間内を優先、無ければいちばん近い期間。別アカウントの比率は使わない', () => {
  const list = mergeReachBreakdown([], [
    { account: 'a', start: '2026-08-01', end: '2026-08-31', ratio: 60 },
    { account: 'a', start: '2026-09-04', end: '2026-10-01', ratio: 90 },
    { account: 'b', start: '2026-09-04', end: '2026-10-01', ratio: 20 },
  ]);
  assert.equal(breakdownFor(list, 'a', '2026-09-10').ratio, 90);
  assert.equal(breakdownFor(list, 'a', '2026-09-10').exact, true);
  assert.equal(breakdownFor(list, 'a', '2026-09-03').ratio, 90); // 9/4 の方が近い
  assert.equal(breakdownFor(list, 'a', '2026-09-03').exact, false);
  assert.equal(breakdownFor(list, 'b', '2026-07-01').ratio, 20);
  assert.equal(breakdownFor(list, 'c', '2026-09-10'), null);
});

test('applyNonFollowerEstimate: 実数の無い投稿・日だけ リーチ × 比率 で埋める', () => {
  const breakdowns = [{ account: 'a', start: '2026-09-04', end: '2026-10-01', ratio: 93.2 }];
  const posts = [
    { account: 'a', dateKey: '2026-09-10', reach: 1000, nonFollowerReach: null },
    { account: 'a', dateKey: '2026-09-11', reach: 1000, nonFollowerReach: 500 }, // 実数はそのまま
    { account: 'b', dateKey: '2026-09-11', reach: 1000, nonFollowerReach: null }, // 別アカウントは推定しない
    { account: 'a', dateKey: '2026-09-12', reach: null, nonFollowerReach: null },
  ];
  const daily = [{ date: '2026-09-10', reach: 4000, nonFollowerReach: null }];
  const res = applyNonFollowerEstimate({ posts, daily }, breakdowns, 'a');
  assert.equal(res.estimated, true);
  assert.deepEqual(res.posts.map((p) => [p.nonFollowerReach, !!p.nonFollowerEstimated]), [[932, true], [500, false], [null, false], [null, false]]);
  assert.equal(res.daily[0].nonFollowerReach, 3728);
  assert.equal(applyNonFollowerEstimate({ posts, daily }, [], 'a').estimated, false);
});

test('リーチ内訳：Excel で Shift_JIS 保存したファイルも読める／文字化けしたファイルは見分ける', async () => {
  const sjis = decodeCSV(await readFile(new URL('./fixtures/reach_breakdown_sjis.csv', import.meta.url)));
  assert.equal(looksGarbled(sjis), false);
  const [b] = readReachBreakdown(parseCSV(sjis));
  assert.equal(b.start, '2026-07-01');
  assert.equal(b.ratio, 93.2);
  assert.equal(b.fetchedAt, '2026-10-02');

  // BOM の無い UTF-8 を Excel で開いて保存し、壊れたファイル（実物）
  const garbled = decodeCSV(await readFile(new URL('./fixtures/reach_breakdown_garbled.csv', import.meta.url)));
  assert.equal(looksGarbled(garbled), true);
  assert.equal(readReachBreakdown(parseCSV(garbled)), null);
});

test('readReachBreakdown: オーガニック／広告の内訳が入った書き出し（集計期間の列名）も読む', async () => {
  const rows = parseCSV(decodeCSV(await readFile(new URL('./fixtures/reach_breakdown_organic.csv', import.meta.url))));
  const [b] = readReachBreakdown(rows);
  assert.equal(b.account, 'miselclinic_osaka');
  // 列名が「期間」ではなく「集計期間」でも読める
  assert.equal(b.start, '2026-04-01');
  assert.equal(b.end, '2026-10-19');
  assert.equal(b.total, 190335);
  assert.equal(b.nonFollowers, 186159);
  assert.equal(b.ratio, 97.8);
  assert.equal(b.organic, 46907);
  assert.equal(b.ads, 152582);
  assert.equal(b.adRatio, 80.2, '広告比率は書き出しの値をそのまま使う');
  assert.match(b.source, /Meta Business Suite/);
  assert.deepEqual(describeBreakdowns([b]), ['@miselclinic_osaka 2026/04/01〜2026/10/19 の非フォロワー比率 97.8%・広告比率 80.2%']);
});

test('readReachBreakdown: 広告比率の列が無ければ 広告 ÷（オーガニック＋広告）で出す', () => {
  const [b] = readReachBreakdown([
    ['アカウント', '集計期間', 'Instagramリーチ合計', 'From followers', 'From non-followers', 'From organic', 'From ads'],
    ['@a', '2026-04-01～2026-10-19', '1200', '200', '1000', '250', '750'],
  ]);
  assert.equal(b.adRatio, 75);
  assert.equal(b.organic, 250);
});

test('soleAccount: 内訳が1アカウントぶんだけならその名前を返す', () => {
  assert.equal(soleAccount([{ account: 'a' }, { account: 'a' }]), 'a');
  assert.equal(soleAccount([{ account: 'a' }, { account: 'b' }]), '', '複数あれば決められない');
  assert.equal(soleAccount([{ account: '' }]), '');
  assert.equal(soleAccount([]), '');
});

test('applyNonFollowerEstimate: 投稿に別アカウントが混ざっていても、日次には内訳の持ち主を使う', () => {
  const breakdowns = [{ account: 'miselclinic_osaka', start: '2026-04-01', end: '2026-10-19', ratio: 97.8, nonFollowers: 1, followers: 1, total: 2 }];
  const daily = [{ date: '2026-09-21', reach: 5656, nonFollowerReach: null }];
  // 投稿の多いアカウントが別でも、soleAccount で持ち主を決められる
  const main = soleAccount(breakdowns);
  assert.equal(main, 'miselclinic_osaka');
  const res = applyNonFollowerEstimate({ posts: [], daily }, breakdowns, main);
  assert.equal(res.estimated, true);
  assert.equal(res.daily[0].nonFollowerReach, Math.round(5656 * 0.978));
  assert.equal(res.daily[0].nonFollowerEstimated, true);

  // 持ち主を取り違えると推定は走らない（別アカウントの比率は使わない）
  const wrong = applyNonFollowerEstimate({ posts: [], daily }, breakdowns, 'dr.okudate_miselclinic');
  assert.equal(wrong.estimated, false);
  assert.equal(wrong.daily[0].nonFollowerReach, null);
});
