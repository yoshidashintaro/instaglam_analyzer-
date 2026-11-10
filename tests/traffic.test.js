// GA4 流入と Instagram 投稿の突き合わせ・相関
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pearson, spearman, pValue, confidence95, partialCorrelation, differences,
  linearRegression, correlate, ranks, strengthLabel,
} from '../public/js/stats.js';
import { isInstagram, isPaid, accountOf, readGA4Table, mergeGA4, propertyFromFileName, primaryRows, campaignRows, isOrganicSearch, isSearchAd, readChannelTable, channelKey, mergeGA4Channels } from '../public/js/data/ga4.js';
import { excelSerialToDateKey } from '../public/js/data/xlsx.js';
import {
  weekStart, weeklyTraffic, weeklyInstagram, joinWeeks, correlationTable,
  laggedCorrelation, landingRate, trafficBreakdown, scatterData, trafficInsights, hpSummary, describeEstimate, weeklySearch, mergeTargetWeeks, availableTargets, reachToSiteRate, TARGETS, joinActions, availableActionTargets, ACTION_TARGETS, ACTION_DRIVERS, weeklyChannels } from '../public/js/traffic.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

// ---------- 統計 ----------

test('pearson: 教科書どおりの値になる', () => {
  close(pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]), 1);
  close(pearson([1, 2, 3, 4, 5], [10, 8, 6, 4, 2]), -1);
  close(pearson([1, 2, 3, 4, 5], [2, 1, 4, 3, 5]), 0.8, 1e-12);
  assert.equal(pearson([1, 1, 1], [1, 2, 3]), null, '分散0は null');
  assert.equal(pearson([1, 2], [1, 2]), null, 'n<3 は null');
});

test('spearman: 順位でみるので外れ値に強い', () => {
  // 単調増加なら値がゆがんでいても 1
  close(spearman([1, 2, 3, 4, 5], [1, 2, 3, 4, 1000]), 1);
  close(pearson([1, 2, 3, 4, 5], [1, 2, 3, 4, 1000]), 0.7088767522789017, 1e-12);
  assert.deepEqual(ranks([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
});

test('pValue: 閉じた式で検算できる自由度と一致する', () => {
  const t = (r, n) => Math.abs(r) * Math.sqrt((n - 2) / (1 - r * r));
  // 自由度1: p = 1 - (2/π)arctan(t)
  close(pValue(0.5, 3), 1 - (2 / Math.PI) * Math.atan(t(0.5, 3)), 1e-8);
  // 自由度2: p = 1 - t/√(2+t²)
  close(pValue(0.5, 4), 1 - t(0.5, 4) / Math.sqrt(2 + t(0.5, 4) ** 2), 1e-8);
  close(pValue(0.9, 4), 1 - t(0.9, 4) / Math.sqrt(2 + t(0.9, 4) ** 2), 1e-8);
  close(pValue(0, 10), 1, 1e-9);
  // 12週・r=0.58 でぎりぎり有意になる
  assert.ok(pValue(0.58, 12) < 0.05);
  assert.ok(pValue(0.5, 12) > 0.05);
});

test('confidence95: データが少ないほど区間が広い', () => {
  const [lo1, hi1] = confidence95(0.6, 12);
  const [lo2, hi2] = confidence95(0.6, 100);
  assert.ok(hi1 - lo1 > hi2 - lo2);
  assert.ok(lo1 < 0.6 && hi1 > 0.6);
  assert.equal(confidence95(0.6, 3), null);
});

test('partialCorrelation: 見かけの相関を打ち消せる', () => {
  // x も y も t が増えるだけで動く（実際には無関係）
  const t = [0, 1, 2, 3, 4, 5, 6, 7];
  const x = t.map((v) => v * 2 + 1);
  const y = t.map((v) => v * 3 + 5);
  close(pearson(x, y), 1);
  const p = partialCorrelation(x, y, t);
  assert.ok(Number.isNaN(p) || Math.abs(p) < 1e-6 || p === null, `完全な共線なら偏相関は定義できない: ${p}`);
});

test('differences / linearRegression', () => {
  assert.deepEqual(differences([1, 3, 6, 10]), [2, 3, 4]);
  const fit = linearRegression([0, 1, 2, 3], [1, 3, 5, 7]);
  close(fit.slope, 2);
  close(fit.intercept, 1);
});

test('correlate: まとめて返す', () => {
  const x = [1, 2, 3, 4, 5, 6, 7, 8];
  const y = [2, 1, 4, 3, 6, 5, 8, 7];
  const c = correlate(x, y, { trend: x });
  close(c.r, pearson(x, y));
  assert.equal(c.n, 8);
  assert.ok(c.significant);
  assert.equal(c.strength, strengthLabel(c.r));
  assert.ok(c.ci[0] < c.r && c.ci[1] > c.r);
});

// ---------- GA4 ----------

test('isInstagram / isPaid: 参照元の表記ゆれを吸収する', () => {
  for (const s of ['instagram / instaprofile', 'ig / social', 'l.instagram.com / referral', 'web_instagram_okudate / social', 'instagram_artmake / (not set)']) {
    assert.ok(isInstagram(s), s);
  }
  for (const s of ['google / organic', '(direct) / (none)', 'yahoo / cpc', '（Instagram以外の合計）']) {
    assert.ok(!isInstagram(s), s);
  }
  assert.ok(isPaid('ig / paid'));
  assert.ok(isPaid('instagram / cpc'));
  assert.ok(!isPaid('instagram / social'));
  assert.ok(!isPaid('instagram / instaprofile'));
});

test('accountOf: 参照元からアカウントを振り分ける', () => {
  assert.equal(accountOf('web_instagram_okudate / social', { fallback: 'main' }), 'dr.okudate_miselclinic');
  assert.equal(accountOf('instagram_artmake / instaprofile', { fallback: 'main' }), 'instagram_artmake');
  assert.equal(accountOf('instagram / instaprofile', { fallback: 'main' }), 'main');
  assert.equal(accountOf('ig / paid', { fallback: 'main' }), '(広告)');
});

test('excelSerialToDateKey: Excel のシリアル値を日付にする', () => {
  assert.equal(excelSerialToDateKey(46195), '2026-06-22');
  assert.equal(excelSerialToDateKey(46021), '2025-12-30');
  assert.equal(excelSerialToDateKey(0), null);
  // Excel の1900年うるう年バグの範囲（シリアル60以下）は1日ずれるが、実データには現れない
  assert.equal(excelSerialToDateKey(61), '1900-03-01');
});

test('readGA4Table: 説明行があってもヘッダーを見つける', () => {
  const rows = [
    ['Instagram流入分析'],
    [],
    ['日付', '参照元/メディア', 'セッション', 'エンゲージのあったセッション', 'ユーザー', '新規ユーザー', '予約タップ', 'CV', 'Instagram判定'],
    [46195, 'instagram / instaprofile', 19, 19, 18, 17, 2, 0, 1],
    [46195, 'google / organic', 500, 400, 450, 100, 0, 12, 0],
  ];
  const t = readGA4Table(rows);
  assert.equal(t.headerIdx, 2);
  assert.equal(t.rows.length, 2);
  assert.deepEqual(t.rows[0], {
    date: '2026-06-22', sourceMedium: 'instagram / instaprofile', level: 'source', campaign: null, content: null,
    sessions: 19, engagedSessions: 19, users: 18, newUsers: 17, pageViews: null, reserveTaps: 2, cv: 0,
  });
  assert.equal(readGA4Table([['a', 'b'], [1, 2]]), null);
});

test('readGA4Table: 英語ヘッダーと YYYYMMDD 形式', () => {
  const t = readGA4Table([
    ['Date', 'Session source / medium', 'Sessions', 'Total users', 'New users', 'Conversions'],
    ['20260901', 'instagram / referral', '1,234', '1,000', '800', '5'],
  ]);
  assert.equal(t.rows[0].date, '2026-09-01');
  assert.equal(t.rows[0].sessions, 1234);
  assert.equal(t.rows[0].cv, 5);
});

test('mergeGA4 / propertyFromFileName', () => {
  const a = [{ property: 'p', date: '2026-09-01', sourceMedium: 'instagram / x', sessions: 1 }];
  const b = [{ property: 'p', date: '2026-09-01', sourceMedium: 'instagram / x', sessions: 9 }];
  assert.equal(mergeGA4(a, b).length, 1);
  assert.equal(mergeGA4(a, b)[0].sessions, 9);
  assert.equal(propertyFromFileName('Instagram流入分析_miselcl_過去90日.xlsx'), 'miselcl');
});

// ---------- 突き合わせ ----------

test('weekStart: 月曜始まり', () => {
  assert.equal(weekStart('2026-09-24'), '2026-09-21'); // 木 → 月
  assert.equal(weekStart('2026-09-21'), '2026-09-21'); // 月 → そのまま
  assert.equal(weekStart('2026-09-20'), '2026-09-14'); // 日 → 前の月
});

test('weeklyTraffic: 広告とオーガニックを分け、アカウント別にも集計する', () => {
  const rows = [
    { date: '2026-09-21', sourceMedium: 'instagram / instaprofile', sessions: 100, users: 90, newUsers: 80, engagedSessions: 70, reserveTaps: 5, cv: 0 },
    { date: '2026-09-23', sourceMedium: 'ig / paid', sessions: 200, users: 190, newUsers: 180, engagedSessions: 60, reserveTaps: 1, cv: 0 },
    { date: '2026-09-22', sourceMedium: 'web_instagram_okudate / social', sessions: 30, users: 28, newUsers: 25, engagedSessions: 20, reserveTaps: 2, cv: 1 },
    { date: '2026-09-22', sourceMedium: 'google / organic', sessions: 999, users: 900, newUsers: 800, engagedSessions: 700, reserveTaps: 0, cv: 50 },
  ];
  const [w] = weeklyTraffic(rows, { fallbackAccount: 'main' });
  assert.equal(w.week, '2026-09-21');
  assert.equal(w.sessions, 330, 'Instagram 以外は除外');
  assert.equal(w.paid, 200);
  assert.equal(w.organic, 130);
  assert.equal(w.organicTaps, 7);
  assert.equal(w.paidTaps, 1);
  assert.equal(w.cv, 1);
  assert.equal(w.byAccount.main, 100);
  assert.equal(w.byAccount['dr.okudate_miselclinic'], 30);
  assert.equal(w.byAccount['(広告)'], 200);
});

test('weeklyInstagram: 投稿と日次指標を同じ週にまとめる', () => {
  const posts = [
    { dateKey: '2026-09-21', timestamp: '2026-09-21T00:00:00Z', type: 'REELS', account: 'a', reach: 100, views: 200, saves: 3, shares: 1, follows: 2, likes: 10, comments: 1, interactions: 15 },
    { dateKey: '2026-09-24', timestamp: '2026-09-24T00:00:00Z', type: 'CAROUSEL', account: 'a', reach: 50, views: 60, saves: 1, shares: 0, follows: 0, likes: 5, comments: 0, interactions: 6 },
  ];
  const daily = [
    { date: '2026-09-21', reach: 1000, views: 2000, profileVisits: 50, linkClicks: 40 },
    { date: '2026-09-22', reach: 1100, views: 2100, profileVisits: 60, linkClicks: 45 },
  ];
  const [w] = weeklyInstagram(posts, daily);
  assert.equal(w.posts, 2);
  assert.equal(w.reels, 1);
  assert.equal(w.carousels, 1);
  assert.equal(w.reach, 150);
  assert.equal(w.interactions, 21);
  assert.equal(w.linkClicks, 85);
  assert.equal(w.profileVisits, 110);
  assert.equal(w.byAccount.a.posts, 2);
});

test('joinWeeks: 両方ある週だけ、端の欠けた週は落とす', () => {
  const ig = ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'].map((week) => ({ week, posts: 1 }));
  const ga = ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'].map((week) => ({ week, organic: 10 }));
  assert.deepEqual(joinWeeks(ig, ga).map((r) => r.week), ['2026-09-14', '2026-09-21']);
  assert.equal(joinWeeks(ig, ga, { dropPartial: false }).length, 4);
});

test('correlationTable: 投稿数と流入の関係を出す', () => {
  const joined = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({
    week: `w${i}`,
    ig: { posts: i, reach: 100, reels: 0, views: 0, interactions: 0, saves: 0, linkClicks: 0, profileVisits: 0 },
    ga: { organic: i * 10 + 5 },
  }));
  const t = correlationTable(joined);
  const posts = t.find((x) => x.key === 'posts');
  close(posts.r, 1);
  assert.equal(posts.n, 8);
  // 常に同じ値の指標は相関を出さない
  assert.ok(!t.some((x) => x.key === 'reach'));
});

test('landingRate: リンククリックに対する到達率', () => {
  const joined = [
    { week: 'a', ig: { linkClicks: 100 }, ga: { organic: 20, byAccount: { main: 15 } } },
    { week: 'b', ig: { linkClicks: 100 }, ga: { organic: 30, byAccount: { main: 25 } } },
  ];
  assert.equal(landingRate(joined).rate, 25);
  assert.equal(landingRate(joined, { account: 'main' }).rate, 20);
  assert.equal(landingRate([{ week: 'a', ig: {}, ga: {} }]), null);
});

test('trafficBreakdown: 合計と内訳', () => {
  const weeks = weeklyTraffic([
    { date: '2026-09-21', sourceMedium: 'instagram / instaprofile', sessions: 100, reserveTaps: 6 },
    { date: '2026-09-21', sourceMedium: 'ig / paid', sessions: 200, reserveTaps: 1 },
  ], { fallbackAccount: 'main' });
  const b = trafficBreakdown(weeks, { fallbackAccount: 'main' });
  assert.equal(b.totals.sessions, 300);
  close(b.organicTapRate, 6);
  close(b.paidTapRate, 0.5);
  assert.equal(b.accounts[0].name, '(広告)');
});

test('scatterData: 点と回帰直線', () => {
  const joined = [1, 2, 3].map((i) => ({ week: `w${i}`, ig: { posts: i }, ga: { organic: i * 2 } }));
  const s = scatterData(joined, 'posts', 'organic');
  assert.equal(s.points.length, 3);
  close(s.fit.slope, 2);
});

test('trafficInsights: 到達率が低いと警告を出す', () => {
  const joined = [
    { week: 'a', ig: { linkClicks: 1000, posts: 3 }, ga: { organic: 100, byAccount: {} } },
    { week: 'b', ig: { linkClicks: 1000, posts: 3 }, ga: { organic: 120, byAccount: {} } },
  ];
  const out = trafficInsights({
    table: [], lagged: [], joined,
    breakdown: { totals: { sessions: 1000, paid: 500, organic: 500, organicTaps: 30, paidTaps: 2 }, accounts: [], organicTapRate: 6, paidTapRate: 0.4 },
    landing: landingRate(joined),
  });
  assert.ok(out.some((i) => i.title.includes('HP に到達')));
  assert.ok(out.some((i) => i.title.includes('広告経由')));
  assert.ok(out.some((i) => i.level === 'warn'));
});

test('primaryRows: 参照元別とキャンペーン別が混ざっても二重計上しない', () => {
  const sourceTable = readGA4Table([
    ['日付', '参照元/メディア', 'セッション'],
    ['2026-09-21', 'instagram / instaprofile', 100],
  ]);
  const campaignTable = readGA4Table([
    ['日付', '参照元/メディア', 'キャンペーン', 'セッション'],
    ['2026-09-21', 'instagram / instaprofile', 'summer', 60],
    ['2026-09-21', 'instagram / instaprofile', 'mole', 40],
  ]);
  assert.equal(sourceTable.level, 'source');
  assert.equal(campaignTable.level, 'campaign');

  const all = [...sourceTable.rows, ...campaignTable.rows];
  // そのまま足すと 200 になってしまう
  assert.equal(all.reduce((s, r) => s + r.sessions, 0), 200);
  // 粗いほうだけを使えば 100
  assert.equal(primaryRows(all).reduce((s, r) => s + r.sessions, 0), 100);
  assert.equal(campaignRows(all).length, 2);
  // 参照元別が無ければキャンペーン別を使う
  assert.equal(primaryRows(campaignTable.rows).length, 2);
});

test('readGA4Table: 表示回数（PV）の列を読む', () => {
  const t = readGA4Table([
    ['日付', 'セッションの参照元/メディア', 'セッション', 'ユーザー', '表示回数', 'キーイベント'],
    ['2026/09/01', 'instagram / social', '10', '8', '25', '1'],
  ]);
  assert.equal(t.rows[0].pageViews, 25);
  assert.equal(t.rows[0].users, 8);
});

test('hpSummary: Instagram からの UU・PV・CV・CVR を期間で合計する', () => {
  const rows = [
    { date: '2026-09-01', sourceMedium: 'instagram / social', level: 'source', sessions: 100, users: 80, pageViews: 250, cv: 4 },
    { date: '2026-09-02', sourceMedium: 'instagram / paid', level: 'source', sessions: 50, users: 45, pageViews: 60, cv: 1 },
    { date: '2026-09-02', sourceMedium: 'google / organic', level: 'source', sessions: 999, users: 999, pageViews: 999, cv: 99 },
    // キャンペーン別は参照元別と二重になるので数えない
    { date: '2026-09-02', sourceMedium: 'instagram / social', level: 'campaign', campaign: 'x', sessions: 30, users: 30, pageViews: 30, cv: 3 },
    // 期間外
    { date: '2026-09-10', sourceMedium: 'instagram / social', level: 'source', sessions: 7, users: 7, pageViews: 7, cv: 7 },
  ];
  const s = hpSummary(rows, '2026-09-01', '2026-09-07');
  assert.equal(s.users, 125);
  assert.equal(s.pageViews, 310);
  assert.equal(s.sessions, 150);
  assert.equal(s.paidSessions, 50);
  assert.equal(s.cv, 5);
  assert.equal(s.newUsers, null); // 列が無い
  assert.equal(s.newUserRate, null);
  assert.ok(Math.abs(s.cvr - (5 / 150) * 100) < 1e-9);

  // 列が無い指標は null、期間内に流入が無ければ null
  const noCols = hpSummary([{ date: '2026-09-01', sourceMedium: 'instagram', sessions: 10, users: null, pageViews: null, cv: null }], '2026-09-01', '2026-09-01');
  assert.equal(noCols.pageViews, null);
  assert.equal(noCols.cvr, null);
  assert.equal(hpSummary(rows, '2026-10-01', '2026-10-31'), null);
});

test('hpSummary: 新規率とエンゲージメント率', () => {
  const s = hpSummary([
    { date: '2026-09-01', sourceMedium: 'instagram / social', level: 'source', sessions: 100, users: 80, newUsers: 60, engagedSessions: 70, cv: 2 },
    { date: '2026-09-02', sourceMedium: 'instagram / social', level: 'source', sessions: 100, users: 120, newUsers: 40, engagedSessions: 50, cv: 0 },
  ], '2026-09-01', '2026-09-30');
  assert.equal(s.newUsers, 100);
  assert.equal(s.newUserRate, 50);
  assert.equal(s.engagedSessions, 120);
  assert.equal(s.engagementRate, 60);
  assert.equal(s.cvr, 1);
});

test('correlationTable / describeEstimate: 回帰の傾きから推定の獲得数を出す', () => {
  // 投稿 1件で流入が 10 セッション増える関係
  const joined = [1, 2, 3, 4, 5, 6].map((n, i) => ({ week: `w${i}`, ig: { posts: n, reach: n * 1000 }, ga: { organic: 20 + n * 10 } }));
  const table = correlationTable(joined, { target: 'organic' });
  const posts = table.find((c) => c.key === 'posts');
  assert.ok(Math.abs(posts.estimate - 10) < 1e-9);
  assert.equal(describeEstimate(posts, 'organic'), '+1件あたり 約 +10セッション');
  const reach = table.find((c) => c.key === 'reach');
  assert.equal(describeEstimate(reach, 'organic'), '+1,000リーチあたり 約 +10セッション');
  assert.equal(describeEstimate({ ...posts, estimate: -0.42, significant: false }, 'organicTaps'), '+1件あたり 約 −0.4予約タップ（参考）');
  assert.equal(describeEstimate({ estimate: null }, 'organic'), '–');
});

// ---------- Search Console を相関の相手に加える ----------

test('weeklySearch: 日次を週にまとめ、掲載順位は表示回数で重み付けする', () => {
  const rows = weeklySearch([
    // 2026-10-05 は月曜
    { date: '2026-10-05', clicks: 10, impressions: 1000, position: 2 },
    { date: '2026-10-06', clicks: 5, impressions: 1000, position: 4 },
    { date: '2026-10-12', clicks: 7, impressions: 500, position: 9 },
  ]);
  assert.deepEqual(rows.map((r) => r.week), ['2026-10-05', '2026-10-12']);
  assert.equal(rows[0].searchClicks, 15);
  assert.equal(rows[0].searchImpressions, 2000);
  assert.equal(rows[0].searchPosition, 3, '(2*1000 + 4*1000) / 2000');
  assert.equal(rows[0].searchDays, 2);
});

test('weeklySearch: 掲載順位が無い日があっても落ちない', () => {
  const rows = weeklySearch([
    { date: '2026-10-05', clicks: 1, impressions: 100, position: null },
    { date: '2026-10-06', clicks: 1, impressions: 0, position: 5 },
  ]);
  assert.equal(rows[0].searchPosition, null);
  assert.equal(rows[0].searchClicks, 2);
});

test('mergeTargetWeeks: GA4 と Search Console を週の和集合でまとめる', () => {
  const ga = [{ week: '2026-10-05', organic: 100 }, { week: '2026-10-12', organic: 120 }];
  const sc = [{ week: '2026-10-12', searchClicks: 7 }, { week: '2026-10-19', searchClicks: 9 }];
  const merged = mergeTargetWeeks(ga, sc);
  assert.deepEqual(merged.map((w) => w.week), ['2026-10-05', '2026-10-12', '2026-10-19']);
  assert.equal(merged[1].organic, 120);
  assert.equal(merged[1].searchClicks, 7, '同じ週は 1 行にまとまる');
  assert.equal(merged[2].organic, undefined, 'GA4 の無い週は検索だけ');
  // 片方しか無くても使える
  assert.equal(mergeTargetWeeks([], sc).length, 2);
  assert.equal(mergeTargetWeeks(ga, []).length, 2);
});

test('availableTargets: 取り込んでいるデータで選べる相手だけを返す', () => {
  // 既存の相手はそのまま残し、指名キーワードを足した一覧
  assert.deepEqual(TARGETS.map((t) => t.key), ['organic', 'sessions', 'searchOrganic', 'searchAds', 'organicTaps', 'searchImpressions', 'brandedClicks']);
  // Google 検索からのクリックだけを外した
  assert.ok(!TARGETS.some((t) => t.key === 'searchClicks'), 'searchClicks は相手に出さない');
  assert.deepEqual(availableTargets([{ week: 'w', organic: 1, sessions: 2 }]).map((t) => t.key), ['organic', 'sessions']);
  assert.deepEqual(availableTargets([{ week: 'w', searchImpressions: 9 }]).map((t) => t.key), ['searchImpressions']);
  assert.deepEqual(availableTargets([{ week: 'w', brandedClicks: 3 }]).map((t) => t.key), ['brandedClicks']);
  assert.deepEqual(availableTargets([]), []);
});

test('correlationTable: 指名キーワードでも相関を出せる', () => {
  const joined = [
    { week: 'w1', ig: { posts: 1, reach: 100 }, ga: { brandedClicks: 10 } },
    { week: 'w2', ig: { posts: 3, reach: 300 }, ga: { brandedClicks: 30 } },
    { week: 'w3', ig: { posts: 2, reach: 200 }, ga: { brandedClicks: 20 } },
    { week: 'w4', ig: { posts: 4, reach: 400 }, ga: { brandedClicks: 40 } },
  ];
  const table = correlationTable(joined, { target: 'brandedClicks' });
  const posts = table.find((r) => r.key === 'posts');
  assert.ok(posts, '投稿数の行がありません');
  assert.ok(posts.r > 0.99, `きれいな正の相関になるはず: ${posts.r}`);
});

test('landingRate: GA4 の無い週（Search Console だけ）が混ざっても落ちない', () => {
  const joined = [
    { week: '2026-10-05', ig: { linkClicks: 100 }, ga: { organic: 40, byAccount: { a: 40 } } },
    { week: '2026-10-12', ig: { linkClicks: 80 }, ga: { searchClicks: 7 } }, // Search Console だけの週
  ];
  const r = landingRate(joined, { account: 'a' });
  assert.equal(r.weeks, 1, 'GA4 のある週だけで計算する');
  assert.equal(r.clicks, 100);
  assert.equal(r.sessions, 40);
  // アカウント指定なしでも落ちない
  assert.equal(landingRate(joined).weeks, 1);
  // GA4 が1週も無ければ null
  assert.equal(landingRate([joined[1]]), null);
});

test('reachToSiteRate: 認知（フォロワー以外へのリーチ）に対する流入を、そろう週だけで出す', () => {
  const joined = [
    { week: '2026-10-05', ig: { accountNonFollowerReach: 30000, linkClicks: 1000 }, ga: { organic: 150, byAccount: { a: 150 } } },
    { week: '2026-10-12', ig: { accountNonFollowerReach: 30000, linkClicks: 1019 }, ga: { organic: 181, byAccount: { a: 181 } } },
    // GA4 の無い週は使わない
    { week: '2026-10-19', ig: { accountNonFollowerReach: 25000, linkClicks: 800 }, ga: { searchClicks: 5 } },
    // リーチの無い週も使わない
    { week: '2026-10-26', ig: { accountNonFollowerReach: null, linkClicks: 500 }, ga: { organic: 99, byAccount: { a: 99 } } },
  ];
  const r = reachToSiteRate(joined);
  assert.equal(r.weeks, 2);
  assert.equal(r.reach, 60000);
  assert.equal(r.sessions, 331);
  assert.equal(r.clicks, 2019, 'リンククリックも同じ週ぶんを返す（補足表示に使う）');
  assert.equal(r.rate, (331 / 60000) * 100);
  // アカウントを指定すればそのアカウントぶんだけ
  assert.equal(reachToSiteRate(joined, { account: 'a' }).sessions, 331);
  assert.equal(reachToSiteRate(joined, { account: 'b' }).sessions, 0);
  // includePaid: 広告からの流入も足す（リーチが広告込みなので、そろえる）
  const paidJoined = joined.map((r) => ({ ...r, ga: { ...r.ga, paid: 10 } }));
  const withAds = reachToSiteRate(paidJoined, { account: 'a', includePaid: true });
  assert.equal(withAds.organic, 331);
  assert.equal(withAds.paid, 10 * withAds.weeks);
  assert.equal(withAds.sessions, 331 + 10 * withAds.weeks);
  assert.equal(reachToSiteRate(paidJoined, { account: 'a' }).sessions, 331, '既定では広告を足さない');
  // 重なる週が無ければ null
  assert.equal(reachToSiteRate([joined[2]]), null);
  assert.equal(reachToSiteRate([]), null);
});

test('weeklyInstagram: フォロワー以外へのリーチも週にまとめる', () => {
  const weeks = weeklyInstagram([], [
    { date: '2026-10-05', reach: 100, nonFollowerReach: 80, views: null, profileVisits: null, linkClicks: null },
    { date: '2026-10-06', reach: 120, nonFollowerReach: 90, views: null, profileVisits: null, linkClicks: null },
  ]);
  assert.equal(weeks.length, 1);
  assert.equal(weeks[0].accountNonFollowerReach, 170);
  assert.equal(weeks[0].accountReach, 220);
  // 値が無い日は足さない（0 として薄めない）
  const none = weeklyInstagram([], [{ date: '2026-10-05', reach: 100, nonFollowerReach: null }]);
  assert.equal(none[0].accountNonFollowerReach, null);
});

// ---------- 投稿と行動の相関 ----------

test('joinActions: 投稿側と行動側を同じ週データから組み立てる', () => {
  const igWeeks = [
    { week: 'w1', posts: 1, saves: 10, shares: 2, profileVisits: 100, accountFollows: 5, postFollows: 1 },
    { week: 'w2', posts: 3, saves: 30, shares: 4, profileVisits: 300, accountFollows: 15, postFollows: 3 },
    { week: 'w3', posts: 2, saves: 20, shares: 3, profileVisits: 200, accountFollows: 10, postFollows: 2 },
    { week: 'w4', posts: 4, saves: 40, shares: 5, profileVisits: 400, accountFollows: 20, postFollows: 4 },
  ];
  const rows = joinActions(igWeeks, { dropPartial: false });
  assert.equal(rows.length, 4);
  assert.equal(rows[0].ga.keepActions, 12, '保存＋シェア');
  assert.equal(rows[0].ga.profileVisits, 100);
  assert.equal(rows[0].ga.newFollows, 5, 'アカウント全体の新規フォローを使う');
  // 日次のフォローが無ければ投稿由来のフォローで代用
  const noDaily = joinActions([{ week: 'w1', saves: 1, shares: 1, profileVisits: 10, accountFollows: null, postFollows: 7 }], { dropPartial: false });
  assert.equal(noDaily[0].ga.newFollows, 7);
  // 端の週は既定で落とす（週の一部しかないことがあるため）
  assert.equal(joinActions(igWeeks).length, 2);
});

test('availableActionTargets: データのある行動だけを相手に出す', () => {
  const rows = joinActions([
    { week: 'w1', saves: 10, shares: 0, profileVisits: null, accountFollows: null, postFollows: 0 },
  ], { dropPartial: false });
  assert.deepEqual(availableActionTargets(rows).map((t) => t.key), ['keepActions']);
  assert.deepEqual(availableActionTargets([]), []);
  assert.deepEqual(ACTION_TARGETS.map((t) => t.key), ['accountNonFollowerReach', 'keepActions', 'profileVisits', 'newFollows']);
});

test('correlationTable: 投稿側の指標を差し替えて行動との相関を出せる', () => {
  const igWeeks = [1, 2, 3, 4, 5].map((n, i) => ({
    week: `w${i}`, posts: n, reels: n, carousels: 0, reach: n * 1000, views: n * 2000,
    accountNonFollowerReach: n * 800, saves: n * 10, shares: n * 2, profileVisits: n * 100, accountFollows: n * 5, postFollows: n,
  }));
  const rows = joinActions(igWeeks, { dropPartial: false });
  const table = correlationTable(rows, { target: 'keepActions', drivers: ACTION_DRIVERS });
  const posts = table.find((c) => c.key === 'posts');
  assert.ok(posts.r > 0.99, `投稿数と保存＋シェアはきれいな正の相関: ${posts.r}`);
  // 行動側の指標は投稿側に入れない（自分自身との相関にならないように）
  assert.ok(!ACTION_DRIVERS.some((d) => ['saves', 'profileVisits', 'interactions'].includes(d.key)));
  // フォロワー以外へのリーチも投稿側で選べる
  assert.ok(table.some((c) => c.key === 'accountNonFollowerReach'));
});

test('weeklySearch: 指名キーワードぶんを割合で按分する', () => {
  const daily = [
    { date: '2026-10-05', clicks: 100, impressions: 1000, position: 3 },
    { date: '2026-10-06', clicks: 200, impressions: 2000, position: 3 },
  ];
  assert.equal(weeklySearch(daily)[0].brandedClicks, null, '割合が無ければ出さない');
  assert.equal(weeklySearch(daily, { brandedShare: 0.25 })[0].brandedClicks, 75, '300クリックの25%');
});

// ---------- Instagram 以外の流入（自然検索・検索広告） ----------

test('isOrganicSearch / isSearchAd: 自然検索と検索広告を見分ける', () => {
  for (const sm of ['google / organic', 'yahoo / organic', 'bing / organic']) {
    assert.equal(isOrganicSearch(sm), true, sm);
    assert.equal(isSearchAd(sm), false, sm);
  }
  for (const sm of ['google / cpc', 'yahoo / cpc', 'google ads / cpc', 'google / paid-search', 'yahoo / Paid Search']) {
    assert.equal(isSearchAd(sm), true, sm);
    assert.equal(isOrganicSearch(sm), false, sm);
  }
  // Instagram と SNS 広告は含めない
  for (const sm of ['ig / paid', 'instagram / cpc', 'l.instagram.com / referral']) {
    assert.equal(isOrganicSearch(sm), false, sm);
    assert.equal(isSearchAd(sm), false, sm);
  }
  // Facebook 広告は「検索広告」ではない
  assert.equal(isSearchAd('facebook / cpc'), false);
  // 直接流入・参照は対象外
  assert.equal(isOrganicSearch('(direct) / (none)'), false);
  assert.equal(isSearchAd('(direct) / (none)'), false);
});

test('weeklyTraffic: Instagram 以外の自然検索・検索広告も週ごとに集計する', () => {
  const rows = [
    { date: '2026-10-05', sourceMedium: 'instagram / social', sessions: 100, reserveTaps: 5 },
    { date: '2026-10-06', sourceMedium: 'google / organic', sessions: 400 },
    { date: '2026-10-07', sourceMedium: 'yahoo / organic', sessions: 200 },
    { date: '2026-10-08', sourceMedium: 'google / cpc', sessions: 300 },
    // 対象外（直接・参照）は数えない
    { date: '2026-10-08', sourceMedium: '(direct) / (none)', sessions: 999 },
    { date: '2026-10-12', sourceMedium: 'google / organic', sessions: 50 },
  ];
  const weeks = weeklyTraffic(rows, { fallbackAccount: 'a' });
  assert.deepEqual(weeks.map((w) => w.week), ['2026-10-05', '2026-10-12']);
  assert.equal(weeks[0].searchOrganic, 600, '自然検索は google と yahoo の合計');
  assert.equal(weeks[0].searchAds, 300);
  assert.equal(weeks[0].organic, 100, 'Instagram の集計は今までどおり');
  assert.equal(weeks[1].searchOrganic, 50);
  assert.equal(weeks[1].searchAds, null, 'その週に無ければ null（0 と区別する）');
  // Instagram の無い週も作られる（相関の相手として使えるように）
  assert.equal(weeks[1].sessions, 0);
});

test('availableTargets: 自然検索・検索広告もデータがあれば選べる', () => {
  assert.deepEqual(availableTargets([{ week: 'w', searchOrganic: 100 }]).map((t) => t.key), ['searchOrganic']);
  assert.deepEqual(availableTargets([{ week: 'w', searchAds: 50 }]).map((t) => t.key), ['searchAds']);
  // ラベルがご指定の表記になっている
  const label = (k) => TARGETS.find((t) => t.key === k).label;
  assert.equal(label('organic'), 'HPへの流入（Instagram／オーガニック）');
  assert.equal(label('sessions'), 'HPへの流入（Instagram／広告含む）');
  assert.equal(label('searchOrganic'), 'HPへの流入（オーガニック）');
  assert.equal(label('searchAds'), 'HPへの流入（検索広告）');
});

test('readChannelTable / weeklyChannels: チャネル別の表から自然検索・検索広告を取り出す', () => {
  const sheet = [
    ['週開始', 'チャネル', '総ユーザー', '新規ユーザー', 'セッション', 'エンゲージのあったセッション', '予約タップ', 'CV'],
    ['2026-07-20', 'Organic Search', 1396, 1275, 1602, 1168, 102, 0],
    ['2026-07-20', 'Paid Search', 50, 40, 60, 30, 2, 1],
    ['2026-07-20', 'Organic Social', 919, 493, 1309, 873, 23, 107],
    ['2026-07-27', 'Organic Search', 1200, 1000, 1400, 1000, 90, 0],
  ];
  const table = readChannelTable(sheet);
  assert.equal(table.rows.length, 4);
  assert.deepEqual(table.rows.map((r) => r.key), ['searchOrganic', 'searchAds', null, 'searchOrganic']);
  assert.equal(table.rows[0].sessions, 1602);
  assert.equal(table.rows[0].reserveTaps, 102);

  const weeks = weeklyChannels(table.rows);
  assert.deepEqual(weeks.map((w) => w.week), ['2026-07-20', '2026-07-27']);
  assert.equal(weeks[0].searchOrganic, 1602);
  assert.equal(weeks[0].searchAds, 60);
  assert.equal(weeks[1].searchAds, undefined, 'その週に無ければ項目ごと作らない');
  // 期間で絞れる
  assert.equal(weeklyChannels(table.rows, { from: '2026-07-27' }).length, 1);
  // チャネル以外の表は読まない
  assert.equal(readChannelTable([['日付', '参照元/メディア', 'セッション'], ['2026-07-20', 'google / organic', 10]]), null);
});

test('channelKey: GA4 のチャネル名を表記ゆれごと受ける', () => {
  assert.equal(channelKey('Organic Search'), 'searchOrganic');
  assert.equal(channelKey('organic search'), 'searchOrganic');
  assert.equal(channelKey('Paid Search'), 'searchAds');
  assert.equal(channelKey('自然検索'), 'searchOrganic');
  assert.equal(channelKey('検索広告'), 'searchAds');
  // 対象外のチャネルは null（相関の相手にしない）
  for (const c of ['Organic Social', 'Display', 'Direct', 'Referral', 'Paid Social']) assert.equal(channelKey(c), null, c);
});

test('mergeTargetWeeks: 値の無い項目で、すでに入っている値を消さない', () => {
  const ga = [{ week: 'w1', organic: 100, searchOrganic: 500 }];
  const sc = [{ week: 'w1', searchClicks: 10, searchOrganic: null, brandedClicks: null }];
  const merged = mergeTargetWeeks(ga, sc);
  assert.equal(merged[0].searchOrganic, 500, 'null で上書きされない');
  assert.equal(merged[0].searchClicks, 10);
  assert.equal(merged[0].organic, 100);
  // もともと無い項目は null のまま入る（データなしと分かるように）
  assert.equal(merged[0].brandedClicks, null);
});

test('mergeGA4Channels: 同じプロパティ・週・チャネルは新しい方で上書き', () => {
  const a = [{ property: 'p', date: '2026-07-20', channel: 'Organic Search', sessions: 100 }];
  const b = [
    { property: 'p', date: '2026-07-20', channel: 'Organic Search', sessions: 150 },
    { property: 'p', date: '2026-07-20', channel: 'Paid Search', sessions: 20 },
  ];
  const merged = mergeGA4Channels(a, b);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((r) => r.channel === 'Organic Search').sessions, 150);
});

test('ACTION_TARGETS: 非フォロワーへのリーチも行動側の相手にできる', () => {
  assert.deepEqual(ACTION_TARGETS.map((t) => t.key), ['accountNonFollowerReach', 'keepActions', 'profileVisits', 'newFollows']);
  const rows = joinActions([
    { week: 'w1', accountNonFollowerReach: 1000, saves: 1, shares: 0, profileVisits: 10, accountFollows: 1, postFollows: 0 },
  ], { dropPartial: false });
  assert.equal(rows[0].ga.accountNonFollowerReach, 1000);
  assert.ok(availableActionTargets(rows).some((t) => t.key === 'accountNonFollowerReach'));
});

test('correlationTable: 相手と同じ指標は投稿側から外す（自分自身との相関にしない）', () => {
  const igWeeks = [1, 2, 3, 4, 5].map((n, i) => ({
    week: `w${i}`, posts: n, reels: n, carousels: 0, reach: n * 1000, views: n * 2000,
    accountNonFollowerReach: n * 800, saves: n * 10, shares: n * 2, profileVisits: n * 100, accountFollows: n * 5, postFollows: n,
  }));
  const rows = joinActions(igWeeks, { dropPartial: false });
  const table = correlationTable(rows, { target: 'accountNonFollowerReach', drivers: ACTION_DRIVERS });
  assert.ok(!table.some((c) => c.key === 'accountNonFollowerReach'), '同じ指標が残っている（r=1 になってしまう）');
  assert.ok(table.some((c) => c.key === 'posts'), '他の指標は残る');
  // 別の相手なら、非フォロワーへのリーチは投稿側に残る
  const keep = correlationTable(rows, { target: 'keepActions', drivers: ACTION_DRIVERS });
  assert.ok(keep.some((c) => c.key === 'accountNonFollowerReach'));
});
