// レポート出力（Markdown / Word）が、画面の集計結果をすべて含むか確認する
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDaily, normalizePost, enrichPosts, anchorFollowers, detectFollowerMode,
  periodBounds, slice, summarize, funnel, audienceSummary, accountsOf, byAccount,
  byType, timeHeatmap, groupByKey, hashtagStats, generateInsights, addDays,
} from '../public/js/analytics.js';
import {
  weeklyTraffic, weeklyInstagram, joinWeeks, correlationTable, laggedCorrelation,
  landingRate, trafficBreakdown, scatterData, trafficInsights, weekStart,
} from '../public/js/traffic.js';
import { primaryRows } from '../public/js/data/ga4.js';
import { unzip } from '../public/js/data/xlsx.js';
import { generateDemo } from '../public/js/data/demo.js';
import { buildReport, toMarkdown } from '../public/js/report.js';
import { toDocx } from '../public/js/docx.js';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeCSV, parseCSV } from '../public/js/data/csv.js';
import { readSocialInsight, mergeHashtags, mergeFollowed, mergeSummary, mergeStories, mergeTagged } from '../public/js/data/socialInsight.js';
import { sliceStories, summarizeStories, storiesByDate, storiesByHour } from '../public/js/stories.js';
import {
  sliceByDate, surfaceBreakdown, clickBreakdown, accountTotals, hashtagSets, benchmarkSummary, taggedInPeriod,
} from '../public/js/account.js';

/** デモデータの期間に合わせた GA4 の流入（週ごとにばらつかせる） */
function demoGA4(daily) {
  const rows = [];
  daily.forEach((d, i) => {
    rows.push({ date: d.date, sourceMedium: 'instagram / social', level: 'source', sessions: 20 + (i % 9) * 3, users: 18, newUsers: 9, reserveTaps: i % 4, cv: i % 7 === 0 ? 1 : 0 });
    if (i % 3 === 0) rows.push({ date: d.date, sourceMedium: 'instagram / paid', level: 'source', sessions: 12, users: 11, newUsers: 8, reserveTaps: 1, cv: 0 });
  });
  return rows;
}

/** app.js の compute() と同じ集計（前期間・GA4 を含む） */
function compute(ds, { days = 90, basis = 'reach' } = {}) {
  const daily = normalizeDaily(anchorFollowers(ds.daily, ds.audience));
  const followerMode = ds.followerMode || detectFollowerMode(daily);
  const all = enrichPosts(ds.posts.map(normalizePost), daily, basis, ds.account?.followersCount);
  const accounts = accountsOf(all);
  const { startKey, endKey } = periodBounds(daily, all, days);
  const cur = slice(daily, all, startKey, endKey);
  const pEnd = addDays(startKey, -1);
  const prev = slice(daily, all, addDays(pEnd, -(days - 1)), pEnd);
  const summary = summarize(cur.daily, cur.posts);
  const prevSummary = summarize(prev.daily, prev.posts);
  const types = byType(cur.posts);
  const heatmap = timeHeatmap(cur.posts, { blockHours: 3 });
  const hours = groupByKey(cur.posts, (p) => p.hour, 24);
  const weekdays = groupByKey(cur.posts, (p) => p.weekday, 7);
  const hashtags = hashtagStats(cur.posts);
  const steps = funnel(summary);
  const audience = audienceSummary(ds.audience);
  const accountStats = byAccount(cur.posts);

  const ga = ds.ga4.filter((r) => r.date >= weekStart(startKey) && r.date <= addDays(weekStart(endKey), 6));
  const gaWeeks = weeklyTraffic(primaryRows(ga), { fallbackAccount: 'demo' });
  const joined = joinWeeks(weeklyInstagram(all, daily), gaWeeks);
  const breakdown = trafficBreakdown(gaWeeks, { fallbackAccount: 'demo' });
  const table = correlationTable(joined, { target: 'organic' });
  const lagged = laggedCorrelation(joined, { target: 'organic' });
  const landing = landingRate(joined, { account: 'demo' });
  const traffic = {
    gaWeeks, joined, breakdown, table, lagged, landing, target: 'organic', driverKey: 'posts',
    insights: trafficInsights({ table, lagged, breakdown, landing, joined }),
    scatter: scatterData(joined, 'posts', 'organic'), properties: ['demo'], campaigns: [{ name: 'spring', sessions: 40, users: 30, taps: 3 }],
  };
  const insights = generateInsights({ summary, prevSummary, types, heatmap, hours, hashtags, posts: cur.posts, steps, audience, accounts: accountStats });
  return {
    startKey, endKey, daily: cur.daily, posts: cur.posts, summary, prevSummary,
    types, heatmap, hours, weekdays, hashtags, insights, steps, audience, accounts, accountStats, account: '', followerMode, traffic,
  };
}

/** tests/fixtures の si__*.csv から、app.js の compute() と同じ形の si を作る */
async function siFixture() {
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
  const ds = { accountDaily: [], hashtags: [], followed: [], stories: [], tagged: [] };
  for (const name of (await readdir(dir)).filter((n) => n.startsWith('si__')).sort()) {
    const res = readSocialInsight(parseCSV(decodeCSV(await readFile(join(dir, name)))), { fileName: name });
    if (res.summary.length) ds.accountDaily = mergeSummary(ds.accountDaily, res.summary);
    if (res.hashtags.length) ds.hashtags = mergeHashtags(ds.hashtags, res.hashtags);
    if (res.followed.length) ds.followed = mergeFollowed(ds.followed, res.followed);
    if (res.stories.length) ds.stories = mergeStories(ds.stories, res.stories);
    if (res.tagged.length) ds.tagged = mergeTagged(ds.tagged, res.tagged);
  }
  const stories = sliceStories(ds.stories);
  const rows = sliceByDate(ds.accountDaily);
  return {
    stories,
    storiesSummary: summarizeStories(stories),
    storiesDaily: storiesByDate(stories),
    storiesHours: storiesByHour(stories),
    surfaces: surfaceBreakdown(rows),
    clicks: clickBreakdown(rows),
    totals: accountTotals(rows),
    hashtagSets: hashtagSets(ds.hashtags),
    followed: ds.followed,
    benchmark: benchmarkSummary(ds.followed),
    tagged: taggedInPeriod(ds.tagged),
  };
}

function fixture() {
  const ds = generateDemo({ endDate: new Date('2026-09-30T12:00:00') });
  ds.ga4 = demoGA4(ds.daily);
  const v = compute(ds);
  const report = buildReport(v, { dataset: ds, settings: { basis: 'reach', topMetric: 'saves' }, warnings: ['テスト用の注意'], generatedAt: new Date('2026-10-01T09:00:00') });
  return { ds, v, report };
}

test('レポートに画面の全セクションが入る', () => {
  const { report } = fixture();
  const headings = report.blocks.filter((b) => b.type === 'h').map((b) => b.text);
  for (const h of [
    'Instagram インサイト分析レポート', 'データについての注意', '主要指標', '自動分析レポート',
    'フォロワーの増減とアカウントの活動', '日次データ', 'エンゲージメント率', '投稿タイプ別', '投稿ごとの反応',
    '上位10投稿（エンゲージメント率順）', '上位10投稿（保存順）', '最適な投稿時間帯', '曜日 × 時間帯',
    'HPへの流入（GA4）', '週ごとの Instagram 流入', 'UTM キャンペーン別の流入', 'フォロワーの内訳', 'ハッシュタグ別の反応',
  ]) {
    assert.ok(headings.includes(h), `見出し「${h}」がない`);
  }
  assert.ok(headings.some((h) => h.startsWith('全投稿一覧')));
  assert.ok(headings.some((h) => h.startsWith('投稿と流入の相関')));
});

test('ソーシャルインサイトの追加データ（ストーリーズ・面別・ベンチマーク）もレポートに入る', async () => {
  const { ds, v } = fixture();
  const si = await siFixture();
  const report = buildReport({ ...v, si }, { dataset: ds, settings: { basis: 'reach', topMetric: 'er' }, generatedAt: new Date('2026-10-09T09:00:00') });
  const headings = report.blocks.filter((b) => b.type === 'h').map((b) => b.text);
  for (const h of [
    'どこで見られているか（面別・期間合計）', 'リーチの内訳と転換率（実測値）', 'プロフィールからのアクション（期間合計）',
    'ストーリーズ', '他アカウントとの関係',
  ]) {
    assert.ok(headings.includes(h), `見出し「${h}」がない`);
  }
  // 時間帯別は同じ時間帯に2本以上あるときだけ出す（このデータは1本ずつなので出ない）
  assert.ok(!headings.includes('投稿した時間帯別 平均閲覧率（2本以上ある時間帯）'));
  assert.ok(headings.some((h) => h.startsWith('ストーリーズ一覧')));
  assert.ok(headings.some((h) => h.startsWith('フォロー中アカウント')));
  assert.ok(headings.some((h) => h.startsWith('タグ付き投稿')));
  assert.ok(headings.some((h) => h.startsWith('ソーシャルインサイトの集計')));

  const md = toMarkdown(report);
  assert.ok(md.includes('広告'), '面別の内訳に広告の行がない');
  assert.ok(md.includes('@dr.okudate_miselclinic'), 'タグ付き投稿のアカウントがない');
  assert.ok(md.includes('フォロワー転換率'));
  // 分母の違う2種類のハッシュタグ集計が、別の表として入る
  assert.ok(md.includes('閲覧数基準') && md.includes('フォロワー数基準'));
});

test('ソーシャルインサイトのデータが無いレポートは、そのセクションを出さない', () => {
  const { report } = fixture();
  const headings = report.blocks.filter((b) => b.type === 'h').map((b) => b.text);
  assert.ok(!headings.includes('ストーリーズ'));
  assert.ok(!headings.includes('他アカウントとの関係'));
});

test('全投稿と全日次データが省略されずに入る', () => {
  const { v, report } = fixture();
  const posts = report.blocks.find((b) => b.type === 'h' && b.text.startsWith('全投稿一覧'));
  const postTable = report.blocks[report.blocks.indexOf(posts) + 1];
  assert.equal(postTable.rows.length, v.posts.length);
  const dailyHead = report.blocks.findIndex((b) => b.type === 'h' && b.text === '日次データ');
  assert.equal(report.blocks[dailyHead + 1].rows.length, v.daily.length);
  // 表の行の列数は見出しと一致する
  for (const b of report.blocks.filter((x) => x.type === 'table')) {
    for (const r of b.rows) assert.equal(r.length, b.head.length, b.head.join(','));
    assert.equal(b.align.length, b.head.length);
  }
});

test('Markdown: 表の区切りが崩れない', () => {
  const { report } = fixture();
  report.blocks.push({ type: 'table', head: ['a', 'b'], rows: [['x|y', '1\n2']], align: ['l', 'r'] });
  const md = toMarkdown(report);
  assert.match(md, /^# Instagram インサイト分析レポート/);
  assert.match(md, /\| x\\\|y \| 1 2 \|/);
  assert.match(md, /\| --- \| ---: \|/);
  assert.ok(md.includes('【'), '自動分析の所見が入る');
});

test('Word: 開ける .docx の構成になっている', async () => {
  const { v, report } = fixture();
  const bytes = toDocx(report, new Date('2026-10-01T09:00:00'));
  const files = await unzip(bytes);
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml']) {
    assert.ok(files.has(name), `${name} がない`);
  }
  const xml = new TextDecoder().decode(files.get('word/document.xml'));
  // 開き・閉じタグの数が揃っている（XML として壊れていない目安）
  for (const tag of ['w:p', 'w:tbl', 'w:tr', 'w:tc', 'w:r']) {
    const open = (xml.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length;
    const close = (xml.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    assert.equal(open, close, tag);
  }
  // タグを除いた本文に生の < > & が残っていない
  const text = xml.replace(/<[^<>]+>/g, '').replace(/&(amp|lt|gt|quot);/g, '');
  assert.ok(!/[<>&]/.test(text), 'エスケープ漏れ');
  assert.ok(xml.includes('全投稿一覧'));
  assert.equal((xml.match(/<w:tbl>/g) || []).length, report.blocks.filter((b) => b.type === 'table').length);
  assert.ok(v.posts.length > 0);
});

test('Search Console のデータもレポートに入る', async () => {
  const { ds, v } = fixture();
  const { readSearchConsoleZip, searchSummary, queryRows, underperformingQueries } = await import('../public/js/data/searchConsole.js');
  const { makeSearchZip } = await import('./helpers/searchZip.js');

  const prop = (await readSearchConsoleZip(makeSearchZip(), 'instagram.com_demo_account-Performance-on-Search-2026-10-19.zip')).property;
  const scoped = [prop];
  const search = {
    all: scoped, instagram: scoped, site: [], scope: 'instagram', scoped,
    available: { instagram: true, site: false, all: true },
    summary: searchSummary(scoped),
    queries: queryRows(scoped, { sort: 'clicks' }),
    gaps: underperformingQueries(scoped, { minImpressions: 100 }),
    daily: [],
    devices: [{ device: 'モバイル', clicks: 345, impressions: 15725, ctr: 2.19, position: 13.64 }],
    filter: prop.filter,
  };
  // 検索データのある投稿を1件混ぜる
  const posts = v.posts.map((p, i) =>
    i === 0 ? { ...p, searchImpressions: 696, searchClicks: 36, searchPosition: 12.5 } : { ...p, searchImpressions: null, searchClicks: null, searchPosition: null },
  );

  const report = buildReport({ ...v, posts, search }, { dataset: ds, settings: { basis: 'reach', topMetric: 'er' }, generatedAt: new Date('2026-10-19T09:00:00') });
  const headings = report.blocks.filter((b) => b.type === 'h').map((b) => b.text);
  for (const h of ['Google 検索からの流入（Search Console）', '検索クエリ 上位15件', '伸びしろのある検索語', '検索から見つかっている投稿', 'デバイス別']) {
    assert.ok(headings.includes(h), `見出し「${h}」がない`);
  }
  const md = toMarkdown(report);
  assert.match(md, /ミセルクリニック大阪梅田院/, '検索語が本文に出ていない');
  assert.match(md, /平均掲載順位/);
});

test('Search Console を取り込んでいなければレポートに節を作らない', () => {
  const { ds, v } = fixture();
  const report = buildReport({ ...v, search: { summary: null, queries: [], gaps: [], devices: [], scoped: [] } }, { dataset: ds, settings: { basis: 'reach', topMetric: 'er' } });
  const headings = report.blocks.filter((b) => b.type === 'h').map((b) => b.text);
  assert.ok(!headings.includes('Google 検索からの流入（Search Console）'));
});

test('KPI ツリーがレポートに入る', async () => {
  const { ds, v } = fixture();
  const { kpiValues, kpiRows, stageFunnel, periodDays } = await import('../public/js/kpi.js');
  const input = { summary: v.summary, posts: v.posts, traffic: v.traffic, si: null };
  const days = periodDays(v.startKey, v.endKey);
  const kpi = { days, values: kpiValues(input), funnel: stageFunnel(input), rows: kpiRows(kpiValues(input), days) };

  const report = buildReport({ ...v, kpi }, { dataset: ds, settings: { basis: 'reach', topMetric: 'er' } });
  const headings = report.blocks.filter((b) => b.type === 'h').map((b) => b.text);
  assert.ok(headings.includes('KPI ツリー（目標に対する進捗）'));
  assert.ok(headings.includes('見る → 残す → 深める → つながる → HPへ'));
  const md = toMarkdown(report);
  assert.match(md, /興味関心層の獲得数/);
  assert.match(md, /保存数/);
  assert.match(md, /つながる（関係化）/);
  assert.match(md, /深める（関心）/, '新しい段階が入っている');
});

test('KPI が無ければレポートに節を作らない', () => {
  const { ds, v } = fixture();
  const report = buildReport({ ...v, kpi: null }, { dataset: ds, settings: { basis: 'reach', topMetric: 'er' } });
  const headings = report.blocks.filter((b) => b.type === 'h').map((b) => b.text);
  assert.ok(!headings.includes('KPI ツリー（目標に対する進捗）'));
});

test('投稿と行動の相関がレポートに入る', async () => {
  const { ds, v } = fixture();
  const { joinActions, correlationTable, ACTION_DRIVERS, weeklyInstagram } = await import('../public/js/traffic.js');
  const weeks = joinActions(weeklyInstagram(v.posts, v.daily), { dropPartial: false });
  const actions = { weeks, targets: [], target: 'keepActions', table: correlationTable(weeks, { target: 'keepActions', drivers: ACTION_DRIVERS }) };
  const report = buildReport({ ...v, actions }, { dataset: ds, settings: { basis: 'reach', topMetric: 'er' } });
  const headings = report.blocks.filter((b) => b.type === 'h').map((b) => b.text);
  assert.ok(headings.some((h) => h.startsWith('投稿と行動の相関（相手: 保存数＋シェア数')), `見出しがない: ${headings.join(' / ')}`);
  assert.match(toMarkdown(report), /どちらも Instagram のデータなので/);
});

test('指標の推移（月別）・投稿後の伸び・投稿一覧の追加列（プロフ遷移・平均再生・検索）もレポートに入る', async () => {
  const { ds, v } = fixture();
  const { snapshotPosts, mergeHistory, historyIndex, historyStatus } = await import('../public/js/postHistory.js');
  // 投稿ごとの記録を2回分（2回目はいいね・保存が増えている）
  const posts = v.posts.map((x, i) => ({ ...x, profileVisits: 3 + i, avgWatchSec: x.type === 'REELS' ? 7.5 : null, searchImpressions: i === 0 ? 120 : null, searchClicks: i === 0 ? 4 : null, searchPosition: i === 0 ? 8.25 : null }));
  const first = snapshotPosts(posts, '2026-09-28');
  const second = snapshotPosts(posts.map((x) => ({ ...x, likes: (x.likes ?? 0) + 5, saves: (x.saves ?? 0) + 2 })), '2026-09-30');
  const postHistory = mergeHistory(first, second);
  const view = { ...v, posts, postHistory, historyIdx: historyIndex(postHistory), historyStatus: historyStatus(postHistory) };
  const report = buildReport(view, { dataset: ds, settings: { basis: 'reach', topMetric: 'er' }, trend: { daily: v.daily, posts, ga4: ds.ga4 } });
  const headings = report.blocks.filter((b) => b.type === 'h').map((b) => b.text);
  assert.ok(headings.includes('指標の推移（月別）'));
  assert.ok(headings.includes('Instagram') && headings.includes('HP流入（GA4）'), '推移はグループごとの表');
  assert.ok(headings.some((h) => h.startsWith('投稿後の伸び')));
  const md = toMarkdown(report);
  assert.match(md, /\| 月 \| フォロワー数 \|/);
  assert.match(md, /アクセス数（セッション数）/);
  assert.match(md, /いいねの増加/);
  assert.match(md, /\| \+5 \|/);
  const list = report.blocks.find((b) => b.type === 'table' && b.head.includes('プロフ遷移'));
  assert.ok(list, '全投稿一覧にプロフ遷移の列');
  assert.ok(list.head.includes('平均再生（秒）') && list.head.includes('検索表示') && list.head.includes('検索順位'));
  assert.ok(list.rows.some((r) => r.includes('8.3位')));
  // Word にも同じ内容が入る
  const { toDocx } = await import('../public/js/docx.js');
  assert.ok(toDocx(report, new Date('2026-10-01T09:00:00')).length > 0);
});

test('記録が1回分しか無ければ「投稿後の伸び」を出さない', () => {
  const { ds, v } = fixture();
  const report = buildReport({ ...v, postHistory: [], historyStatus: { days: 1 } }, { dataset: ds, settings: { basis: 'reach', topMetric: 'er' } });
  assert.ok(!report.blocks.some((b) => b.type === 'h' && b.text.startsWith('投稿後の伸び')));
});
