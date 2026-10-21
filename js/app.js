import {
  WEEKDAYS, TYPE_LABELS, TYPE_ORDER, METRICS,
  normalizeDaily, normalizePost, enrichPosts, periodBounds, slice, addDays,
  summarize, weeklyER, byType, topPosts, timeHeatmap, groupByKey, bestSlots,
  hashtagStats, generateInsights, parseDateKey, formatJST, jstParts,
  anchorFollowers, detectFollowerMode, funnel, audienceSummary, accountsOf, byAccount,
} from './analytics.js';
import * as charts from './charts.js';
import { fmtInt, fmtPct, fmtCompact } from './charts.js';
import { generateDemo } from './data/demo.js';
import { importCSV, toCSV, decodeCSV, describeImport, parseCSV, looksGarbled, mergeContentFormats } from './data/csv.js';
import { readWorkbook, isXlsxName } from './data/xlsx.js';
import { importGA4Workbook, readGA4Table, mergeGA4, mergeGA4Channels, propertyFromFileName, primaryRows, campaignRows, isInstagram } from './data/ga4.js';
import {
  weeklyTraffic, weeklyInstagram, joinWeeks, correlationTable, laggedCorrelation,
  landingRate, trafficBreakdown, scatterData, trafficInsights, weekStart, hpSummary, describeEstimate, DRIVERS, TARGETS,
  weeklySearch, mergeTargetWeeks, availableTargets, reachToSiteRate, weeklyChannels,
  ACTION_DRIVERS, ACTION_TARGETS, joinActions, availableActionTargets,
} from './traffic.js';
import { GraphClient, fetchFromGraph } from './data/graphApi.js';
import { buildReport, toMarkdown, readCorrelation } from './report.js';
import { toDocx, DOCX_MIME } from './docx.js';
import { TREND_METRICS, TREND_UNITS, trendMetric, trendSeries } from './trend.js';
import { sliceStories, summarizeStories, storiesByDate, storiesByHour } from './stories.js';
import {
  sliceByDate, surfaceBreakdown, clickBreakdown, accountTotals,
  hashtagSets, benchmarkSummary, taggedInPeriod,
} from './account.js';
import { readReachBreakdown, mergeReachBreakdown, applyNonFollowerEstimate, describeBreakdowns, breakdownFor, soleAccount } from './data/reachMix.js';
import {
  KPI_DEFS, DAYS_PER_MONTH, kpiValues, kpiRows, kpiByStage, stageFunnel, kpiInsights, periodDays,
} from './kpi.js';
import { readSocialInsight, mergeHashtags, mergeFollowed, mergeSummary, mergeStories, mergeTagged, describeSocialInsight } from './data/socialInsight.js';
import {
  readSearchConsoleZip, readSearchConsoleCSV, mergeSearchConsole, describeSearchConsole,
  instagramProperties, siteProperties, postIndex as searchPostIndex, searchSummary,
  queryRows as searchQueryRows, underperformingQueries, sliceSearchDaily, shortcodeOfUrl, buildProperty,
  defaultBrandTerms, guessBrandTerms, brandedQueries,
} from './data/searchConsole.js';
import {
  HISTORY_METRICS, HISTORY_LABELS, snapshotPosts, mergeHistory, postTimeline,
  historyIndex, historyStatus, pruneHistory, snapshotDate,
} from './postHistory.js';
import * as store from './storage.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const DEFAULTS = {
  days: 90, basis: 'reach', topMetric: 'er', account: '',
  corrTarget: 'organic', scatterDriver: 'posts', trendUnit: 'week', hashtagSet: '',
  sort: { key: 'timestamp', dir: 'desc' },
  // 投稿ごとの推移ダイアログ：表示する指標と、累計／増加の切り替え
  postMetrics: ['likes', 'saves'], postMode: 'total',
  // Search Console：見るプロパティと検索クエリの並べ替え
  searchScope: 'instagram', searchSort: 'clicks',
  // KPI の基準・目標の上書き（{ 指標キー: { baseline, target } }）
  kpiGoals: {},
  // 相関：行動側の指標と、指名キーワードの語
  actionTarget: 'keepActions', brandTerms: [],
};
const state = {
  dataset: store.loadDataset(),
  settings: { ...DEFAULTS, ...store.loadSettings() },
  search: '',
  tableViews: new Set(), // 「表で見る」状態のカード
  view: null, // 直近の集計結果
  // ?trend=指標 で開いたときは、その指標の推移ページを表示する
  trend: trendMetric(new URLSearchParams(location.search).get('trend'))?.key || null,
  openPost: null, // 推移ダイアログで開いている投稿
  kpiEdit: false, // KPI の基準・目標を編集中か
};

function persistSettings() {
  store.saveSettings(state.settings);
}

// ---------- ユーティリティ ----------

function toast(msg, ms = 3200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), ms);
}

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
};

const fmtDate = (key) => key.replaceAll('-', '/');
// フォルダごと選んだときだけ webkitRelativePath が入る。Search Console のプロパティ判別に使う
const folderOf = (file) => String(file?.webkitRelativePath || '').split('/').slice(0, -1).pop() || '';
// 日時は日本時間で表示する（例: 2026-09-30T09:02:09.000Z → 2026/09/30 18:02）
const fmtDateTime = (iso) => formatJST(iso, 'short');
const firstLine = (caption) => caption.split('\n').find((l) => l.trim() && !l.trim().startsWith('#'))?.trim() || '（キャプションなし）';

/** 増減表示。矢印とテキストでも方向がわかるようにする（色だけに頼らない） */
function deltaNode(value, { unit = '', suffix = '', digits = 0, goodWhenUp = true } = {}) {
  if (value === null || value === undefined || !Number.isFinite(value)) return el('span', { textContent: '比較データなし' });
  const up = value > 0;
  const flat = Math.abs(value) < 10 ** -digits / 2;
  const cls = flat ? '' : up === goodWhenUp ? 'up' : 'down';
  const sign = flat ? '±' : up ? '+' : '−';
  const arrow = flat ? '' : up ? '▲ ' : '▼ ';
  const abs = Math.abs(value);
  const body = digits ? abs.toFixed(digits) : Math.round(abs).toLocaleString('ja-JP');
  return el('span', {}, el('span', { className: cls, textContent: `${arrow}${sign}${body}${unit}` }), suffix ? ` ${suffix}` : '');
}

// ---------- テーマ ----------

const media = matchMedia('(prefers-color-scheme: dark)');
function resolveTheme() {
  const explicit = document.documentElement.dataset.theme;
  document.documentElement.dataset.resolvedTheme = explicit || (media.matches ? 'dark' : 'light');
}
function toggleTheme() {
  const next = document.documentElement.dataset.resolvedTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('iia.theme', next);
  } catch {}
  resolveTheme();
  render();
}

// ---------- 集計 ----------

/** 日次・投稿を分析できる形に整える（ダッシュボードと推移ページで共通） */
function baseData() {
  const ds = state.dataset;
  // フォロワー総数の日次データが無くても、オーディエンスの現在値から推移を逆算する
  const rawDaily = normalizeDaily(anchorFollowers(ds.daily || [], ds.audience));
  const current = ds.audience?.followersTotal ?? ds.account?.followersCount ?? rawDaily.findLast((d) => d.followers !== null)?.followers;
  const enriched = enrichPosts((ds.posts || []).map(normalizePost), rawDaily, state.settings.basis, current);

  // 1つのエクスポートに複数アカウントが入っていることがあるので絞り込めるようにする
  const accounts = accountsOf(enriched);
  // 非フォロワーへのリーチの実数が無い投稿・日は、取り込んだリーチ内訳の比率から推定する
  // 日次データ（アカウント全体の数字）の持ち主。投稿に別アカウントが混ざっていても、
  // リーチ内訳が1アカウントぶんだけならそれを優先する（取り違えると推定が走らない）
  const mainAccount = ds.account?.username || soleAccount(ds.reachBreakdown) || accounts[0]?.username || '';
  const est = applyNonFollowerEstimate({ posts: enriched, daily: rawDaily }, ds.reachBreakdown, mainAccount);
  const daily = est.daily;
  const account = accounts.some((a) => a.username === state.settings.account) ? state.settings.account : '';
  // Search Console の投稿データを、投稿 URL の shortcode で突き合わせる
  const searchProps = instagramProperties(ds.searchConsole || [], account);
  const searchIdx = searchPostIndex(searchProps);
  const all = searchIdx.size ? est.posts.map((p) => withSearchMetrics(p, searchIdx)) : est.posts;
  const posts = account ? all.filter((p) => p.account === account) : all;
  return { ds, daily, all, accounts, account, posts, nonFollowerEstimated: est.estimated, searchProps, searchIdx, mainAccount };
}

/** 投稿に Google 検索での表示回数・クリック・掲載順位を付ける（データが無ければ null） */
function withSearchMetrics(p, idx) {
  const s = p.permalink ? idx.get(shortcodeOfUrl(p.permalink)) : null;
  return {
    ...p,
    searchImpressions: s ? s.impressions : null,
    searchClicks: s ? s.clicks : null,
    searchPosition: s ? s.position : null,
  };
}

/** 投稿ごとの推移データ（取り込みのたびに積んだスナップショット） */
function postHistoryRows() {
  return state.dataset?.postHistory || [];
}

function compute() {
  const { days } = state.settings;
  const { ds, daily, all, accounts, account, posts, nonFollowerEstimated, mainAccount } = baseData();
  const followerMode = ds.followerMode || detectFollowerMode(daily);

  const { startKey, endKey } = periodBounds(daily, posts, days || null);
  const cur = slice(daily, posts, startKey, endKey);
  let prev = null;
  if (days) {
    const pEnd = addDays(startKey, -1);
    prev = slice(daily, posts, addDays(pEnd, -(days - 1)), pEnd);
  }

  const summary = summarize(cur.daily, cur.posts);
  const prevSummary = prev && (prev.posts.length || prev.daily.length) ? summarize(prev.daily, prev.posts) : null;
  const types = byType(cur.posts);
  const heatmap = timeHeatmap(cur.posts, { blockHours: 3 });
  const hours = groupByKey(cur.posts, (p) => p.hour, 24);
  const weekdays = groupByKey(cur.posts, (p) => p.weekday, 7);
  const hashtags = hashtagStats(cur.posts);
  const steps = funnel(summary);
  const audience = audienceSummary(ds.audience);
  const accountStats = byAccount(slice(daily, all, startKey, endKey).posts);

  // Google 検索（Search Console）
  const scAll = ds.searchConsole || [];
  const scIg = instagramProperties(scAll, account);
  const scSite = siteProperties(scAll);
  const available = { instagram: scIg.length > 0, site: scSite.length > 0, all: scAll.length > 0 };
  // 選んでいるプロパティ種別にデータが無ければ、ある方へ自動で切り替える
  const scope = available[state.settings.searchScope] ? state.settings.searchScope : available.instagram ? 'instagram' : available.site ? 'site' : 'all';
  const scoped = scope === 'site' ? scSite : scope === 'all' ? [...scIg, ...scSite] : scIg;
  const search = {
    all: scAll, instagram: scIg, site: scSite, scope, scoped, available,
    summary: searchSummary(scoped),
    queries: searchQueryRows(scoped, { sort: state.settings.searchSort }),
    gaps: underperformingQueries(scoped, { limit: 8 }),
    daily: sliceSearchDaily(scoped, startKey, endKey),
    devices: mergeDimension(scoped, 'devices', 'device'),
    filter: scoped.find((p) => p.filter)?.filter || null,
  };

  // 指名キーワード（ブランド名を含む検索語）。相関の相手はサイトのプロパティで見る
  const brandProps = scSite.length ? scSite : scIg;
  const brandTerms = state.settings.brandTerms?.length
    ? state.settings.brandTerms
    : guessBrandTerms(brandProps, defaultBrandTerms(scAll, accounts.map((a) => a.name).filter(Boolean)));
  const branded = brandedQueries(brandProps, brandTerms);
  search.brand = { terms: brandTerms, ...(branded || {}) };

  // GA4（HPへの流入）。期間フィルタは投稿側と揃える
  const traffic = computeTraffic(ds, {
    startKey, endKey, daily, posts: all, accounts, account,
    searchProps: brandProps, brandedShare: branded?.share ?? null,
  });

  // 投稿と行動の相関（どちらも Instagram のデータなので期間のズレは起きない）
  const actionWeeks = joinActions(weeklyInstagram(cur.posts, cur.daily));
  const actionTargets = availableActionTargets(actionWeeks);
  const actionTarget = actionTargets.some((t) => t.key === state.settings.actionTarget)
    ? state.settings.actionTarget
    : actionTargets[0]?.key || 'keepActions';
  const actions = {
    weeks: actionWeeks,
    targets: actionTargets,
    target: actionTarget,
    table: actionWeeks.length >= 3 ? correlationTable(actionWeeks, { target: actionTarget, drivers: ACTION_DRIVERS }) : [],
  };
  // 上部の指標：Instagram から HP への流入（UU・セッション・新規・エンゲージメント率・CV・CVR）。前期間も同じ長さで比べる
  const hp = hpSummary(ds.ga4, startKey, endKey);
  const prevHp = days ? hpSummary(ds.ga4, addDays(startKey, -days), addDays(startKey, -1)) : null;

  // ソーシャルインサイトから取り込んだ追加データ（ストーリーズ・面別の内訳・他アカウント）
  const stories = sliceStories(ds.stories, startKey, endKey);
  const accountRows = sliceByDate(ds.accountDaily, startKey, endKey);
  const si = {
    stories,
    storiesSummary: summarizeStories(stories),
    storiesDaily: storiesByDate(stories),
    storiesHours: storiesByHour(stories),
    surfaces: surfaceBreakdown(accountRows),
    clicks: clickBreakdown(accountRows),
    totals: accountTotals(accountRows),
    hashtagSets: hashtagSets(ds.hashtags),
    followed: ds.followed || [],
    benchmark: benchmarkSummary(ds.followed),
    tagged: taggedInPeriod(ds.tagged, startKey, endKey),
  };

  const insights = generateInsights({
    summary, prevSummary, types, heatmap, hours, hashtags, posts: cur.posts,
    steps, audience, accounts: account ? [] : accountStats, si, search,
    formats: ds.contentFormats || null,
  });

  // KPI ツリー（運用で決めた定義・基準・目標に対する進捗）
  const periodLength = periodDays(startKey, endKey);
  // 期間の終わりに当たるリーチ内訳（オーガニック／広告の実数が入っていれば使う）
  const reachRow = breakdownFor(ds.reachBreakdown, account || mainAccount, endKey);
  const kpiInput = { summary, posts: cur.posts, daily: cur.daily, traffic, si, reach: reachRow };
  const kpi = {
    days: periodLength,
    values: kpiValues(kpiInput),
    funnel: stageFunnel(kpiInput),
    rows: [],
  };
  kpi.rows = kpiRows(kpi.values, periodLength, state.settings.kpiGoals);
  // 目標に対する進捗は最初に読んでほしいので、自動分析レポートの先頭に置く
  insights.unshift(...kpiInsights(kpi.rows, { days: periodLength }));

  const postHistory = postHistoryRows();
  return {
    startKey, endKey, daily: cur.daily, posts: cur.posts, summary, prevSummary,
    types, heatmap, hours, weekdays, hashtags, insights,
    steps, audience, accounts, accountStats, account, followerMode, traffic, hp, prevHp, nonFollowerEstimated, si,
    all, postHistory, historyIdx: historyIndex(postHistory), historyStatus: historyStatus(postHistory), search,
    formats: ds.contentFormats || null, kpi, actions,
  };
}

/**
 * GA4 の流入を週単位で投稿データと突き合わせる。
 * 相関は週数がある程度ないと意味を持たないので、3週未満なら null を返して画面ごと隠す。
 */
function computeTraffic(ds, { startKey, endKey, daily, posts, accounts, account, searchProps = [], brandedShare = null }) {
  // GA4 は週次で入ってくることがある。期間の端で週を切らないよう、週単位に丸めて絞り込む
  const from = weekStart(startKey);
  const to = addDays(weekStart(endKey), 6);
  const all = (ds.ga4 || []).filter((r) => r.date >= from && r.date <= to);
  // Search Console の日次も同じ週の範囲でそろえる（GA4 が無くても相関を出せるようにする）
  const scWeeks = weeklySearch(sliceSearchDaily(searchProps, from, to), { brandedShare });
  // チャネル別（自然検索・検索広告）。参照元/メディアの表が Instagram だけでも、ここから相関の相手を作れる
  const chWeeks = weeklyChannels(ds.ga4Channels, { from, to });
  if (!all.length && !scWeeks.length && !chWeeks.length) return null;
  // 参照元別とキャンペーン別が両方あると二重計上になるので、集計には粗いほうだけを使う
  const rows = primaryRows(all);

  // 参照元の振り分けで「どのルールにも当たらない Instagram 流入」を入れる先＝本アカウント
  const fallbackAccount = accounts[0]?.username || ds.account?.username || '(本アカウント)';
  const hasGA4 = all.length > 0 || chWeeks.length > 0;
  const gaOnlyWeeks = weeklyTraffic(rows, { fallbackAccount });
  // 相関の相手は GA4 と Search Console をまとめた週データ
  const gaWeeks = mergeTargetWeeks(mergeTargetWeeks(gaOnlyWeeks, scWeeks), chWeeks);
  const igWeeks = weeklyInstagram(posts, daily);
  const joined = joinWeeks(igWeeks, gaWeeks);
  const breakdown = trafficBreakdown(gaOnlyWeeks, { fallbackAccount });
  if (!gaWeeks.length) return null;

  const targets = availableTargets(gaWeeks);
  const fallbackTarget = targets[0]?.key || 'organic';
  const target = targets.some((t) => t.key === state.settings.corrTarget) ? state.settings.corrTarget : fallbackTarget;
  const table = joined.length >= 3 ? correlationTable(joined, { target }) : [];
  const lagged = joined.length >= 4 ? laggedCorrelation(joined, { target }) : [];
  // リンククリックは本アカウントの数字なので、比べる相手もそのアカウント由来に絞る
  const landing = landingRate(joined, { account: account || fallbackAccount });
  // ファネル5段階目：認知（フォロワー以外へのリーチ）に対する HP 流入の通過率
  const bridge = reachToSiteRate(joined, { account: account || fallbackAccount });
  const insights = trafficInsights({ table, lagged, breakdown, landing, joined });

  // UTM キャンペーン別（どの投稿・施策からの流入か）
  const campaigns = new Map();
  for (const r of campaignRows(all)) {
    if (!isInstagram(r.sourceMedium)) continue;
    const c = campaigns.get(r.campaign) || { name: r.campaign, sessions: 0, users: 0, taps: 0 };
    c.sessions += r.sessions || 0;
    c.users += r.users || 0;
    c.taps += r.reserveTaps || 0;
    campaigns.set(r.campaign, c);
  }

  const driverKey = DRIVERS.some((d) => d.key === state.settings.scatterDriver) ? state.settings.scatterDriver : 'posts';
  return {
    gaWeeks, gaOnlyWeeks, scWeeks, hasGA4, targets, igWeeks, joined, breakdown, table, lagged, landing, bridge, insights,
    target, driverKey, fallbackAccount,
    scatter: joined.length >= 3 ? scatterData(joined, driverKey, target) : null,
    properties: [...new Set(rows.map((r) => r.property).filter(Boolean))],
    campaigns: [...campaigns.values()].sort((a, b) => b.sessions - a.sessions),
  };
}

// ---------- 描画 ----------

function render() {
  const hasData = !!state.dataset && ((state.dataset.posts?.length || 0) + (state.dataset.daily?.length || 0) + (state.dataset.ga4?.length || 0) > 0);
  renderAccountLine();
  if (state.trend && hasData) return renderTrendPage();
  $('#trend-view').hidden = true;
  $('#empty-state').hidden = hasData;
  $('#dashboard').hidden = !hasData;
  $('#export-menu').hidden = !hasData;
  if (!hasData) return;

  const v = (state.view = compute());
  syncFilterControls();
  renderPeriodNote(v);
  renderWarnings(v);
  renderKPIs(v);
  renderHpKPIs(v);
  renderKpi(v);
  renderInsights(v);
  renderFollowerCharts(v);
  renderActivity(v);
  renderBreakdown(v);
  renderStories(v);
  renderEngagementCharts(v);
  renderTopPosts(v);
  renderPostsTable();
  renderTiming(v);
  renderSearch(v);
  renderTraffic(v);
  renderAudience(v);
  renderHashtags(v);
  renderToolHashtags(v);
  renderBenchmark(v);
  refreshTableViews();
}

function renderAccountLine() {
  const ds = state.dataset;
  const line = $('#account-line');
  if (!ds) {
    line.textContent = 'データ未接続';
    return;
  }
  const src = { demo: 'デモデータ', csv: 'CSV 取り込み', api: 'Instagram API' }[ds.source] || '';
  // CSV 取り込みではアカウント名が投稿データ側にしか無いので、そちらから拾う
  const names = ds.account?.username ? [ds.account.username] : accountsOf(ds.posts || []).map((a) => a.username);
  const name = names.length ? names.slice(0, 2).map((u) => `@${u}`).join(' / ') + (names.length > 2 ? ` ほか${names.length - 2}件` : '') : '';
  line.textContent = [name, src, ds.fetchedAt ? `更新 ${fmtDateTime(ds.fetchedAt)}` : ''].filter(Boolean).join(' ・ ');
}

function syncFilterControls() {
  $$('#range button').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.days) === state.settings.days)));
  $('#er-basis').value = state.settings.basis;

  // アカウントが複数あるときだけ絞り込みを出す
  const { accounts, account } = state.view;
  const wrap = $('#account-filter-wrap');
  wrap.hidden = accounts.length < 2;
  if (wrap.hidden) return;
  const select = $('#account-filter');
  const signature = accounts.map((a) => a.username).join('|');
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    select.replaceChildren(
      el('option', { value: '', textContent: `すべて（${accounts.length}アカウント）` }),
      ...accounts.map((a) => el('option', { value: a.username, textContent: `@${a.username}（${a.n}投稿）` })),
    );
  }
  select.value = account;
}

function renderPeriodNote(v) {
  const n = Math.round((parseDateKey(v.endKey) - parseDateKey(v.startKey)) / 86400000) + 1;
  $('#period-note').textContent = `${fmtDate(v.startKey)} 〜 ${fmtDate(v.endKey)}（${n}日間）${v.prevSummary ? ' ・ 比較は直前の同じ日数' : ''}`;
}

/** データについての注意書き（画面上部の注意とレポートの両方で使う） */
function warningMessages(v) {
  const msgs = [...(state.dataset.warnings || [])];
  if (state.settings.basis === 'reach' && v.posts.length && v.posts.every((p) => p.reach === null)) {
    msgs.push('投稿のリーチが無いため ER を計算できません。「ER の計算基準」をフォロワー基準に切り替えてください。');
  }
  if (!v.daily.some((d) => d.followers !== null)) {
    msgs.push('フォロワー数の日次データがありません。日次データの CSV を追加するか API 連携してください。');
  } else if (v.followerMode === 'gains' && state.dataset.audience?.followersTotal) {
    msgs.push(
      `フォロワー数の推移は、現在のフォロワー数（${fmtInt(state.dataset.audience.followersTotal)}人）から日々のフォロー数をさかのぼって計算した推定値です。` +
        'フォロー解除数が CSV に含まれないため、過去の値は実際よりやや少なめに出ます。',
    );
  }
  if (v.nonFollowerEstimated) {
    msgs.push(`非フォロワーへのリーチは、取り込んだリーチ内訳の比率を投稿・日ごとのリーチに掛けた推定値です（${describeBreakdowns(state.dataset.reachBreakdown).join('、')}）。内訳の期間外の日は、いちばん近い期間の比率を使っています。`);
  }
  if (v.account) {
    msgs.push(`投稿の分析を @${v.account} に絞り込んでいます。アカウント全体の日次指標（リーチ・プロフィールアクセスなど）は絞り込みの対象外です。`);
  }
  return msgs;
}

function renderWarnings(v) {
  const msgs = warningMessages(v);
  const box = $('#warnings');
  box.hidden = !msgs.length;
  box.replaceChildren(el('ul', {}, ...msgs.map((m) => el('li', { textContent: m }))));
}

/**
 * 非フォロワーのリーチを出せない理由。リーチ内訳はアカウントごとなので、
 * 表示中の投稿のアカウントの内訳が無いと推定できない（別アカウントの比率は使わない）
 */
function nonFollowerMissingReason(posts) {
  const breakdowns = state.dataset.reachBreakdown || [];
  if (!posts.length) return { textContent: '非フォロワー：この期間の投稿なし' };
  if (!breakdowns.length) {
    return { textContent: '非フォロワー：リーチ内訳が未取り込み', title: '「フォロワー以外へのリーチ」の列か、リーチ内訳の CSV を取り込むと表示されます' };
  }
  const have = new Set(breakdowns.map((b) => b.account));
  const missing = [...new Set(posts.map((p) => p.account).filter((a) => a && !have.has(a)))];
  if (missing.length) {
    return {
      textContent: `非フォロワー：${missing.map((a) => `@${a}`).join('・')} の内訳なし`,
      title: `取り込み済みの内訳は ${[...have].map((a) => (a ? `@${a}` : '（アカウント指定なし）')).join('・')} の分です。このアカウントのリーチ内訳の CSV を取り込むと推定します`,
    };
  }
  return { textContent: '非フォロワー：データなし', title: '投稿にリーチの値が無いため推定できません' };
}

function renderKPIs({ summary: s, prevSummary: p, posts }) {
  // 期間内の投稿の非フォロワーのリーチに、リーチ内訳からの推定値が含まれるか
  const nonFEstimated = posts.some((x) => x.nonFollowerEstimated);
  $('#kpi-followers').textContent = fmtInt(s.followers);
  $('#kpi-followers-delta').replaceChildren(
    s.followerChange === null
      ? el('span', { textContent: '増減データなし' })
      : deltaNode(s.followerChange, { unit: '人', suffix: `（${s.followerChangePct >= 0 ? '+' : ''}${(s.followerChangePct ?? 0).toFixed(1)}%）この期間` }),
  );

  $('#kpi-er').textContent = fmtPct(s.avgER);
  $('#kpi-er-delta').replaceChildren(
    p?.avgER ? deltaNode(s.avgER - p.avgER, { unit: 'pt', digits: 2, suffix: '前期間比' }) : el('span', { textContent: `中央値 ${fmtPct(s.medianER)}` }),
  );

  $('#kpi-posts').textContent = fmtInt(s.postCount);
  $('#kpi-posts-delta').replaceChildren(p ? deltaNode(s.postCount - p.postCount, { unit: '件', suffix: '前期間比' }) : el('span', { textContent: '' }));

  const pct = (a, b) => (a !== null && b ? ((a - b) / b) * 100 : null);
  $('#kpi-reach').textContent = fmtCompact(s.avgReach);
  // 数値の下に小さく「非フォロワー」の平均リーチ（押すとその推移を別タブで開く）
  $('#kpi-reach-nonf').replaceChildren(
    s.avgNonFollowerReach === null
      ? el('span', nonFollowerMissingReason(posts))
      : el(
          'a',
          {
            href: '?trend=nonFollowerReach',
            target: '_blank',
            rel: 'noopener',
            title: nonFEstimated
              ? `リーチ × 非フォロワー比率で出した推定値です（${describeBreakdowns(state.dataset.reachBreakdown).join('、')}）。押すと推移を表示`
              : '非フォロワーの平均リーチの推移をみる',
          },
          nonFEstimated ? '非フォロワー（推定） ' : '非フォロワー ',
          el('strong', { textContent: fmtCompact(s.avgNonFollowerReach) }),
          s.nonFollowerShare === null ? '' : `（${s.nonFollowerShare.toFixed(0)}%）`,
        ),
  );
  $('#kpi-reach-delta').replaceChildren(
    p ? deltaNode(pct(s.avgReach, p.avgReach), { unit: '%', digits: 1, suffix: '前期間比' }) : el('span', { textContent: '' }),
  );
  $('#kpi-inter').textContent = fmtCompact(s.avgInteractions);
  $('#kpi-inter-delta').replaceChildren(
    p ? deltaNode(pct(s.avgInteractions, p.avgInteractions), { unit: '%', digits: 1, suffix: '前期間比' }) : el('span', { textContent: `合計 ${fmtInt(s.totalInteractions)}` }),
  );

  // 日次データにあるときだけ出す（API 連携では取れないことがある）
  const optional = (card, valueId, deltaId, value, prevValue, sub) => {
    $(card).hidden = value === null;
    if (value === null) return;
    $(valueId).textContent = fmtCompact(value);
    $(deltaId).replaceChildren(
      prevValue ? deltaNode(pct(value, prevValue), { unit: '%', digits: 1, suffix: '前期間比' }) : el('span', { textContent: sub }),
    );
  };
  optional('#kpi-visits-card', '#kpi-visits', '#kpi-visits-delta', s.totals.profileVisits, p?.totals?.profileVisits, `1日平均 ${fmtInt(s.avgVisits)}`);
  optional('#kpi-clicks-card', '#kpi-clicks', '#kpi-clicks-delta', s.totals.linkClicks, p?.totals?.linkClicks, `1日平均 ${fmtInt(s.avgClicks)}`);

  const shown = $$('.kpis:not(.kpis-hp) .kpi').filter((c) => !c.hidden).length;
  $('.kpis').classList.toggle('dense', shown > 6);
}

/** Instagram から HP への流入（GA4）。GA4 データや列が無いときは「–」と理由を出す */
function renderHpKPIs({ hp: h, prevHp: p }) {
  const pct = (a, b) => (a !== null && b ? ((a - b) / b) * 100 : null);
  const set = (id, text, delta) => {
    $(`#kpi-hp-${id}`).textContent = text;
    $(`#kpi-hp-${id}-delta`).replaceChildren(typeof delta === 'string' ? el('span', { textContent: delta }) : delta);
  };
  if (!h) {
    const why = state.dataset.ga4?.length ? 'この期間の Instagram 流入なし' : 'GA4 データ未取り込み';
    for (const id of ['users', 'sessions', 'new', 'newrate', 'engage', 'cv', 'cvr']) set(id, '–', why);
    return;
  }
  // 件数は前期間比（%）、率は前期間との差（pt）。前期間が無ければ補足を出す
  const count = (id, key, missing, sub, fmt = fmtCompact) => {
    const v = h[key];
    if (v === null) return set(id, '–', missing);
    set(id, fmt(v), p && p[key] !== null ? deltaNode(pct(v, p[key]), { unit: '%', digits: 1, suffix: '前期間比' }) : sub);
  };
  const rate = (id, key, missing, sub) => {
    const v = h[key];
    if (v === null) return set(id, '–', missing);
    set(id, fmtPct(v), p && p[key] !== null ? deltaNode(v - p[key], { unit: 'pt', digits: 2, suffix: '前期間比' }) : sub);
  };

  count('users', 'users', 'GA4 にユーザー数の列なし', '日ごとのユーザー数の合計');
  count('sessions', 'sessions', 'セッションなし', h.paidSessions ? `うち広告 ${fmtInt(h.paidSessions)}` : 'Instagram からの訪問');
  count('new', 'newUsers', 'GA4 に新規ユーザー数の列なし', '初めての訪問');
  rate('newrate', 'newUserRate', h.newUsers === null ? 'GA4 に新規ユーザー数の列なし' : 'ユーザーなし', '新規ユーザー ÷ ユーザー');
  rate('engage', 'engagementRate', h.engagedSessions === null ? 'GA4 にエンゲージのあったセッションの列なし' : 'セッションなし', 'エンゲージのあったセッション ÷ セッション');
  count('cv', 'cv', 'GA4 に CV の列なし', '予約完了', fmtInt);
  rate('cvr', 'cvr', h.cv === null ? 'GA4 に CV の列なし' : 'セッションなし', 'CV ÷ セッション');
}

// ---------- 指標の推移ページ（?trend=指標） ----------

/** 値の書式。率は %、平均は小数1桁、それ以外は整数 */
function trendFormat(m) {
  if (m.unit === '%') return (v) => fmtPct(v);
  if (m.agg === 'mean') return (v) => (v === null || v === undefined ? '–' : v.toLocaleString('ja-JP', { maximumFractionDigits: 1 }));
  return fmtInt;
}

function trendView() {
  const m = trendMetric(state.trend);
  const unit = TREND_UNITS.some((u) => u.key === state.settings.trendUnit) ? state.settings.trendUnit : 'week';
  const { ds, daily, posts, account } = baseData();
  return { m, unit, account, series: trendSeries(m.key, { daily, posts, ga4: ds.ga4 || [] }, unit) };
}

/** 表の列。率は分子・分母、投稿の指標は投稿数も並べて、値の根拠が分かるようにする */
function trendColumns(m) {
  const fmt = trendFormat(m);
  const cols = [
    { label: '期間', get: (r) => r.label },
    { label: m.label, get: (r) => (r.value === null ? '–' : fmt(r.value)), num: true },
    { label: m.unit === '%' ? '前の期間との差' : '前の期間比', get: (r) => (r.change === null ? '–' : `${r.change >= 0 ? '+' : '−'}${Math.abs(r.change).toFixed(m.unit === '%' ? 2 : 1)}${m.unit === '%' ? 'pt' : '%'}`), num: true },
  ];
  if (m.agg === 'ratio') {
    cols.push({ label: m.numLabel, get: (r) => fmtInt(r.num), num: true }, { label: m.denLabel, get: (r) => fmtInt(r.den), num: true });
  } else if (m.source === 'posts' && m.agg !== 'count') {
    cols.push({ label: '投稿数', get: (r) => fmtInt(r.n), num: true });
  }
  return cols;
}

function renderTrendPage() {
  $('#empty-state').hidden = true;
  $('#dashboard').hidden = true;
  $('#export-menu').hidden = true;
  $('#trend-view').hidden = false;
  // 戻り先は同じページの、クエリを外したもの（単一ファイル版でも動く）
  $('#trend-back').href = location.pathname;

  const { m, unit, account, series } = trendView();
  const rows = series.rows;
  document.title = `${m.label}の推移 | Instagram インサイト分析`;
  $('#trend-group').textContent = m.group;
  $('#trend-title').textContent = `${m.label}の推移`;
  $('#trend-def').textContent = m.def;

  $$('#trend-unit button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.unit === unit)));
  const select = $('#trend-metric');
  if (!select.options.length) {
    const groups = [...new Set(TREND_METRICS.map((x) => x.group))];
    select.replaceChildren(
      ...groups.map((g) => el('optgroup', { label: g }, ...TREND_METRICS.filter((x) => x.group === g).map((x) => el('option', { value: x.key, textContent: x.label })))),
    );
  }
  select.value = m.key;

  const unitLabel = TREND_UNITS.find((u) => u.key === unit).label;
  $('#trend-note').textContent = rows.length ? `${fmtDate(rows[0].key)} から ${rows.length}${unitLabel}分` : '';
  const warns = [];
  if (account && m.source === 'posts') warns.push(`投稿の指標は @${account} の投稿だけで集計しています。`);
  if (m.key === 'nonFollowerReach' && state.dataset.reachBreakdown?.length) {
    warns.push(`実数の無い投稿は、リーチ × 非フォロワー比率の推定値で集計しています（${describeBreakdowns(state.dataset.reachBreakdown).join('、')}）。`);
  }
  if (unit !== 'day' && rows.length) warns.push(`最初と最後の${unitLabel}は、データのある日だけの値です（${unitLabel}の途中までの場合があります）。`);
  if (m.source === 'ga4' && unit === 'day' && (state.dataset.ga4 || []).length && rows.some((r) => r.value === null)) {
    warns.push('GA4 のデータが週単位の場合、日別では週の初日にまとめて表示されます。週別か月別で見てください。');
  }
  $('#trend-warn').hidden = !warns.length;
  $('#trend-warn').replaceChildren(el('ul', {}, ...warns.map((w) => el('li', { textContent: w }))));

  const fmt = trendFormat(m);
  $('#trend-chart-sub').textContent = `${unitLabel}別・${m.chart === 'bar' ? '棒' : '折れ線'}グラフ（点にカーソルを合わせると値を表示）`;
  if (!setEmpty('c-trend', !rows.some((r) => r.value !== null), m.source === 'ga4' ? 'GA4 のデータがありません（データ接続・更新から取り込めます）' : 'この指標のデータがありません')) {
    charts.trendChart('c-trend', rows, { type: m.chart, unit: m.unit, name: m.label, format: fmt });
  }

  const cols = trendColumns(m);
  const table = $('#trend-table');
  table.tHead.replaceChildren(el('tr', {}, ...cols.map((c) => el('th', { textContent: c.label, className: c.num ? 'num' : '' }))));
  table.tBodies[0].replaceChildren(
    ...(rows.length
      ? [...rows].reverse().map((r) => el('tr', {}, ...cols.map((c) => el('td', { textContent: c.get(r), className: c.num ? 'num' : '' }))))
      : [el('tr', {}, el('td', { colSpan: cols.length, textContent: 'データがありません' }))]),
  );
}

function exportTrendCSV() {
  const { m, unit, series } = trendView();
  const cols = trendColumns(m);
  download(`trend_${m.key}_${unit}.csv`, toCSV([...series.rows].reverse(), cols), 'text/csv');
}

function renderInsights(v) {
  const icons = { good: '✓', warn: '!', info: 'i' };
  const levels = { good: '好調', warn: '要注意', info: '参考' };
  const list = $('#insights');
  // GA4 の所見も同じレポートにまとめる
  const insights = [...v.insights, ...(v.traffic?.insights || [])];
  if (!insights.length) {
    list.replaceChildren(el('li', { className: 'info' }, el('span', { className: 'ic', textContent: 'i' }), el('strong', { textContent: 'データが少ないため分析できません' }), el('span', { className: 'tx', textContent: '期間を広げてください。' })));
    return;
  }
  list.replaceChildren(
    ...insights.map((i) =>
      el(
        'li',
        { className: i.level },
        el('span', { className: 'ic', textContent: icons[i.level], ariaHidden: 'true' }),
        el('strong', {}, i.title, el('span', { className: 'lv', textContent: levels[i.level] })),
        el('span', { className: 'tx', textContent: i.text }),
      ),
    ),
  );
}

/** データが無いグラフにはメッセージを出す */
function setEmpty(canvasId, empty, msg = 'この期間のデータがありません') {
  const wrap = document.getElementById(canvasId).parentElement;
  let note = wrap.querySelector('.empty-note');
  if (empty) {
    charts.getChart(canvasId)?.destroy();
    if (!note) {
      note = el('p', { className: 'empty-note sub' });
      note.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;margin:0';
      wrap.append(note);
    }
    note.textContent = msg;
  } else note?.remove();
  return empty;
}

// ---------- KPI ツリー ----------

const KPI_STATUS_LABELS = { reached: '目標達成', onTrack: '基準以上', behind: '基準割れ', none: 'データなし' };
const KPI_STAGE_LABELS = { kgi: 'KGI', see: '見る（認知）', keep: '残す（興味）', connect: 'つながる（関係化）', bridge: 'HPへ（橋渡し）' };

/** KPI の値の表示（率は % 、それ以外は整数＋単位） */
const fmtKpi = (row, value) => {
  if (value === null || value === undefined) return '–';
  if (row.unit === '%') return `${value.toFixed(row.digits ?? 1)}%`;
  const digits = row.digits ?? 0;
  return `${digits ? value.toFixed(digits) : Math.round(value).toLocaleString('ja-JP')}${row.unit}`;
};

function renderKpi(v) {
  const rows = v.kpi.rows;
  const days = v.kpi.days;
  $('#kpi-lead').textContent =
    `運用で決めた指標の定義・基準・目標に対する進捗です。期間の合計を「月あたり」に直して比べています` +
    `（いまの期間は ${days}日間 → ${DAYS_PER_MONTH.toFixed(1)}日ぶんに換算）。率の指標は換算しません。`;

  // --- KGI（複数ある） ---
  const kgis = rows.filter((r) => r.stage === 'kgi');
  const box = $('#kpi-kgi');
  const usable = kgis.filter((k) => k.monthly !== null);
  if (!usable.length) {
    box.replaceChildren(el('p', { className: 'sub', textContent: 'KGI を出すためのデータ（保存・フォロワー純増・GA4 の流入）がまだありません' }));
  } else {
    box.replaceChildren(
      ...kgis.map((k) =>
        el('div', { className: 'kgi-item' },
          el('p', { className: 'kgi-name', textContent: k.label }),
          k.monthly === null
            ? el('p', { className: 'sub', textContent: `${k.source} のデータがありません` })
            : el('div', { className: 'kgi-box' },
                el('div', { className: 'kgi-value' }, fmtKpi(k, k.monthly), el('span', { className: 'kgi-unit', textContent: '／月' })),
                el('p', {
                  className: 'kgi-sub',
                  textContent: `基準 ${fmtKpi(k, k.baseline)} ・ 目標 ${fmtKpi(k, k.target)}${k.progress === null ? '' : `（達成率 ${Math.round(k.progress)}%）`}`,
                }),
                k.key === 'interestGain'
                  ? el('p', { className: 'kgi-sub', textContent: `内訳：保存 ${fmtKpi(k, monthlyOf(rows, 'saves'))} ＋ 純増 ${fmtKpi(k, monthlyOf(rows, 'netFollowers'))}` })
                  : el('p', { className: 'kgi-sub', textContent: k.def }),
              ),
          k.monthly === null ? null : goalBar(k),
        ),
      ),
    );
  }

  // --- 5段階のファネル ---
  $('#kpi-funnel').replaceChildren(
    ...v.kpi.funnel.map((s) =>
      el('li', {},
        el('span', { className: 'st-name', textContent: s.label }),
        el('span', { className: 'st-value', textContent: s.value === null ? '–' : `${Math.round(s.value).toLocaleString('ja-JP')}${s.unit}` }),
        el('span', { className: 'st-metric', textContent: s.metric }),
        el('span', {
          className: 'st-rate',
          textContent: s.rate === null ? '' : `${s.fromLabel}の ${fmtPct(s.rate, 1)}`,
          title: s.rateIsLanding ? 'リンククリックのうち、実際に HP へ着地したセッションの割合' : '',
        }),
        s.note ? el('span', { className: 'st-note', textContent: s.note }) : null,
      ),
    ),
  );

  renderKpiTable(rows);
  renderActionCorrelation(v);
  // 「投稿と流入の相関」は KPI ブロックへ移したので、GA4 の有無に関わらずここで描く
  $('#correlation-card').hidden = !v.traffic;
  if (v.traffic) renderCorrelation(v);
}

const monthlyOf = (rows, key) => rows.find((r) => r.key === key)?.monthly ?? null;

function goalBar(row) {
  const bar = el('span', { className: `goal-bar ${row.status === 'reached' ? 'reached' : row.status === 'behind' ? 'behind' : ''}` });
  const pct = row.progress === null ? (row.status === 'reached' ? 100 : 0) : Math.max(0, Math.min(100, row.progress));
  bar.append(el('span', {}));
  bar.firstChild.style.width = `${pct}%`;
  bar.title = row.progress === null ? '「維持」が目標の指標です' : `達成率 ${Math.round(row.progress)}%`;
  return bar;
}

function renderKpiTable(rows) {
  const editing = state.kpiEdit;
  $('#kpi-edit').setAttribute('aria-pressed', String(editing));
  $('#kpi-edit').textContent = editing ? '編集を終える' : '基準・目標を編集';
  $('#kpi-table-sub').textContent = editing
    ? '基準・目標の欄に数値を入れると、その場で進捗を計算し直します（このブラウザに保存されます）'
    : '月あたりに換算した実績と、基準・目標に対する進捗';
  $('#kpi-note').textContent =
    '「維持」が目標の指標は、基準を下回らなければ達成とみなします。'
    + 'データが取り込まれていない指標は「データなし」と表示します。';

  const table = $('#kpi-table');
  table.querySelector('thead').replaceChildren(
    el('tr', {},
      el('th', { textContent: '指標' }),
      el('th', { textContent: '定義' }),
      el('th', { className: 'num', textContent: '実績（月あたり）' }),
      el('th', { className: 'num', textContent: '基準' }),
      el('th', { className: 'num', textContent: '目標' }),
      el('th', { className: 'num', textContent: '進捗' }),
      el('th', { textContent: '取得元' }),
    ),
  );

  const body = [];
  for (const group of kpiByStage(rows)) {
    const head = el('tr', { className: 'kpi-stage-row' });
    const td = head.insertCell();
    td.colSpan = 7;
    td.textContent = `${group.label}　${group.note}`;
    body.push(head);
    for (const r of group.rows) body.push(kpiRowEl(r, editing));
  }
  table.querySelector('tbody').replaceChildren(...body);
}

function kpiRowEl(r, editing) {
  const goalCell = (field) => {
    const td = el('td', { className: 'num' });
    if (!editing) {
      td.textContent = fmtKpi(r, r[field]);
      if (field === 'target' && r.targetNote) td.title = r.targetNote;
      return td;
    }
    const input = el('input', { type: 'number', value: String(r[field]), step: r.unit === '%' ? '0.1' : '1', min: '0' });
    input.dataset.kpi = r.key;
    input.dataset.field = field;
    input.setAttribute('aria-label', `${r.label}の${field === 'baseline' ? '基準' : '目標'}`);
    td.append(input);
    return td;
  };

  const progress = el('td', { className: 'num' },
    el('span', { className: `kpi-status ${r.status}`, textContent: KPI_STATUS_LABELS[r.status] }),
    r.status === 'none' ? null : goalBar(r),
  );

  const name = el('td', {}, el('strong', { textContent: r.label }));
  if (r.note) name.append(el('p', { className: 'sub', textContent: r.note }));
  if (r.targetNote) name.append(el('p', { className: 'sub', textContent: `目標の考え方：${r.targetNote}` }));
  // 何を集計した数字かが分かるようにする（GA4 が複数サイトぶんの合計になっていないか等）
  if (r.dataNote) name.append(el('p', { className: 'sub', textContent: r.dataNote }));

  return el('tr', {},
    name,
    el('td', { textContent: r.def }),
    el('td', { className: 'num', textContent: fmtKpi(r, r.monthly), title: r.perMonth && r.raw !== null ? `期間の合計 ${fmtKpi(r, r.raw)}` : '' }),
    goalCell('baseline'),
    goalCell('target'),
    progress,
    el('td', { textContent: r.source }),
  );
}

function renderFollowerCharts(v) {
  const mode = v.followerMode;
  $('#net-title').textContent = mode === 'gains' ? '日次の新規フォロー数' : '日次の純増減（フォロー − フォロー解除）';
  $('#followers-sub').textContent = mode === 'gains' ? '日次（新規フォロー数からの推定値）' : '日次の総フォロワー数';

  if (!setEmpty('c-followers', !v.daily.some((d) => d.followers !== null))) charts.followerLine('c-followers', v.daily);
  if (!setEmpty('c-net', !v.daily.some((d) => d.netChange !== null)))
    charts.netChangeBars('c-net', v.daily, mode === 'gains' ? '新規フォロー' : '純増減');
}

/** アカウント全体の日次指標（リーチ・ビュー・プロフィールアクセス・リンククリック）と導線 */
function renderActivity(v) {
  const has = (key) => v.daily.some((d) => d[key] !== null);
  const reachSeries = [
    { key: 'reach', label: 'リーチ' },
    { key: 'nonFollowerReach', label: v.daily.some((d) => d.nonFollowerEstimated) ? 'フォロワー以外へのリーチ（推定）' : 'フォロワー以外へのリーチ', sameAxis: true },
    { key: 'views', label: 'ビュー' },
    // Viewers はビュー（延べ回数）と違い「見た人数」。リーチと比べられるよう同じ軸に置く
    { key: 'viewers', label: '閲覧者数', sameAxis: true },
  ].filter((s) => has(s.key));
  const trafficSeries = [
    { key: 'profileVisits', label: 'プロフィールアクセス' },
    { key: 'linkClicks', label: 'リンククリック' },
    { key: 'interactions', label: 'コンテンツインタラクション' },
  ].filter((s) => has(s.key));

  const show = reachSeries.length || trafficSeries.length || v.steps.length || v.formats;
  $('#activity-block').hidden = !show;
  if (!show) return;

  $('#reach-card').hidden = !reachSeries.length;
  if (reachSeries.length) {
    $('#reach-sub').textContent = reachSeries.map((s) => s.label).join(' と ') + 'の日次推移';
    if (!setEmpty('c-reach', false)) charts.multiLine('c-reach', v.daily, reachSeries);
  }

  $('#traffic-card').hidden = !trafficSeries.length;
  if (trafficSeries.length && !setEmpty('c-traffic', false)) charts.multiLine('c-traffic', v.daily, trafficSeries);

  $('#funnel-card').hidden = v.steps.length < 2;
  if (v.steps.length >= 2) charts.renderFunnel($('#funnel'), v.steps);
}

const statRow = (label, value, title = '') => [el('dt', { textContent: label, title }), el('dd', { textContent: value })];

/** 日次インサイトの内訳：どの面で見られたか・プロフィールからのアクション・リーチの内訳 */
function renderBreakdown(v) {
  const { surfaces, clicks, totals } = v.si;
  const hasSurface = surfaces.length > 1;
  const hasTotals = totals.nonFollowerReach !== null || totals.conversionRate !== null;

  $('#surface-row').hidden = !hasSurface && !hasTotals;
  $('#surface-card').hidden = !hasSurface;
  if (hasSurface && !setEmpty('c-surface', false)) {
    const series = [
      { key: 'reach', label: 'リーチ' },
      { key: 'views', label: '閲覧数' },
    ].filter((s) => surfaces.some((row) => row.values[s.key] !== null));
    charts.groupedHBar('c-surface', surfaces, series);
  }

  $('#account-totals-card').hidden = !hasTotals;
  if (hasTotals) {
    const rows = [
      ['リーチ（期間合計）', totals.reach],
      ['うちフォロワー', totals.followerReach],
      ['うちフォロワー以外', totals.nonFollowerReach],
    ].filter(([, value]) => value !== null).map(([label, value]) => statRow(label, fmtInt(value)));
    if (totals.nonFollowerShare !== null) rows.push(statRow('フォロワー以外の割合', fmtPct(totals.nonFollowerShare, 1), 'フォロワー以外 ÷（フォロワー＋フォロワー以外）'));
    if (totals.profileVisits !== null) rows.push(statRow('プロフィールアクセス', fmtInt(totals.profileVisits)));
    if (totals.follows !== null) rows.push(statRow('新規フォロー', fmtInt(totals.follows)));
    if (totals.conversionRate !== null) rows.push(statRow('フォロワー転換率', fmtPct(totals.conversionRate, 1), 'プロフィールに来た人のうち、フォローした割合'));
    if (totals.saves !== null) rows.push(statRow('保存', fmtInt(totals.saves)));
    $('#account-totals').replaceChildren(...rows.flat());
  }

  $('#clicks-card').hidden = !clicks.length;
  if (clicks.length && !setEmpty('c-clicks', false)) {
    charts.hBar('c-clicks', clicks.map((c) => ({ label: c.label, value: c.value })), { name: '件' });
  }

  renderFormats(v.formats);
}

/**
 * Meta の「Top content formats」。日付を持たない期間合計なので、
 * 期間フィルタとは無関係に「書き出した内容そのまま」を出す。
 */
function renderFormats(formats) {
  const row = $('#formats-row');
  row.hidden = !formats;
  if (!formats) return;

  const views = formats.views || [];
  const totalViews = views.reduce((s, r) => s + r.value, 0);
  $('#formats-sub').textContent = totalViews
    ? `書き出した期間の合計 ${fmtInt(totalViews)}ビュー（期間フィルタの対象外）`
    : '書き出した期間の合計（期間フィルタの対象外）';
  if (!setEmpty('c-formats-views', !views.length, 'ビューの内訳がありません')) {
    charts.hBar(
      'c-formats-views',
      [...views].sort((a, b) => b.value - a.value).map((r) => ({
        label: r.label,
        value: r.value,
        sub: totalViews ? `全体の ${((r.value / totalViews) * 100).toFixed(1)}%` : '',
      })),
      { name: 'ビュー' },
    );
  }

  // 投稿数・ビュー・反応数を形式ごとに1つの表にまとめる
  const keys = [...new Set(['published', 'views', 'interactions'].flatMap((k) => (formats[k] || []).map((r) => r.key)))];
  const labelOf = (key) => ['published', 'views', 'interactions'].map((k) => (formats[k] || []).find((r) => r.key === key)?.label).find(Boolean) || key;
  const valueOf = (k, key) => (formats[k] || []).find((r) => r.key === key)?.value ?? null;
  const table = $('#formats-table');
  table.querySelector('thead').replaceChildren(
    el('tr', {},
      el('th', { textContent: '形式' }),
      el('th', { className: 'num', textContent: '投稿数' }),
      el('th', { className: 'num', textContent: 'ビュー' }),
      el('th', { className: 'num', textContent: '反応数' }),
      el('th', { className: 'num', textContent: '反応率', title: '反応数 ÷ ビュー' }),
    ),
  );
  table.querySelector('tbody').replaceChildren(
    ...keys.map((key) => {
      const v2 = valueOf('views', key);
      const i2 = valueOf('interactions', key);
      return el('tr', {},
        el('td', { textContent: labelOf(key) }),
        el('td', { className: 'num', textContent: fmtInt(valueOf('published', key)) }),
        el('td', { className: 'num', textContent: fmtInt(v2) }),
        el('td', { className: 'num', textContent: fmtInt(i2) }),
        el('td', { className: 'num', textContent: v2 && i2 !== null ? fmtPct((i2 / v2) * 100, 3) : '–' }),
      );
    }),
  );
}

/** ストーリーズ：日ごとの推移・時間帯別の閲覧率・見た人のその後・一覧 */
function renderStories(v) {
  const { stories, storiesSummary: s, storiesDaily, storiesHours } = v.si;
  $('#stories-block').hidden = !stories.length;
  if (!stories.length) return;

  // 日ごとの閲覧数・リーチ。本数は桁が違うので右軸に置くが、
  // 毎日1本だと目盛りが潰れて読めないため、2本以上の日があるときだけ出す
  const maxPerDay = Math.max(0, ...storiesDaily.map((d) => d.n));
  const series = [
    { key: 'views', label: '閲覧数' },
    { key: 'reach', label: 'リーチ', sameAxis: true },
    ...(maxPerDay >= 2 ? [{ key: 'n', label: '本数' }] : []),
  ].filter((x) => storiesDaily.some((d) => d[x.key] !== null));
  $('#stories-chart-sub').textContent = `${series.map((x) => x.label).join('・')}（${storiesDaily.length}日分）`;
  if (!setEmpty('c-stories', false)) charts.multiLine('c-stories', storiesDaily, series);

  // 期間のまとめ
  $('#stories-sum-sub').textContent = `${s.days}日間で${fmtInt(s.n)}本（1日あたり ${s.perDay ? s.perDay.toFixed(1) : '–'}本）`;
  const rows = [];
  if (s.views !== null) rows.push(statRow('閲覧数（合計）', fmtInt(s.views)));
  if (s.viewsMean !== null) rows.push(statRow('平均閲覧数／本', fmtInt(Math.round(s.viewsMean))));
  if (s.viewRate !== null) rows.push(statRow('平均閲覧率', fmtPct(s.viewRate, 2), 'フォロワー数のうち何％が見たか'));
  if (s.reach !== null) rows.push(statRow('リーチ（合計）', fmtInt(s.reach)));
  if (s.exitRate !== null) rows.push(statRow('離脱率', fmtPct(s.exitRate, 1), '見た人のうち、そこで見るのをやめた割合'));
  if (s.nextRate !== null) rows.push(statRow('次へ送った率', fmtPct(s.nextRate, 1)));
  if (s.replies !== null) rows.push(statRow('返信', fmtInt(s.replies)));
  if (s.follows !== null) rows.push(statRow('フォロー（ストーリーズ経由）', fmtInt(s.follows)));
  if (s.profileVisits !== null) rows.push(statRow('プロフィール遷移', fmtInt(s.profileVisits)));
  if (s.linkClicks !== null) rows.push(statRow('リンククリック', fmtInt(s.linkClicks)));
  $('#stories-summary').replaceChildren(...rows.flat());

  // 時間帯別の平均閲覧率（本数の少ない枠は目安にならないので2本以上に限る）
  const hourRows = storiesHours.filter((h) => h.n >= 2 && h.viewRate !== null);
  const top3 = [...hourRows].sort((a, b) => b.viewRate - a.viewRate).slice(0, 3).map((h) => h.hour);
  if (!setEmpty('c-stories-hour', !hourRows.length, '同じ時間帯に2本以上のストーリーズがありません')) {
    charts.vBar(
      'c-stories-hour',
      hourRows.map((h) => ({ label: `${h.hour}時`, value: h.viewRate, sub: `${h.n}本` })),
      { unit: '%', name: '平均閲覧率', highlight: hourRows.map((h, i) => (top3.includes(h.hour) ? i : -1)).filter((i) => i >= 0) },
    );
  }

  // 見た人のその後（閲覧数に対する割合）
  const after = [
    { label: '次へ送った', value: s.nextRate },
    { label: '戻って見直した', value: s.backRate },
    { label: '離脱した', value: s.exitRate },
    { label: '次のアカウントへ', value: s.skipRate },
  ].filter((r) => r.value !== null);
  if (!setEmpty('c-stories-funnel', !after.length)) charts.hBar('c-stories-funnel', after, { unit: '%', name: '閲覧数に対する割合' });

  renderStoriesTable(stories);
}

function renderStoriesTable(list) {
  const STORY_TYPES = { VIDEO: '動画', IMAGE: '画像' };
  $('#stories-count').textContent = `${fmtInt(list.length)}件（新しい順）`;
  const frag = document.createDocumentFragment();
  for (const s of [...list].reverse().slice(0, 500)) {
    const tr = document.createElement('tr');
    tr.insertCell().textContent = fmtDateTime(s.timestamp);
    tr.insertCell().append(el('span', { className: 'type-tag' }, el('i', { className: s.type === 'VIDEO' ? 'REELS' : 'IMAGE' }), STORY_TYPES[s.type] || s.type));

    const text = s.caption.replace(/\s+/g, ' ').trim();
    const cap = el('span', { className: 'cap', textContent: text || '（テキストなし）' });
    tr.insertCell().append(s.permalink ? el('a', { href: s.permalink, target: '_blank', rel: 'noopener noreferrer' }, cap) : cap);

    for (const k of ['views', 'viewRate', 'reach', 'exits', 'tapsForward', 'tapsBack', 'replies', 'follows', 'profileVisits', 'linkClicks']) {
      const td = tr.insertCell();
      td.className = 'num';
      td.textContent = s[k] === null || s[k] === undefined ? '–' : k === 'viewRate' ? fmtPct(s[k], 2) : fmtInt(s[k]);
    }
    frag.append(tr);
  }
  $('#stories-table tbody').replaceChildren(frag);
}

/** ソーシャルインサイトのハッシュタグ分析（書き出し・期間ごとに切り替えて表示） */
function renderToolHashtags(v) {
  const sets = v.si.hashtagSets;
  $('#tool-hashtag-card').hidden = !sets.length;
  if (!sets.length) return;

  const select = $('#tool-hashtag-set');
  const current = sets.find((s) => s.key === state.settings.hashtagSet) || sets[0];
  select.replaceChildren(...sets.map((s) => el('option', { value: s.key, textContent: s.label, selected: s.key === current.key })));
  // 書き出しが1つしかないときは切り替えるものが無いので隠す
  select.closest('label').hidden = sets.length < 2;

  const views = current.rows.some((r) => r.viewsMean !== null);
  $('#tool-hashtag-sub').textContent = [
    current.start && current.end ? `${fmtDate(current.start)}〜${fmtDate(current.end)}の集計` : '期間不明の集計',
    `エンゲージメント率は${current.erBasis === 'views' ? '閲覧数' : 'フォロワー数'}基準`,
    'ツール側の集計値（表示中の期間には連動しません）',
  ].join(' / ');

  // 書き出しによって指標が違うので、列も切り替える
  const cols = [
    { label: 'ハッシュタグ', get: (r) => r.tag },
    { label: '投稿件数', num: true, get: (r) => fmtInt(r.posts) },
    ...(views
      ? [
        { label: '平均閲覧数', num: true, get: (r) => fmtInt(r.viewsMean) },
        { label: '平均リーチ', num: true, get: (r) => fmtInt(r.reachMean) },
        { label: '平均いいね', num: true, get: (r) => fmtInt(r.likesMean) },
        { label: '平均保存', num: true, get: (r) => fmtInt(r.savesMean) },
      ]
      : [
        { label: '平均いいね', num: true, get: (r) => fmtInt(r.likesMean) },
        { label: '平均コメント', num: true, get: (r) => (r.commentsMean === null ? '–' : r.commentsMean.toFixed(1)) },
      ]),
    { label: '平均ER', num: true, get: (r) => fmtPct(r.erMean, 2) },
    { label: '中央値ER', num: true, get: (r) => fmtPct(r.erMedian, 2) },
  ];
  const table = $('#tool-hashtag-table');
  table.tHead.replaceChildren(el('tr', {}, ...cols.map((c) => el('th', { textContent: c.label, className: c.num ? 'num' : '' }))));
  table.tBodies[0].replaceChildren(
    ...current.rows.slice(0, 60).map((r) => el('tr', {}, ...cols.map((c) => el('td', { textContent: c.get(r), className: c.num ? 'num' : '' })))),
  );
}

/** フォロー中アカウント（ベンチマーク）とタグ付き投稿 */
function renderBenchmark(v) {
  const { followed, benchmark, tagged } = v.si;
  $('#benchmark-block').hidden = !followed.length && !tagged.list.length;

  $('#followed-row').hidden = !followed.length;
  if (followed.length) {
    $('#followed-count').textContent = `${fmtInt(benchmark.n)}件 / フォロワー数の中央値 ${fmtInt(benchmark.followersMedian)}人・最大 ${fmtInt(benchmark.followersMax)}人`;
    $('#followed-table tbody').replaceChildren(
      ...followed.slice(0, 200).map((f) => {
        const tr = document.createElement('tr');
        const name = el('span', { className: 'cap', textContent: `@${f.username}` });
        tr.insertCell().append(f.url ? el('a', { href: f.url, target: '_blank', rel: 'noopener noreferrer' }, name) : name);
        tr.insertCell().append(el('span', { className: 'cap', textContent: f.profile || '–' }));
        for (const k of ['followers', 'posts', 'follows']) {
          const td = tr.insertCell();
          td.className = 'num';
          td.textContent = fmtInt(f[k]);
        }
        return tr;
      }),
    );
    $('#followed-tags').replaceChildren(
      ...(benchmark.topHashtags.length
        ? benchmark.topHashtags.map((t) => statRow(`#${t.tag}`, `${t.n}アカウント`)).flat()
        : statRow('ハッシュタグの情報がありません', '–')),
    );
  }

  $('#tagged-card').hidden = !tagged.list.length;
  if (tagged.list.length) {
    $('#tagged-count').textContent = `${fmtInt(tagged.list.length)}件（${tagged.accounts.map((a) => `@${a.account} ${a.n}件`).join(' / ')}）`;
    $('#tagged-table tbody').replaceChildren(
      ...tagged.list.slice(0, 200).map((t) => {
        const tr = document.createElement('tr');
        tr.insertCell().textContent = fmtDateTime(t.timestamp);
        tr.insertCell().textContent = `@${t.account}`;
        tr.insertCell().textContent = t.type;
        const cap = el('span', { className: 'cap', textContent: t.caption.replace(/\s+/g, ' ').slice(0, 120) || '（キャプションなし）' });
        tr.insertCell().append(t.permalink ? el('a', { href: t.permalink, target: '_blank', rel: 'noopener noreferrer' }, cap) : cap);
        for (const k of ['likes', 'comments']) {
          const td = tr.insertCell();
          td.className = 'num';
          td.textContent = fmtInt(t[k]);
        }
        return tr;
      }),
    );
  }
}

/** HPへの流入（GA4）と、投稿との相関 */
// ---------- Google 検索（Search Console） ----------

/** 複数プロパティの同じ切り口（デバイス・国など）を足し合わせる */
function mergeDimension(props, key, itemKey) {
  const map = new Map();
  for (const p of props) {
    for (const r of p[key] || []) {
      const name = r[itemKey];
      const cur = map.get(name) || { [itemKey]: name, clicks: 0, impressions: 0, _w: 0 };
      cur.clicks += r.clicks ?? 0;
      cur.impressions += r.impressions ?? 0;
      if (r.position !== null && r.impressions) cur._w += r.position * r.impressions;
      map.set(name, cur);
    }
  }
  return [...map.values()]
    .map((r) => ({
      [itemKey]: r[itemKey],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.impressions ? (r.clicks / r.impressions) * 100 : null,
      position: r.impressions && r._w ? r._w / r.impressions : null,
    }))
    .sort((a, b) => b.clicks - a.clicks);
}

const fmtPos = (v) => (v === null || v === undefined ? '–' : `${v.toFixed(1)}位`);

function renderSearch(v) {
  const s = v.search;
  const block = $('#search-block');
  block.hidden = !s.all.length;
  if (block.hidden) return;

  // 対象プロパティの切り替え（データのある種別だけ押せる）
  $$('#search-scope button').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.scope === s.scope));
    b.disabled = !s.available[b.dataset.scope];
  });
  $('#search-sort').value = state.settings.searchSort;
  const names = s.scoped.map((p) => p.label).join(' / ') || '（データなし）';
  $('#search-lead').textContent =
    `${names} の検索結果での表示回数・クリック・掲載順位です。投稿一覧の「検索表示・検索クリック・検索順位」の列も同じデータです。` +
    (s.filter?.['日付'] ? `対象期間は Search Console 側の指定（${s.filter['日付']}）に従います。` : '');

  // 期間の合計
  const sum = s.summary;
  $('#search-period').textContent = sum?.from ? `${fmtDate(sum.from)} 〜 ${fmtDate(sum.to)}` : '書き出した期間ぜんぶ';
  $('#search-summary').replaceChildren(
    ...statRow('表示回数', fmtInt(sum?.impressions), '検索結果に出た回数'),
    ...statRow('クリック', fmtInt(sum?.clicks), '検索結果から開かれた回数'),
    ...statRow('CTR', fmtPct(sum?.ctr), '表示回数に対するクリックの割合'),
    ...statRow('平均掲載順位', fmtPos(sum?.position), '表示回数で重み付けした平均。小さいほど上位'),
    ...statRow('検索語の数', fmtInt(sum?.queryCount), '書き出しに入っていた検索語の数'),
  );

  // 検索クエリ（グラフ＋表）
  const top = s.queries.slice(0, 12);
  $('#search-query-sub').textContent = `上位${top.length}件（全${s.queries.length}件）・${SEARCH_SORT_LABELS[state.settings.searchSort]}順`;
  if (!setEmpty('c-search-queries', !top.length, '検索クエリのデータがありません')) {
    const metric = state.settings.searchSort === 'position' ? 'position' : state.settings.searchSort;
    charts.hBar(
      'c-search-queries',
      top.map((r) => ({
        label: r.query.length > 22 ? `${r.query.slice(0, 21)}…` : r.query,
        title: r.query,
        value: r[metric] ?? 0,
        sub: `${fmtInt(r.clicks)}クリック / ${fmtInt(r.impressions)}表示 ・ CTR ${fmtPct(r.ctr)} ・ ${fmtPos(r.position)}`,
      })),
      { unit: metric === 'ctr' ? '%' : '', name: SEARCH_SORT_LABELS[metric] },
    );
  }
  renderSearchQueryTable(s.queries.slice(0, 100));
  renderSearchGapTable(s.gaps);

  // 検索から見つかっている投稿（Instagram のプロパティがあるときだけ）
  const hasPostData = v.posts.some((p) => p.searchImpressions !== null && p.searchImpressions !== undefined);
  $('#search-post-row').hidden = !hasPostData && !s.devices.length;
  $('#search-post-table').closest('article').hidden = !hasPostData;
  if (hasPostData) renderSearchPostTable(v.posts);

  const deviceCard = $('#c-search-device').closest('article');
  deviceCard.hidden = !s.devices.length;
  if (s.devices.length && !setEmpty('c-search-device', false)) {
    charts.hBar(
      'c-search-device',
      s.devices.map((r) => ({
        label: r.device,
        value: r.clicks,
        sub: `${fmtInt(r.impressions)}表示 ・ CTR ${fmtPct(r.ctr)} ・ ${fmtPos(r.position)}`,
      })),
      { name: 'クリック' },
    );
  }
}

const SEARCH_SORT_LABELS = { clicks: 'クリック', impressions: '表示回数', ctr: 'CTR', position: '掲載順位' };

function renderSearchQueryTable(rows) {
  const table = $('#search-query-table');
  table.querySelector('thead').replaceChildren(
    el('tr', {},
      el('th', { textContent: '検索語' }),
      el('th', { className: 'num', textContent: 'クリック' }),
      el('th', { className: 'num', textContent: '表示回数' }),
      el('th', { className: 'num', textContent: 'CTR' }),
      el('th', { className: 'num', textContent: '掲載順位' }),
    ),
  );
  table.querySelector('tbody').replaceChildren(
    ...rows.map((r) =>
      el('tr', {},
        el('td', { textContent: r.query, title: r.query }),
        el('td', { className: 'num', textContent: fmtInt(r.clicks) }),
        el('td', { className: 'num', textContent: fmtInt(r.impressions) }),
        el('td', { className: 'num', textContent: fmtPct(r.ctr) }),
        el('td', { className: 'num', textContent: fmtPos(r.position) }),
      ),
    ),
  );
}

function renderSearchGapTable(rows) {
  const card = $('#search-gap-card');
  card.hidden = !rows.length;
  if (!rows.length) return;
  const table = $('#search-gap-table');
  table.querySelector('thead').replaceChildren(
    el('tr', {},
      el('th', { textContent: '検索語' }),
      el('th', { className: 'num', textContent: '掲載順位' }),
      el('th', { className: 'num', textContent: 'CTR' }),
      el('th', { className: 'num', textContent: '取りこぼし' }),
    ),
  );
  table.querySelector('tbody').replaceChildren(
    ...rows.map((r) =>
      el('tr', {},
        el('td', { textContent: r.query, title: r.query }),
        el('td', { className: 'num', textContent: fmtPos(r.position) }),
        el('td', { className: 'num', textContent: `${fmtPct(r.ctr)}（平均 ${fmtPct(r.avgCtr)}）` }),
        el('td', { className: 'num', textContent: `≈${fmtInt(r.lostClicks)}`, title: '平均どおりの CTR なら得られたはずのクリック数' }),
      ),
    ),
  );
}

function renderSearchPostTable(posts) {
  const rows = posts
    .filter((p) => p.searchImpressions)
    .sort((a, b) => b.searchImpressions - a.searchImpressions)
    .slice(0, 15);
  // 投稿単位の数字は Instagram のプロパティにしか無いので、対象の切り替えとは別であることを書いておく
  $('#search-post-sub').textContent = `Instagram のプロパティの投稿データ・検索表示が多い順の上位${rows.length}件`;
  const table = $('#search-post-table');
  table.querySelector('thead').replaceChildren(
    el('tr', {},
      el('th', { textContent: '投稿' }),
      el('th', { className: 'num', textContent: '検索表示' }),
      el('th', { className: 'num', textContent: '検索クリック' }),
      el('th', { className: 'num', textContent: '検索順位' }),
      el('th', { className: 'num', textContent: 'リーチ' }),
    ),
  );
  table.querySelector('tbody').replaceChildren(
    ...rows.map((p) => {
      const cap = el('span', { className: 'cap', textContent: firstLine(p.caption).slice(0, 48) });
      return el('tr', {},
        el('td', {}, p.permalink ? el('a', { href: p.permalink, target: '_blank', rel: 'noopener noreferrer' }, cap) : cap),
        el('td', { className: 'num', textContent: fmtInt(p.searchImpressions) }),
        el('td', { className: 'num', textContent: fmtInt(p.searchClicks) }),
        el('td', { className: 'num', textContent: fmtPos(p.searchPosition) }),
        el('td', { className: 'num', textContent: fmtInt(p.reach) }),
      );
    }),
  );
}

function renderTraffic(v) {
  const t = v.traffic;
  $('#traffic-block').hidden = !t;
  if (!t) return;

  const b = t.breakdown;
  const weeks = t.joined.length;
  // GA4 が無く Search Console だけのときは、GA4 専用のカードを隠して相関だけを出す
  $('#traffic-block').querySelector('h2').textContent = t.hasGA4 ? 'HPへの流入（GA4）' : '投稿と Google 検索の相関';
  $('#c-traffic-weeks').closest('article').hidden = !t.hasGA4;
  $('#traffic-summary-card').hidden = !t.hasGA4;
  $('#c-traffic-account').closest('article').hidden = !t.hasGA4;
  $('#traffic-lead').textContent = t.hasGA4
    ? `Instagram から HP への流入を週単位で見ています。${t.properties.length ? `対象プロパティ: ${t.properties.join('・')}。` : ''}` +
      `GA4 側 ${t.gaOnlyWeeks.length}週、うち投稿データと突き合わせできたのは ${weeks}週です。`
    : `GA4 を取り込んでいないため、Search Console の週次データと投稿を突き合わせています（検索側 ${t.scWeeks.length}週、うち突き合わせできたのは ${weeks}週）。`;
  if (!t.hasGA4) {
    $('#campaign-card').hidden = true;
    $('#landing-card').hidden = true;
    return;
  }

  // 週ごとの積み上げ
  const rows = t.gaOnlyWeeks.map((w) => ({ label: w.week.slice(5).replace('-', '/'), values: w }));
  const series = [{ key: 'organic', label: 'オーガニック' }];
  if (b.totals.paid > 0) series.push({ key: 'paid', label: '広告' });
  if (!setEmpty('c-traffic-weeks', !rows.length)) charts.stackedBars('c-traffic-weeks', rows, series);

  // 合計
  const pct = (a, bb) => (bb ? `${((a / bb) * 100).toFixed(1)}%` : '–');
  const stats = [
    ['Instagram 流入', `${fmtInt(b.totals.sessions)} セッション`],
    ['　うちオーガニック', `${fmtInt(b.totals.organic)}（${pct(b.totals.organic, b.totals.sessions)}）`],
    ['　うち広告', `${fmtInt(b.totals.paid)}（${pct(b.totals.paid, b.totals.sessions)}）`],
    ['ユーザー', fmtInt(b.totals.users)],
    ['新規ユーザー', `${fmtInt(b.totals.newUsers)}（${pct(b.totals.newUsers, b.totals.users)}）`],
    ['予約タップ', fmtInt(b.totals.reserveTaps)],
    ['予約タップ率（オーガニック）', b.organicTapRate === null ? '–' : `${b.organicTapRate.toFixed(2)}%`],
    ['予約タップ率（広告）', b.paidTapRate === null ? '–' : `${b.paidTapRate.toFixed(2)}%`],
    ['CV', fmtInt(b.totals.cv)],
  ];
  $('#traffic-summary').replaceChildren(
    ...stats.flatMap(([k, val]) => [el('dt', { textContent: k }), el('dd', { textContent: val })]),
  );

  // アカウント別
  const accRows = b.accounts.filter((a) => a.name).slice(0, 8).map((a) => ({
    label: a.name,
    value: a.sessions,
    sub: `全体の ${pct(a.sessions, b.totals.sessions)}`,
  }));
  if (!setEmpty('c-traffic-account', !accRows.length)) charts.hBar('c-traffic-account', accRows, { name: 'セッション' });

  // UTM キャンペーン別
  $('#campaign-card').hidden = !t.campaigns.length;
  if (t.campaigns.length) {
    $('#campaign-table tbody').replaceChildren(
      ...t.campaigns.slice(0, 25).map((c) => {
        const tr = document.createElement('tr');
        tr.insertCell().textContent = c.name;
        [fmtInt(c.sessions), fmtInt(c.users), fmtInt(c.taps), c.sessions ? `${((c.taps / c.sessions) * 100).toFixed(1)}%` : '–'].forEach((x) => {
          const td = tr.insertCell();
          td.className = 'num';
          td.textContent = x;
        });
        return tr;
      }),
    );
  }

  // リンククリックの到達率
  const land = t.landing;
  $('#landing-card').hidden = !land;
  if (land) {
    const tbody = $('#landing-table tbody');
    tbody.replaceChildren(
      ...land.rows.map((r) => {
        const tr = document.createElement('tr');
        tr.insertCell().textContent = fmtDate(r.week);
        [fmtInt(r.clicks), fmtInt(r.sessions), r.clicks ? `${((r.sessions / r.clicks) * 100).toFixed(1)}%` : '–'].forEach((x) => {
          const td = tr.insertCell();
          td.className = 'num';
          td.textContent = x;
        });
        return tr;
      }),
      (() => {
        const tr = el('tr', { className: 'total-row' });
        tr.insertCell().textContent = '合計';
        [fmtInt(land.clicks), fmtInt(land.sessions), land.rate === null ? '–' : `${land.rate.toFixed(1)}%`].forEach((x) => {
          const td = tr.insertCell();
          td.className = 'num';
          td.textContent = x;
        });
        return tr;
      })(),
    );
    $('#landing-note').textContent =
      land.rate !== null && land.rate < 60
        ? `リンククリックの ${(100 - land.rate).toFixed(0)}% は GA4 で計測できていません。プロフィールのリンク先が LINE や外部予約システムなど計測対象外になっているか、UTM が付いていない可能性があります。`
        : 'Instagram 上のクリック数と GA4 の流入は概ね一致しています。';
  }
}

/** 相関表の共通描画。「投稿と行動」「投稿と流入」で同じ見た目にする */
function renderCorrTable({ ids, table, weeks, target, targets, label, note, hint = '', cols = 9 }) {
  const targetSel = $(ids.target);
  const targetSig = targets.map((x) => x.key).join('|');
  if (targetSel.dataset.sig !== targetSig) {
    targetSel.dataset.sig = targetSig;
    targetSel.replaceChildren(...targets.map((x) => el('option', { value: x.key, textContent: `${x.label} との相関` })));
  }
  targetSel.value = target;
  $(ids.sub).textContent = `週ごとの「投稿側の指標」と「${label}」の関係。n=${weeks}週`;

  const tbody = $(`${ids.table} tbody`);
  if (!table.length) {
    tbody.replaceChildren(el('tr', {}, el('td', { colSpan: cols, textContent: ids.empty })));
    // 表が出せないときこそ「なぜ選べないか」が必要なので、注記は残す
    $(ids.note).textContent = hint;
    return false;
  }

  const num = (x, digits = 2) => (x === null || x === undefined || Number.isNaN(x) ? '–' : (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(digits));
  const sorted = [...table].sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  tbody.replaceChildren(
    ...sorted.map((c) => {
      const tr = document.createElement('tr');
      tr.insertCell().textContent = c.label;
      const cells = [
        { v: num(c.r), cls: Math.abs(c.r) >= 0.4 ? (c.r > 0 ? 'lift-up' : 'lift-down') : '' },
        { v: num(c.rho) },
        { v: c.p === null ? '–' : c.p.toFixed(3), cls: c.significant ? 'lift-up' : '' },
        { v: c.ci ? `${num(c.ci[0])} 〜 ${num(c.ci[1])}` : '–' },
        { v: num(c.partial) },
        { v: num(c.deltaR) },
      ];
      for (const cell of cells) {
        const td = tr.insertCell();
        td.className = `num ${cell.cls || ''}`.trim();
        td.textContent = cell.v;
      }
      tr.insertCell().textContent = readCorrelation(c);
      const est = tr.insertCell();
      est.className = 'num';
      est.textContent = describeEstimate(c, target);
      return tr;
    }),
  );
  $(ids.note).textContent = note + hint;
  return true;
}

/**
 * 選べない相手があるときに、なぜ出ないかを伝える。
 * GA4 を Instagram だけに絞って書き出していると、自然検索・検索広告は入ってこない。
 */
const TARGET_HINTS = {
  organic: 'GA4（Instagram からの流入）',
  sessions: 'GA4（Instagram からの流入）',
  searchOrganic: 'GA4 のチャネル別の書き出し（Organic Search）',
  searchAds: 'GA4 のチャネル別の書き出し（Paid Search）',
  organicTaps: 'GA4（予約タップのイベント）',
  searchImpressions: 'Search Console の書き出し',
  brandedClicks: 'Search Console の書き出し（サイトのプロパティ）',
};

function missingTargetNote(t) {
  const missing = TARGETS.filter((x) => !t.targets.some((y) => y.key === x.key));
  if (!missing.length) return '';
  return `　※ ${missing.map((m) => `「${m.label}」`).join('')}はデータが無いため選べません（必要なデータ：${[...new Set(missing.map((m) => TARGET_HINTS[m.key]))].join('／')}）。`;
}

const CORR_NOTE =
  'r は −1〜+1 の相関の強さ。p 値が 0.05 未満なら「偶然とは考えにくい」目安です。' +
  '「時期の影響を除いた r」は週の順番を差し引いた値、「増減どうしの r」は前の週からの変化どうしの相関で、' +
  'どちらも元の r より大きく下がる場合は、両方が同時期に伸びただけの見かけの相関を疑ってください。' +
  '相関は因果ではありません。';

/**
 * 行動側で選べない相手があるときに、何を取り込めば使えるかを伝える。
 * 黙って選択肢から消えると「実装されていない」ように見えてしまうため。
 */
const ACTION_TARGET_HINTS = {
  accountNonFollowerReach: 'リーチ内訳の書き出し（非フォロワー比率の1行サマリー）。日次の実数が無くても、比率から推定して使えます',
  keepActions: '投稿データ（保存・シェア）',
  profileVisits: '日次のプロフィールアクセス（Visits.csv など）',
  newFollows: '日次のフォロー（Follows.csv など）',
};

function missingActionNote(a) {
  const missing = ACTION_TARGETS.filter((t) => !a.targets.some((x) => x.key === t.key));
  if (!missing.length) return '';
  return `　※ ${missing.map((m) => `「${m.label}」`).join('')}はデータが無いため選べません（必要なデータ：${missing.map((m) => ACTION_TARGET_HINTS[m.key]).join('／')}）。`;
}

/** 投稿と行動（保存・プロフィールアクセス・フォロー）の相関 */
function renderActionCorrelation(v) {
  const a = v.actions;
  const card = $('#action-correlation-card');
  card.hidden = !a.targets.length;
  if (card.hidden) return;
  // 非フォロワーへのリーチは、実数が無ければリーチ内訳の比率から推定している。
  // 他のグラフと同じように（推定）と付けて、実測と区別できるようにする
  const estimated = v.nonFollowerEstimated;
  const withMark = (t) =>
    estimated && t.key === 'accountNonFollowerReach' ? { ...t, label: `${t.label}（推定）` } : t;

  renderCorrTable({
    ids: {
      target: '#action-corr-target', sub: '#action-corr-sub', table: '#action-corr-table', note: '#action-corr-note',
      empty: '相関を出すには、投稿データが3週以上必要です。',
    },
    table: a.table,
    weeks: a.weeks.length,
    target: a.target,
    targets: a.targets.map(withMark),
    label: withMark(ACTION_TARGETS.find((x) => x.key === a.target) ?? {}).label ?? '',
    note: `${CORR_NOTE}「推定値」は、投稿側の指標が増えたときに行動がどれだけ増えるかの目安です。`,
    hint: missingActionNote(a),
  });
}

/** 相関表と散布図（投稿と HP への流入） */
function renderCorrelation(v) {
  const t = v.traffic;
  const label = TARGETS.find((x) => x.key === t.target)?.label ?? '';
  const ok = renderCorrTable({
    ids: {
      target: '#corr-target', sub: '#corr-sub', table: '#corr-table', note: '#corr-note',
      empty: '相関を出すには、投稿データと GA4（または Search Console）が重なる週が3週以上必要です。',
    },
    table: t.table,
    weeks: t.joined.length,
    target: t.target,
    targets: t.targets,
    label,
    note: `${CORR_NOTE}「推定値」は週ごとの値から引いた回帰直線の傾きで、投稿側の指標が増えたときに増える流入（獲得数）の目安です。有意でない指標は（参考）としています。`,
    hint: missingTargetNote(t),
  });

  // 指名キーワードを選んでいるときだけ、語の設定を出す
  const brandRow = $('#brand-terms-row');
  brandRow.hidden = t.target !== 'brandedClicks';
  if (!brandRow.hidden) {
    const b = v.search.brand || {};
    const input = $('#brand-terms');
    if (document.activeElement !== input) input.value = (b.terms || []).join(', ');
    $('#brand-terms-note').textContent = b.matched
      ? `「${(b.terms || []).join('・')}」を含む検索語 ${b.matched}件・${fmtInt(b.clicks)}クリック（全体の ${fmtPct((b.share ?? 0) * 100, 1)}）。日次はこの割合で按分した推定値です。`
      : '当てはまる検索語がありません。実際に検索されている語に合わせて書き換えてください。';
  }

  if (!ok) {
    setEmpty('c-scatter', true, 'データが足りません');
    return;
  }

  const driverSel = $('#scatter-driver');
  const usable = t.table.map((x) => x.key);
  const sig = usable.join('|');
  if (driverSel.dataset.sig !== sig) {
    driverSel.dataset.sig = sig;
    driverSel.replaceChildren(...DRIVERS.filter((d) => usable.includes(d.key)).map((d) => el('option', { value: d.key, textContent: d.label })));
  }
  if (usable.includes(t.driverKey)) driverSel.value = t.driverKey;

  const num = (x, digits = 2) => (x === null || x === undefined || Number.isNaN(x) ? '–' : (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(digits));
  if (t.scatter && !setEmpty('c-scatter', t.scatter.points.length < 3)) {
    const d = DRIVERS.find((x) => x.key === t.driverKey);
    charts.scatter('c-scatter', t.scatter.points, t.scatter.fit, { xLabel: d?.label ?? '', yLabel: label });
    const c = t.table.find((x) => x.key === t.driverKey);
    $('#scatter-sub').textContent = c
      ? `点＝1週間（n=${c.n}）・r=${num(c.r)}・p=${c.p.toFixed(3)}。直線は傾向を示すだけで、因果ではありません`
      : '点＝1週間。直線は傾向を示すだけで、因果ではありません';
  }
}

/** フォロワーの内訳（年齢×性別・国・都市）。期間ではなく「現在の構成」を表す */
function renderAudience(v) {
  const a = v.audience;
  const show = !!a && (a.ageGender.length || a.countries.length || a.cities.length);
  $('#audience-block').hidden = !show;
  if (!show) return;

  const lead = ['Meta の「オーディエンス」エクスポートから読み取った、現在のフォロワーの構成です（期間の切り替えには連動しません）。'];
  if (a.followersTotal) lead.unshift(`フォロワー ${fmtInt(a.followersTotal)}人。`);
  if (a.topGender && a.topAge) lead.push(`中心は ${a.topGender.label}・${a.topAge.age}歳（${fmtPct(a.topAge.value, 1)}）です。`);
  $('#audience-lead').textContent = lead.join('');

  $('#age-card').hidden = !a.ageGender.length;
  if (a.ageGender.length) {
    const rows = a.ageGender.map((r) => ({ label: `${r.age}歳`, values: r }));
    if (!setEmpty('c-age', false)) charts.groupedHBar('c-age', rows, a.series, { unit: '%' });
  }

  const pieces = [
    ['#country-card', 'c-country', a.countries, '国'],
    ['#city-card', 'c-city', a.cities, '都市'],
  ];
  for (const [card, canvas, rows, name] of pieces) {
    $(card).hidden = !rows.length;
    if (!rows.length) continue;
    const data = rows.slice(0, 10).map((r) => ({ label: r.name, value: +r.value.toFixed(2), sub: `フォロワー全体の ${fmtPct(r.value, 1)}` }));
    if (!setEmpty(canvas, false)) charts.hBar(canvas, data, { unit: '%', name: `${name}別の割合` });
  }
}

function renderEngagementCharts(v) {
  $('#er-def').textContent =
    state.settings.basis === 'reach'
      ? 'ER ＝（いいね＋コメント＋保存＋シェア）÷ リーチ × 100'
      : 'ER ＝（いいね＋コメント＋保存＋シェア）÷ 投稿時点のフォロワー数 × 100';
  const typeMeta = TYPE_ORDER.map((type) => ({ type, label: TYPE_LABELS[type] }));
  if (!setEmpty('c-er', !v.posts.some((p) => p.er !== null))) charts.erScatter('c-er', v.posts, weeklyER(v.posts), typeMeta);

  const rows = v.types
    .filter((t) => t.er !== null)
    .map((t) => ({
      label: t.label,
      value: +t.er.toFixed(3),
      sub: `${t.n}投稿 ・ 平均リーチ ${fmtInt(t.reach)} ・ 平均保存 ${t.saves.toFixed(1)}`,
    }));
  if (!setEmpty('c-type', !rows.length)) charts.hBar('c-type', rows, { unit: '%', name: '平均ER' });
}

function renderTopPosts(v) {
  const select = $('#top-metric');
  if (!select.options.length) {
    for (const [key, m] of Object.entries(METRICS)) select.append(el('option', { value: key, textContent: `${m.label}順` }));
  }
  // 以前選べた並べ替え（非フォロワーのリーチ順など）が保存されていたら ER 順に戻す
  if (!METRICS[state.settings.topMetric]) state.settings.topMetric = 'er';
  select.value = state.settings.topMetric;
  const metric = METRICS[state.settings.topMetric];
  const top = topPosts(v.posts, state.settings.topMetric, 10);
  const rows = top.map((p) => {
    const d = jstParts(p.timestamp);
    const text = firstLine(p.caption);
    return {
      label: `${d.month}/${d.day} ${text.length > 12 ? `${text.slice(0, 12)}…` : text}`,
      title: `${fmtDateTime(p.timestamp)} ・ ${TYPE_LABELS[p.type]}`,
      value: metric.unit === '%' ? +metric.get(p).toFixed(3) : metric.get(p),
      sub: [text.slice(0, 40), `ER ${fmtPct(p.er)} ・ リーチ ${fmtInt(p.reach)} ・ 反応 ${fmtInt(p.interactions)}`],
      permalink: p.permalink,
    };
  });
  if (!setEmpty('c-top', !rows.length))
    charts.hBar('c-top', rows, {
      unit: metric.unit,
      name: metric.label,
      onClick: (r) => r.permalink && window.open(r.permalink, '_blank', 'noopener'),
    });
}

function filteredPosts() {
  const q = state.search.trim().toLowerCase();
  const hit = (p) => `${p.caption} ${p.account} ${p.accountName}`.toLowerCase().includes(q);
  const list = q ? state.view.posts.filter(hit) : [...state.view.posts];
  const { key, dir } = state.settings.sort;
  const val = (p) => (key === 'type' ? TYPE_LABELS[p.type] : p[key]);
  list.sort((a, b) => {
    const x = val(a);
    const y = val(b);
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
    return dir === 'asc' ? c : -c;
  });
  return list;
}

function renderPostsTable() {
  const list = filteredPosts();
  const maxER = Math.max(0, ...list.map((p) => p.er ?? 0));
  const snapIdx = state.view.historyIdx;
  const multiAccount = !state.view.account && state.view.accounts.length > 1;
  // データに無い列は見出しごと隠す
  const hasCol = {
    views: list.some((p) => p.views !== null),
    nonFollowerReach: list.some((p) => p.nonFollowerReach !== null && p.nonFollowerReach !== undefined),
    follows: list.some((p) => p.follows !== null),
    // ソーシャルインサイトの投稿インサイトにだけある指標
    profileVisits: list.some((p) => p.profileVisits !== null && p.profileVisits !== undefined),
    avgWatchSec: list.some((p) => p.avgWatchSec !== null && p.avgWatchSec !== undefined),
    // Search Console を取り込んだときだけ出す列
    searchImpressions: list.some((p) => p.searchImpressions !== null && p.searchImpressions !== undefined),
    searchClicks: list.some((p) => p.searchClicks !== null && p.searchClicks !== undefined),
    searchPosition: list.some((p) => p.searchPosition !== null && p.searchPosition !== undefined),
  };
  for (const [key, on] of Object.entries(hasCol)) {
    $$(`#posts-table .col-${key}`).forEach((th) => (th.hidden = !on));
  }
  $('#posts-count').textContent = `${list.length}件${state.search ? `（「${state.search}」で絞り込み）` : ''}`;

  // 推移データの溜まり具合（毎日取り込むほど「詳細を見る」で見える範囲が増える）
  const hs = state.view.historyStatus;
  $('#history-status').textContent = hs.days
    ? `推移データ：${fmtDate(hs.first)} 〜 ${fmtDate(hs.last)} の${hs.days}回分（${hs.posts}投稿）・「詳細を見る」で投稿後の伸びを確認できます`
    : 'データを日次で取り込むと、投稿ごとのいいね・保存の伸びを「詳細を見る」で追えるようになります';
  $$('#posts-table th[data-sort]').forEach((th) => {
    th.setAttribute('aria-sort', th.dataset.sort === state.settings.sort.key ? (state.settings.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
  });

  const tbody = $('#posts-table tbody');
  const frag = document.createDocumentFragment();
  for (const p of list.slice(0, 500)) {
    const tr = document.createElement('tr');
    tr.insertCell().textContent = fmtDateTime(p.timestamp);
    tr.insertCell().append(el('span', { className: 'type-tag' }, el('i', { className: p.type }), TYPE_LABELS[p.type]));

    const thumb = p.thumbnail
      ? el('img', { className: 'thumb', src: p.thumbnail, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' })
      : el('span', { className: 'thumb', textContent: TYPE_LABELS[p.type].slice(0, 2) });
    if (p.thumbnail) thumb.addEventListener('error', () => thumb.replaceWith(el('span', { className: 'thumb', textContent: TYPE_LABELS[p.type].slice(0, 2) })));
    const cap = el('span', { className: 'cap', textContent: p.caption.replace(/\s+/g, ' ').slice(0, 120) || '（キャプションなし）' });
    const content = p.permalink ? el('a', { href: p.permalink, target: '_blank', rel: 'noopener noreferrer' }, cap) : cap;
    const body = el('div', { className: 'post-body' }, content);
    // 複数アカウントを一度に見ているときは、どちらの投稿か分かるようにする
    if (multiAccount && p.account) body.prepend(el('span', { className: 'acct-tag', textContent: `@${p.account}` }));
    tr.insertCell().append(el('div', { className: 'post-cell' }, thumb, body));

    for (const k of ['views', 'reach', 'nonFollowerReach', 'likes', 'comments', 'saves', 'shares', 'follows', 'profileVisits', 'avgWatchSec', 'interactions', 'searchImpressions', 'searchClicks', 'searchPosition']) {
      const td = tr.insertCell();
      td.className = `num${k in hasCol ? ` col-${k}` : ''}`;
      td.hidden = k in hasCol && !hasCol[k];
      // 推定値には ≈ を付けて実数と区別する
      if (k === 'nonFollowerReach' && p.nonFollowerEstimated) {
        td.textContent = `≈${fmtInt(p[k])}`;
        td.title = 'リーチ × 非フォロワー比率による推定値';
      } else if (k === 'avgWatchSec') {
        td.textContent = p[k] === null || p[k] === undefined ? '–' : `${p[k].toFixed(1)}秒`;
      } else if (k === 'searchPosition') {
        // 掲載順位は小さいほど上位。整数に丸めると 1.2位 と 1.8位 の差が消えるので小数で出す
        td.textContent = p[k] === null || p[k] === undefined ? '–' : `${p[k].toFixed(1)}位`;
      } else td.textContent = fmtInt(p[k]);
    }
    const erTd = tr.insertCell();
    erTd.className = 'num';
    if (p.er !== null) {
      const bar = el('span', { className: 'er-bar' });
      bar.style.width = `${Math.max(2, (p.er / maxER) * 48)}px`;
      erTd.append(bar, fmtPct(p.er));
    } else erTd.textContent = '–';

    // 日次で取り込んだスナップショットの本数。2回分以上あると推移が線になる
    const snaps = snapIdx.get(p.id)?.count || 0;
    const btn = el('button', {
      className: 'btn ghost detail',
      type: 'button',
      textContent: '詳細を見る',
      title:
        snaps >= 2
          ? `${snaps}回分のデータで推移を表示`
          : snaps === 1
            ? '取り込みは1回分だけです。別の日にもう一度取り込むと推移が出ます'
            : 'この投稿の推移データはまだありません',
    });
    btn.dataset.post = p.id;
    const detail = tr.insertCell();
    detail.className = 'col-detail';
    detail.append(btn);
    frag.append(tr);
  }
  tbody.replaceChildren(frag);
}

// ---------- 投稿ごとの推移（「詳細を見る」で開くダイアログ） ----------

/** グラフの色。指標チップの色見本と線の色を必ず一致させる */
function postSeriesColors() {
  const t = charts.tokens();
  return [t.s1, t.s2, t.s3, t.neg];
}

function openPostDialog(id) {
  if (!(state.view?.all || []).some((p) => p.id === id)) return;
  state.openPost = id;
  const dlg = $('#post-dialog');
  // グラフは canvas に大きさが付いてから描く必要があるので、表示してから描画する
  if (!dlg.open) dlg.showModal();
  renderPostHistory();
}

function renderPostHistory() {
  const id = state.openPost;
  const post = (state.view?.all || []).find((p) => p.id === id);
  if (!post) return;
  const line = postTimeline(state.view.postHistory, post);

  // --- 見出し（サムネイル・投稿日時・キャプション） ---
  const thumb = post.thumbnail
    ? el('img', { className: 'thumb', src: post.thumbnail, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' })
    : el('span', { className: 'thumb', textContent: TYPE_LABELS[post.type].slice(0, 2) });
  const cap = el('span', { className: 'cap', textContent: firstLine(post.caption).slice(0, 140) });
  $('#post-dlg-head').replaceChildren(
    thumb,
    el(
      'div',
      { className: 'meta' },
      post.permalink ? el('a', { href: post.permalink, target: '_blank', rel: 'noopener noreferrer' }, cap) : cap,
      el('p', {
        className: 'sub',
        textContent: `${fmtDateTime(post.timestamp)} ・ ${TYPE_LABELS[post.type]}${post.account ? ` ・ @${post.account}` : ''}`,
      }),
    ),
  );

  // --- 現在の合計（集計で使っている値そのもの） ---
  const totals = HISTORY_METRICS.filter((m) => post[m.key] !== null && post[m.key] !== undefined).map((m) =>
    el('div', {}, el('dt', { textContent: m.label }), el('dd', { textContent: fmtInt(post[m.key]) })),
  );
  $('#post-dlg-totals').replaceChildren(...totals);

  // --- 指標の選択（データのある指標だけ出す） ---
  const available = HISTORY_METRICS.filter((m) => line.some((r) => r[m.key] !== null));
  let picked = state.settings.postMetrics.filter((k) => available.some((m) => m.key === k));
  if (!picked.length) picked = available.slice(0, 2).map((m) => m.key);
  const palette = postSeriesColors();
  const colorOf = (key) => palette[picked.indexOf(key) % palette.length];
  $('#post-dlg-metrics').replaceChildren(
    ...available.map((m) => {
      const on = picked.includes(m.key);
      const swatch = el('span', { className: 'key' });
      swatch.style.background = on ? colorOf(m.key) : 'var(--axis)';
      const b = el('button', { type: 'button' }, swatch, m.label);
      b.dataset.metric = m.key;
      b.setAttribute('aria-pressed', String(on));
      return b;
    }),
  );
  $$('#post-dlg-mode button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === state.settings.postMode)));

  // --- 取り込み状況の説明 ---
  const note = $('#post-dlg-note');
  note.className = 'status';
  if (!line.length) {
    note.textContent = 'この投稿の推移データはまだありません。CSV を取り込むと、その時点の数字が記録されます。';
  } else if (line.length === 1) {
    note.className = 'status warn';
    note.textContent = `取り込みは ${fmtDate(line[0].date)} の1回分だけです。別の日にもう一度取り込むと、いいね・保存の伸びが線になります。`;
  } else {
    note.textContent = `${fmtDate(line[0].date)} 〜 ${fmtDate(line.at(-1).date)} の ${line.length}回分の取り込みから作成（投稿${line.at(-1).day !== null ? ` ${line.at(-1).day}日後まで` : ''}）`;
  }

  // --- グラフ ---
  const delta = state.settings.postMode === 'delta';
  const rows = line.map((r) => {
    const out = { date: r.date };
    for (const k of picked) out[k] = delta ? r[`d_${k}`] : r[k];
    return out;
  });
  const series = picked.map((k) => ({ key: k, label: HISTORY_LABELS[k], color: colorOf(k), sameAxis: false }));
  const plottable = rows.filter((r) => picked.some((k) => r[k] !== null));
  // 線にするには点が2つ必要。増加は1回目が出せないので、累計より1回分多く取り込みが要る
  const needMsg = !line.length
    ? '推移データがありません'
    : delta
      ? '増加のグラフには3回分以上の取り込みが必要です'
      : 'グラフには2回分以上の取り込みが必要です';
  if (!setEmpty('c-post-history', plottable.length < 2, needMsg)) {
    charts.multiLine('c-post-history', rows, series);
  }

  renderPostHistoryTable(line, picked, delta);
}

function renderPostHistoryTable(line, picked, delta) {
  const table = $('#post-history-table');
  table.querySelector('thead').replaceChildren(
    el(
      'tr',
      {},
      el('th', { textContent: '取り込み日' }),
      el('th', { className: 'num', textContent: '経過' }),
      ...picked.map((k) => el('th', { className: 'num', textContent: HISTORY_LABELS[k] })),
    ),
  );
  const body = line.map((r) =>
    el(
      'tr',
      {},
      el('td', { textContent: fmtDate(r.date) }),
      el('td', { className: 'num', textContent: r.day === null ? '–' : `${r.day}日目` }),
      ...picked.map((k) => {
        const td = el('td', { className: 'num' });
        const d = r[`d_${k}`];
        if (delta) {
          td.textContent = d === null ? '–' : d > 0 ? `+${fmtInt(d)}` : fmtInt(d);
        } else {
          td.append(fmtInt(r[k]));
          // 累計のとなりに前回からの増加を小さく添える（伸びた日だけ）
          if (d !== null && d > 0) td.append(el('span', { className: 'delta up', textContent: `+${fmtInt(d)}` }));
        }
        return td;
      }),
    ),
  );
  table.querySelector('tbody').replaceChildren(...body);
}

function exportPostHistoryCSV() {
  const post = (state.view?.all || []).find((p) => p.id === state.openPost);
  if (!post) return;
  const line = postTimeline(state.view.postHistory, post);
  if (!line.length) return toast('この投稿の推移データはまだありません');
  const columns = [
    { label: '取り込み日', get: (r) => r.date },
    { label: '経過日数', get: (r) => r.day ?? '' },
    ...HISTORY_METRICS.flatMap((m) => [
      { label: `${m.label}（累計）`, get: (r) => r[m.key] ?? '' },
      { label: `${m.label}（増加）`, get: (r) => r[`d_${m.key}`] ?? '' },
    ]),
  ];
  download(`post-history_${post.id}_${line.at(-1).date}.csv`, toCSV(line, columns), 'text/csv;charset=utf-8');
}

function renderTiming(v) {
  const best = bestSlots(v.heatmap, { top: 3 });
  const cont = $('#heatmap');
  if (v.posts.some((p) => p.er !== null)) charts.renderHeatmap(cont, v.heatmap, best, WEEKDAYS, $('#tooltip'));
  else cont.replaceChildren(el('p', { className: 'sub', textContent: 'この期間の投稿データがありません' }));

  const list = $('#best-slots');
  const slots = bestSlots(v.heatmap, { top: 5 });
  if (!slots.length) {
    list.replaceChildren(el('li', { className: 'none', textContent: '同じ曜日・時間帯に2件以上の投稿がまだありません。期間を広げてください。' }));
  } else {
    list.replaceChildren(
      ...slots.map((c, i) =>
        el(
          'li',
          {},
          el('span', { className: 'rank', textContent: String(i + 1) }),
          el('div', {}, el('div', { className: 'when', textContent: `${WEEKDAYS[c.weekday]}曜 ${c.startHour}:00〜${c.endHour}:00` }), el('div', { className: 'meta', textContent: `${c.n}投稿 ・ 全体平均比 ${c.mean >= v.heatmap.overall ? '+' : '−'}${Math.abs((c.mean / v.heatmap.overall - 1) * 100).toFixed(0)}%` })),
          el('span', { className: 'val', textContent: fmtPct(c.mean) }),
        ),
      ),
    );
  }

  const topIdx = (rows, n) =>
    rows
      .map((r, i) => ({ i, r }))
      .filter(({ r }) => r.n >= 2 && r.mean !== null)
      .sort((a, b) => b.r.mean - a.r.mean)
      .slice(0, n)
      .map(({ i }) => i);

  const hourRows = v.hours.map((h) => ({ label: `${h.key}`, title: `${h.key}:00〜${h.key}:59`, value: h.mean === null ? null : +h.mean.toFixed(3), sub: h.n ? `${h.n}投稿` : '' }));
  if (!setEmpty('c-hour', !v.hours.some((h) => h.n))) charts.vBar('c-hour', hourRows, { unit: '%', name: '平均ER', highlight: topIdx(v.hours, 3) });

  const wdRows = v.weekdays.map((w) => ({ label: WEEKDAYS[w.key], title: `${WEEKDAYS[w.key]}曜日`, value: w.mean === null ? null : +w.mean.toFixed(3), sub: w.n ? `${w.n}投稿` : '' }));
  if (!setEmpty('c-weekday', !v.weekdays.some((w) => w.n))) charts.vBar('c-weekday', wdRows, { unit: '%', name: '平均ER', highlight: topIdx(v.weekdays, 2) });
}

function renderHashtags(v) {
  const tbody = $('#hashtag-table tbody');
  if (!v.hashtags.length) {
    tbody.replaceChildren(el('tr', {}, el('td', { colSpan: 5, textContent: '2回以上使われたハッシュタグがありません' })));
    return;
  }
  tbody.replaceChildren(
    ...v.hashtags.slice(0, 40).map((h) => {
      const tr = document.createElement('tr');
      tr.insertCell().textContent = h.tag;
      const cells = [fmtInt(h.n), fmtPct(h.er), null, fmtInt(h.reach)];
      cells.forEach((c, i) => {
        const td = tr.insertCell();
        td.className = 'num';
        if (i === 2) {
          if (h.lift === null) td.textContent = '–';
          else {
            td.className = `num ${h.lift >= 0 ? 'lift-up' : 'lift-down'}`;
            td.textContent = `${h.lift >= 0 ? '▲ +' : '▼ −'}${Math.abs(h.lift).toFixed(0)}%`;
          }
        } else td.textContent = c;
      });
      return tr;
    }),
  );
}

// ---------- 「表で見る」切り替え ----------

function setupTableToggles() {
  for (const card of $$('.card[data-chart], .card[data-heatmap]')) {
    const header = card.querySelector('header');
    let actions = header.querySelector('.card-actions');
    if (!actions) {
      actions = el('div', { className: 'card-actions' });
      // 既存のコントロール（指標選択など）もアクション領域へまとめる
      [...header.children].slice(1).forEach((c) => actions.append(c));
      header.append(actions);
    }
    const btn = el('button', { type: 'button', className: 'btn ghost view-toggle', textContent: '表で見る' });
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => {
      const key = card.dataset.chart || 'heatmap';
      if (state.tableViews.has(key)) state.tableViews.delete(key);
      else state.tableViews.add(key);
      refreshTableViews();
    });
    actions.append(btn);
  }
}

function heatmapTable() {
  const t = el('table', { className: 'data-table' });
  const head = t.createTHead().insertRow();
  ['曜日', '時間帯', '投稿数', '平均ER', '補正スコア'].forEach((h) => head.append(el('th', { textContent: h })));
  const body = t.createTBody();
  for (const c of state.view.heatmap.cells) {
    if (!c.n) continue;
    const r = body.insertRow();
    [WEEKDAYS[c.weekday], `${c.startHour}〜${c.endHour}時`, c.n, fmtPct(c.mean), fmtPct(c.score)].forEach((v) => (r.insertCell().textContent = v));
  }
  return t;
}

function refreshTableViews() {
  for (const card of $$('.card[data-chart], .card[data-heatmap]')) {
    const key = card.dataset.chart || 'heatmap';
    const on = state.tableViews.has(key);
    const btn = card.querySelector('.view-toggle');
    btn.textContent = on ? 'グラフで見る' : '表で見る';
    btn.setAttribute('aria-pressed', String(on));
    const visual = key === 'heatmap' ? [$('#heatmap'), card.querySelector('.scale')] : [card.querySelector('.chart')];
    visual.forEach((n) => (n.hidden = on));
    card.querySelector('.chart-table')?.remove();
    if (!on) continue;
    let table;
    if (key === 'heatmap') table = heatmapTable();
    else {
      const chart = charts.getChart(key);
      table = chart ? charts.chartTable(chart) : el('p', { className: 'sub', textContent: 'データがありません' });
    }
    card.append(el('div', { className: 'chart-table' }, table));
  }
}

// ---------- データ読み込み ----------

function setDataset(ds, message) {
  state.dataset = ds;
  if (!store.saveDataset(ds)) toast('ブラウザの保存容量が不足しているため、データは再読み込みで消えます');
  render();
  if (message) toast(message);
}

/**
 * 複数ファイルをまとめて取り込む。1ファイルが読めなくても残りは取り込み、最後にまとめて報告する。
 * Meta のエクスポートは指標ごとにファイルが分かれているため、日次データは日付単位でマージする。
 */
async function handleCSVFiles(files) {
  const status = $('#csv-status');
  status.className = 'status';
  const merge = $('#csv-merge').checked && state.dataset && state.dataset.source !== 'demo';
  let posts = merge ? state.dataset.posts || [] : [];
  let daily = merge ? state.dataset.daily || [] : [];
  let audience = merge ? state.dataset.audience || null : null;
  let ga4 = merge ? state.dataset.ga4 || [] : [];
  let ga4Channels = merge ? state.dataset.ga4Channels || [] : [];
  let reachBreakdown = merge ? state.dataset.reachBreakdown || [] : [];
  let hashtags = merge ? state.dataset.hashtags || [] : [];
  let followed = merge ? state.dataset.followed || [] : [];
  let accountDaily = merge ? state.dataset.accountDaily || [] : [];
  let stories = merge ? state.dataset.stories || [] : [];
  let tagged = merge ? state.dataset.tagged || [] : [];
  // 投稿ごとの日次スナップショット（投稿後のいいね・保存の伸びを追うため）。
  // 取り込み直すときも履歴は残す：過去の時点の数字は他のどこからも復元できない
  let postHistory = state.dataset?.postHistory || [];
  let searchConsole = merge ? state.dataset.searchConsole || [] : [];
  let contentFormats = merge ? state.dataset.contentFormats || null : null;
  // ZIP を使わず CSV を 1 枚ずつ読み込んだとき用（プロパティごとにまとめ直す）
  const looseSearch = new Map();
  // 投稿・日次を含まない補助データ（リーチ内訳・ハッシュタグ分析・フォロー中アカウント）だけの取り込みか
  let sideFiles = 0;
  const done = [];
  const failed = [];
  const notes = [];

  for (const f of files) {
    try {
      const buffer = await f.arrayBuffer();
      // Search Console の書き出し（ZIP）。1つの ZIP が 1 プロパティぶん
      if (/\.zip$/i.test(f.name)) {
        const res = await readSearchConsoleZip(buffer, f.name);
        if (!res) throw new Error('Search Console の書き出し（クエリ.csv などが入った ZIP）ではありません');
        searchConsole = mergeSearchConsole(searchConsole, [res.property]);
        sideFiles++;
        done.push(`${f.name}: ${describeSearchConsole(res.property, res.read)}`);
        continue;
      }
      if (isXlsxName(f.name)) {
        // Excel は GA4 の流入データとして読む
        const sheets = await readWorkbook(buffer);
        const res = importGA4Workbook(sheets, { property: propertyFromFileName(f.name) });
        if (!res) throw new Error('「日付・参照元/メディア・セッション」または「週開始・チャネル・セッション」の列がある表が見つかりませんでした');
        ga4 = mergeGA4(ga4, res.rows);
        if (res.channels?.length) ga4Channels = mergeGA4Channels(ga4Channels, res.channels);
        done.push(`${f.name}: GA4 流入 ${res.rows.length}行（${res.sheets.join('・')}）`);
        continue;
      }

      const text = decodeCSV(buffer);
      if (looksGarbled(text)) {
        throw new Error(
          '文字化けしているため読み込めません。BOM の無い UTF-8 の CSV を Excel で開いて保存すると、日本語やカンマが壊れます。' +
            '元のファイルを読み込み直すか、メモ帳などで「UTF-8（BOM 付き）」として保存し直してください。',
        );
      }
      // リーチのフォロワー／非フォロワー内訳（期間の集計）
      const mix = readReachBreakdown(parseCSV(text));
      if (mix) {
        reachBreakdown = mergeReachBreakdown(reachBreakdown, mix);
        sideFiles++;
        done.push(`${f.name}: リーチ内訳 ${mix.length}件（${describeBreakdowns(mix).join('・')}）`);
        continue;
      }
      // ソーシャルインサイトの書き出し（投稿一覧・ハッシュタグ分析・フォロー中アカウント一覧）
      const si = readSocialInsight(parseCSV(text), { fileName: f.name });
      if (si) {
        // 書き出しの期間末をその数字の「時点」として履歴に積む（過去分をまとめて取り込んでも順番が狂わない）
        if (si.posts.length) postHistory = mergeHistory(postHistory, snapshotPosts(si.posts, snapshotDate(si)));
        if (si.posts.length) posts = store.mergePosts(posts, si.posts);
        if (si.daily.length) daily = store.mergeDaily(daily, si.daily);
        if (si.summary.length) accountDaily = mergeSummary(accountDaily, si.summary);
        if (si.stories.length) stories = mergeStories(stories, si.stories);
        if (si.tagged.length) tagged = mergeTagged(tagged, si.tagged);
        if (si.hashtags.length) hashtags = mergeHashtags(hashtags, si.hashtags);
        if (si.followed.length) followed = mergeFollowed(followed, si.followed);
        if (!si.posts.length && !si.daily.length) sideFiles++;
        done.push(`${f.name}: ${describeSocialInsight(si)}`);
        continue;
      }
      // Search Console の CSV を 1 枚ずつ読み込んだ場合。
      // Meta のオーディエンス（国別）と列の形が似ているので、importCSV より先に判別する
      const sc = readSearchConsoleCSV(parseCSV(text), { fileName: f.name, folder: folderOf(f) });
      if (sc) {
        const key = sc.property?.id || folderOf(f) || '__unknown__';
        if (!looseSearch.has(key)) looseSearch.set(key, { meta: sc.property, tables: [] });
        const slot = looseSearch.get(key);
        if (!slot.meta && sc.property) slot.meta = sc.property;
        slot.tables.push(sc.table);
        sideFiles++;
        const what = sc.table.kind === 'filter' ? '抽出条件' : `${sc.table.label} ${sc.table.rows.length}件`;
        done.push(`${f.name}: Search Console／${sc.property?.label || 'プロパティ不明'} ${what}`);
        continue;
      }
      // まず GA4 の CSV かどうかを見る（Instagram の CSV とは列が違う）
      const ga = readGA4Table(parseCSV(text));
      if (ga) {
        const rows = ga.rows.map((r) => ({ ...r, property: propertyFromFileName(f.name) }));
        ga4 = mergeGA4(ga4, rows);
        done.push(`${f.name}: GA4 流入 ${rows.length}行`);
        continue;
      }

      const res = importCSV(text, { fileName: f.name });
      // Meta の書き出しには期間が入らないので、取り込んだ日を時点として扱う
      if (res.posts.length) postHistory = mergeHistory(postHistory, snapshotPosts(res.posts, snapshotDate({})));
      if (res.posts.length) posts = store.mergePosts(posts, res.posts);
      if (res.daily.length) daily = store.mergeDaily(daily, res.daily);
      if (res.audience) audience = store.mergeAudience(audience, res.audience);
      if (res.contentFormats) {
        contentFormats = mergeContentFormats(contentFormats, res.contentFormats);
        // 形式別の内訳だけのファイル（日付も投稿も無い）は補助データとして扱う
        if (!res.posts.length && !res.daily.length && !res.audience) sideFiles++;
      }
      notes.push(...res.notes);
      done.push(`${f.name}: ${describeImport(res)}`);
    } catch (e) {
      failed.push(`${f.name}: ${e.message}`);
    }
  }

  // 1 枚ずつ読み込んだ Search Console の表を、プロパティごとにまとめる
  if (looseSearch.size) {
    searchConsole = mergeSearchConsole(
      searchConsole,
      [...looseSearch.values()].map((s) => buildProperty(s.meta, s.tables)),
    );
    if ([...looseSearch.values()].some((s) => !s.meta)) {
      notes.push('Search Console の CSV は、どのプロパティのものか判別できませんでした。ZIP のまま読み込むとプロパティごとに分かれます。');
    }
  }

  if (!done.length) {
    status.className = 'status error';
    status.textContent = `読み込みに失敗しました。${failed.join(' / ')}`;
    return;
  }

  // 補助データだけを読み込んだときは、表示中のデータ（デモを含む）に追加する
  if (sideFiles === done.length && state.dataset) {
    setDataset(
      {
        ...state.dataset,
        reachBreakdown: mergeReachBreakdown(state.dataset.reachBreakdown || [], reachBreakdown),
        hashtags: mergeHashtags(state.dataset.hashtags || [], hashtags),
        followed: mergeFollowed(state.dataset.followed || [], followed),
        accountDaily: mergeSummary(state.dataset.accountDaily || [], accountDaily),
        stories: mergeStories(state.dataset.stories || [], stories),
        tagged: mergeTagged(state.dataset.tagged || [], tagged),
        postHistory: state.dataset.postHistory || [],
        searchConsole: mergeSearchConsole(state.dataset.searchConsole || [], searchConsole),
        contentFormats: mergeContentFormats(state.dataset.contentFormats, contentFormats),
        ga4Channels: mergeGA4Channels(state.dataset.ga4Channels || [], ga4Channels),
      },
      '補助データ（リーチ内訳・ハッシュタグ分析など）を取り込みました',
    );
    status.replaceChildren(el('span', { textContent: done.join(' / ') }), ...failed.map((x) => el('span', { className: 'note error', textContent: `読めませんでした → ${x}` })));
    return;
  }

  const normalized = normalizeDaily(anchorFollowers(daily, audience));
  const lastF = audience?.followersTotal ?? normalized.findLast((d) => d.followers !== null)?.followers ?? null;
  setDataset(
    {
      source: merge && state.dataset.source !== 'demo' ? state.dataset.source : 'csv',
      account: { ...(merge ? state.dataset.account : {}), username: merge ? state.dataset.account?.username : '', followersCount: lastF },
      daily,
      posts,
      audience,
      ga4,
      ga4Channels,
      reachBreakdown,
      hashtags,
      followed,
      accountDaily,
      stories,
      tagged,
      // 投稿一覧から消えた投稿の履歴は捨て、保存容量に収まる分だけ残す
      postHistory: pruneHistory(postHistory, posts),
      searchConsole,
      contentFormats,
      followerMode: detectFollowerMode(normalized),
      fetchedAt: new Date().toISOString(),
    },
    failed.length ? `${done.length}件を取り込み、${failed.length}件は読めませんでした` : '取り込みが完了しました',
  );
  if (failed.length) status.className = 'status warn';
  status.replaceChildren(
    el('span', { textContent: done.join(' / ') }),
    ...[...new Set(notes)].map((n) => el('span', { className: 'note', textContent: n })),
    ...failed.map((f) => el('span', { className: 'note error', textContent: `読めませんでした → ${f}` })),
  );
}

async function handleAPISubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const f = Object.fromEntries(new FormData(form));
  const status = $('#api-status');
  const submit = form.querySelector('[type=submit]');
  status.className = 'status';
  submit.disabled = true;
  const opts = {
    token: f.token,
    host: f.host,
    userId: f.userId || 'me',
    version: f.version || 'v23.0',
    postLimit: Math.max(5, Math.min(500, Number(f.postLimit) || 50)),
  };
  state.settings.api = { host: opts.host, userId: opts.userId, version: opts.version, postLimit: opts.postLimit, token: f.remember ? opts.token : undefined, remember: !!f.remember };
  persistSettings();
  try {
    const { dataset, warnings } = await fetchFromGraph(opts, (msg) => (status.textContent = msg));
    // 取得した時点の数字を、投稿ごとのスナップショットとして残す
    const snapshot = snapshotPosts(dataset.posts, snapshotDate({}));
    // 同じアカウントなら過去の取得分とマージして履歴を積み上げる（API は日次データを30日分しか返さないため）
    const prev = state.dataset;
    if (prev?.source === 'api' && prev.account?.username === dataset.account.username) {
      dataset.daily = store.mergeDaily(prev.daily, dataset.daily);
      dataset.posts = store.mergePosts(prev.posts, dataset.posts);
    }
    dataset.postHistory = pruneHistory(mergeHistory(prev?.postHistory || [], snapshot), dataset.posts);
    // CSV で取り込んだ GA4・リーチ内訳・ソーシャルインサイトの補助データは、API で取り直しても残す
    if (prev?.ga4?.length) dataset.ga4 = prev.ga4;
    if (prev?.ga4Channels?.length) dataset.ga4Channels = prev.ga4Channels;
    if (prev?.reachBreakdown?.length) dataset.reachBreakdown = prev.reachBreakdown;
    if (prev?.hashtags?.length) dataset.hashtags = prev.hashtags;
    if (prev?.followed?.length) dataset.followed = prev.followed;
    if (prev?.accountDaily?.length) dataset.accountDaily = prev.accountDaily;
    if (prev?.stories?.length) dataset.stories = prev.stories;
    if (prev?.tagged?.length) dataset.tagged = prev.tagged;
    if (prev?.searchConsole?.length) dataset.searchConsole = prev.searchConsole;
    if (prev?.contentFormats) dataset.contentFormats = prev.contentFormats;
    dataset.warnings = warnings;
    setDataset(dataset, `@${dataset.account.username} のデータを取得しました`);
    status.textContent = `完了：投稿 ${dataset.posts.length}件 ・ 日次 ${dataset.daily.length}日分`;
    $('#data-dialog').close();
  } catch (err) {
    status.className = 'status error';
    status.textContent = `取得に失敗しました: ${err.message}`;
  } finally {
    submit.disabled = false;
  }
}

async function handleFindIG() {
  const form = $('#api-form');
  const status = $('#api-status');
  status.className = 'status';
  try {
    if (form.host.value !== 'facebook') {
      form.userId.value = 'me';
      status.textContent = 'Instagram ログインでは「me」で自分のアカウントを指定できます。';
      return;
    }
    status.textContent = 'ビジネスアカウントを検索中…';
    const client = new GraphClient({ token: form.token.value, host: 'facebook', version: form.version.value || 'v23.0' });
    const accounts = await client.findInstagramAccounts();
    if (!accounts.length) throw new Error('Facebook ページに接続された Instagram ビジネスアカウントが見つかりません');
    form.userId.value = accounts[0].id;
    status.textContent = accounts.map((a) => `@${a.username}（${a.page}）: ${a.id}`).join(' / ');
  } catch (err) {
    status.className = 'status error';
    status.textContent = err.message;
  }
}

// ---------- レポート出力 ----------

/** 表示中の期間・絞り込みの内容を、すべての数値と分析を含む1ファイルに書き出す */
function exportReport(format) {
  if (!state.view) return toast('出力するデータがありません');
  const generatedAt = new Date();
  const report = buildReport(state.view, {
    dataset: state.dataset,
    settings: state.settings,
    warnings: warningMessages(state.view),
    generatedAt,
  });
  if (format === 'docx') download(`${report.fileBase}.docx`, toDocx(report, generatedAt), DOCX_MIME);
  else download(`${report.fileBase}.md`, toMarkdown(report), 'text/markdown;charset=utf-8');
  toast('レポートを出力しました');
}

function setExportMenu(open) {
  $('#export-list').hidden = !open;
  $('#export-toggle').setAttribute('aria-expanded', String(open));
}

// ---------- ダイアログ ----------

function openDialog(tab = 'api') {
  const dlg = $('#data-dialog');
  selectTab(tab);
  const api = state.settings.api || {};
  const form = $('#api-form');
  form.host.value = api.host || 'instagram';
  form.userId.value = api.userId || '';
  form.version.value = api.version || 'v23.0';
  form.postLimit.value = api.postLimit || 50;
  form.remember.checked = !!api.remember;
  if (api.token) form.token.value = api.token;
  dlg.showModal();
}

function selectTab(name) {
  $$('#data-dialog [role=tab]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  $$('#data-dialog .tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== name));
}

// ---------- イベント ----------

function bindEvents() {
  $('#theme-toggle').addEventListener('click', toggleTheme);
  media.addEventListener('change', () => {
    resolveTheme();
    render();
  });
  $('#export-toggle').addEventListener('click', () => setExportMenu($('#export-list').hidden));
  $('#export-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-export]');
    if (!b) return;
    setExportMenu(false);
    try {
      exportReport(b.dataset.export);
    } catch (err) {
      toast(`レポートを出力できませんでした: ${err.message}`);
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#export-menu')) setExportMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#export-list').hidden) {
      setExportMenu(false);
      $('#export-toggle').focus();
    }
  });
  $('#open-data').addEventListener('click', () => openDialog(state.dataset?.source === 'csv' ? 'csv' : 'api'));
  $$('[data-open-tab]').forEach((b) => b.addEventListener('click', () => openDialog(b.dataset.openTab)));
  $$('#data-dialog [role=tab]').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));

  // 推移ページ
  $('#trend-unit').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-unit]');
    if (!b) return;
    state.settings.trendUnit = b.dataset.unit;
    persistSettings();
    render();
  });
  $('#trend-metric').addEventListener('change', (e) => {
    state.trend = e.target.value;
    history.replaceState(null, '', `?trend=${encodeURIComponent(state.trend)}`);
    render();
  });
  $('#trend-csv').addEventListener('click', exportTrendCSV);
  // 元のタブでデータや設定（ER の基準・アカウント）が変わったら、推移ページにも反映する
  window.addEventListener('storage', () => {
    if (!state.trend) return;
    state.dataset = store.loadDataset();
    state.settings = { ...DEFAULTS, ...store.loadSettings() };
    render();
  });

  const loadDemo = () => {
    setDataset(generateDemo(), 'デモデータを読み込みました');
    $('#data-dialog').close();
  };
  $('#empty-demo').addEventListener('click', loadDemo);
  $('#load-demo').addEventListener('click', loadDemo);

  $('#range').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-days]');
    if (!b) return;
    state.settings.days = Number(b.dataset.days);
    persistSettings();
    render();
  });
  $('#er-basis').addEventListener('change', (e) => {
    state.settings.basis = e.target.value;
    persistSettings();
    render();
  });
  $('#account-filter').addEventListener('change', (e) => {
    state.settings.account = e.target.value;
    persistSettings();
    render();
  });
  // KPI ツリー
  $('#kpi-edit').addEventListener('click', () => {
    state.kpiEdit = !state.kpiEdit;
    renderKpiTable(state.view.kpi.rows);
  });
  $('#kpi-table').addEventListener('change', (e) => {
    const input = e.target.closest('input[data-kpi]');
    if (!input) return;
    const { kpi: key, field } = input.dataset;
    const value = Number(input.value);
    if (!Number.isFinite(value)) return;
    const goals = { ...state.settings.kpiGoals, [key]: { ...(state.settings.kpiGoals[key] || {}), [field]: value } };
    state.settings.kpiGoals = goals;
    persistSettings();
    render();
  });
  $('#export-kpi').addEventListener('click', () => {
    const rows = state.view?.kpi?.rows || [];
    if (!rows.length) return toast('書き出せる KPI がありません');
    const n = (r, v) => (v === null || v === undefined ? '' : r.unit === '%' ? v.toFixed(r.digits ?? 1) : Math.round(v));
    const cols = [
      { label: '区分', get: (r) => KPI_STAGE_LABELS[r.stage] || r.stage },
      { label: '指標', get: (r) => r.label },
      { label: '定義', get: (r) => r.def },
      { label: '期間の実績', get: (r) => n(r, r.raw) },
      { label: '月あたりの実績', get: (r) => n(r, r.monthly) },
      { label: '基準（月あたり）', get: (r) => n(r, r.baseline) },
      { label: '目標（月あたり）', get: (r) => n(r, r.target) },
      { label: '単位', get: (r) => r.unit || '件' },
      { label: '達成率(%)', get: (r) => (r.progress === null ? '' : Math.round(r.progress)) },
      { label: '状態', get: (r) => KPI_STATUS_LABELS[r.status] },
      { label: '取得元', get: (r) => r.source },
    ];
    download(`kpi_${state.view.startKey}_${state.view.endKey}.csv`, toCSV(rows, cols), 'text/csv');
  });

  // Google 検索（Search Console）
  $('#search-scope').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-scope]');
    if (!b || b.disabled) return;
    state.settings.searchScope = b.dataset.scope;
    persistSettings();
    render();
  });
  $('#search-sort').addEventListener('change', (e) => {
    state.settings.searchSort = e.target.value;
    persistSettings();
    render();
  });
  $('#export-search').addEventListener('click', () => {
    const rows = state.view?.search?.queries || [];
    if (!rows.length) return toast('書き出せる検索クエリがありません');
    const cols = [
      { label: '検索語', get: (r) => r.query },
      { label: 'クリック数', get: (r) => r.clicks },
      { label: '表示回数', get: (r) => r.impressions },
      { label: 'CTR(%)', get: (r) => (r.ctr === null ? '' : r.ctr.toFixed(2)) },
      { label: '掲載順位', get: (r) => (r.position === null ? '' : r.position.toFixed(2)) },
    ];
    download(`search_console_queries_${state.view.search.scope}.csv`, toCSV(rows, cols), 'text/csv');
  });

  $('#action-corr-target').addEventListener('change', (e) => {
    state.settings.actionTarget = e.target.value;
    persistSettings();
    render();
  });
  $('#brand-terms').addEventListener('change', (e) => {
    // 空にすると自動推測に戻る
    state.settings.brandTerms = e.target.value.split(/[,、]/).map((x) => x.trim()).filter(Boolean);
    persistSettings();
    render();
  });
  $('#corr-target').addEventListener('change', (e) => {
    state.settings.corrTarget = e.target.value;
    persistSettings();
    render();
  });
  $('#scatter-driver').addEventListener('change', (e) => {
    state.settings.scatterDriver = e.target.value;
    persistSettings();
    render();
  });
  $('#top-metric').addEventListener('change', (e) => {
    state.settings.topMetric = e.target.value;
    persistSettings();
    renderTopPosts(state.view);
    refreshTableViews();
  });

  $('#post-search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderPostsTable();
  });

  // 投稿ごとの推移ダイアログ
  $('#posts-table tbody').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-post]');
    if (b) openPostDialog(b.dataset.post);
  });
  $('#post-dlg-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    state.settings.postMode = b.dataset.mode;
    persistSettings();
    renderPostHistory();
  });
  $('#post-dlg-metrics').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-metric]');
    if (!b) return;
    const key = b.dataset.metric;
    // 画面に出ているチップの状態から作る（データの無い指標が残っていても食い違わない）
    const on = $$('#post-dlg-metrics button[aria-pressed="true"]').map((x) => x.dataset.metric);
    const next = on.includes(key) ? on.filter((k) => k !== key) : [...on, key];
    if (!next.length) return toast('指標は1つ以上選んでください');
    // 並びを指標の定義順にそろえて、選び直しても色が入れ替わらないようにする
    const order = (k) => HISTORY_METRICS.findIndex((m) => m.key === k);
    state.settings.postMetrics = next.sort((a, b2) => order(a) - order(b2));
    persistSettings();
    renderPostHistory();
  });
  $('#post-dlg-csv').addEventListener('click', exportPostHistoryCSV);
  $('#post-dialog').addEventListener('close', () => {
    state.openPost = null;
    charts.getChart('c-post-history')?.destroy();
  });
  $$('#posts-table th[data-sort]').forEach((th) =>
    th.addEventListener('click', () => {
      const s = state.settings.sort;
      state.settings.sort = s.key === th.dataset.sort ? { key: s.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: th.dataset.sort, dir: 'desc' };
      persistSettings();
      renderPostsTable();
    }),
  );
  $('#export-posts').addEventListener('click', () => {
    const cols = [
      { label: '投稿日時', get: (p) => fmtDateTime(p.timestamp) },
      { label: 'アカウント', get: (p) => p.account },
      { label: 'タイプ', get: (p) => TYPE_LABELS[p.type] },
      { label: 'キャプション', get: (p) => p.caption },
      { label: 'ビュー', get: (p) => p.views },
      { label: 'リーチ', get: (p) => p.reach },
      { label: 'フォロワー以外へのリーチ', get: (p) => p.nonFollowerReach },
      { label: 'フォロワー以外へのリーチは推定', get: (p) => (p.nonFollowerEstimated ? '推定' : '') },
      { label: 'いいね', get: (p) => p.likes },
      { label: 'コメント', get: (p) => p.comments },
      { label: '保存', get: (p) => p.saves },
      { label: 'シェア', get: (p) => p.shares },
      { label: 'この投稿からのフォロー', get: (p) => p.follows },
      { label: '反応数合計', get: (p) => p.interactions },
      { label: 'エンゲージメント率(%)', get: (p) => (p.er === null ? '' : p.er.toFixed(2)) },
      { label: 'URL', get: (p) => p.permalink },
    ];
    download(`instagram_posts_${state.view.startKey}_${state.view.endKey}.csv`, toCSV(filteredPosts(), cols), 'text/csv');
  });

  // ソーシャルインサイトのハッシュタグ分析：見る書き出し・期間の切り替え
  $('#tool-hashtag-set').addEventListener('change', (e) => {
    state.settings.hashtagSet = e.target.value;
    persistSettings();
    render();
  });

  $('#export-stories').addEventListener('click', () => {
    const cols = [
      { label: '投稿日時', get: (s) => fmtDateTime(s.timestamp) },
      { label: '種別', get: (s) => (s.type === 'VIDEO' ? '動画' : '画像') },
      { label: 'テキスト', get: (s) => s.caption },
      { label: '閲覧数', get: (s) => s.views },
      { label: '閲覧率(%)', get: (s) => s.viewRate },
      { label: 'リーチ', get: (s) => s.reach },
      { label: '離脱', get: (s) => s.exits },
      { label: '次へ', get: (s) => s.tapsForward },
      { label: '戻る', get: (s) => s.tapsBack },
      { label: '次のアカウントへ', get: (s) => s.swipeForward },
      { label: '返信', get: (s) => s.replies },
      { label: 'フォロー', get: (s) => s.follows },
      { label: 'プロフィール遷移', get: (s) => s.profileVisits },
      { label: 'リンククリック', get: (s) => s.linkClicks },
      { label: 'URL', get: (s) => s.permalink },
    ];
    download(`instagram_stories_${state.view.startKey}_${state.view.endKey}.csv`, toCSV(state.view.si.stories, cols), 'text/csv');
  });

  $('#export-followed').addEventListener('click', () => {
    const cols = [
      { label: 'ユーザーネーム', get: (f) => f.username },
      { label: 'ユーザーID', get: (f) => f.userId },
      { label: 'プロフィール', get: (f) => f.profile },
      { label: 'フォロワー数', get: (f) => f.followers },
      { label: '投稿数', get: (f) => f.posts },
      { label: 'フォロー数', get: (f) => f.follows },
      { label: 'よく使うハッシュタグ', get: (f) => (f.hashtags || []).map((t) => `#${t}`).join(' ') },
      { label: 'URL', get: (f) => f.url },
    ];
    download('instagram_followed_accounts.csv', toCSV(state.view.si.followed, cols), 'text/csv');
  });

  $('#export-tagged').addEventListener('click', () => {
    const cols = [
      { label: '投稿日時', get: (t) => fmtDateTime(t.timestamp) },
      { label: 'アカウント', get: (t) => t.account },
      { label: 'タイプ', get: (t) => t.type },
      { label: 'キャプション', get: (t) => t.caption },
      { label: 'いいね', get: (t) => t.likes },
      { label: 'コメント', get: (t) => t.comments },
      { label: 'URL', get: (t) => t.permalink },
    ];
    download(`instagram_tagged_${state.view.startKey}_${state.view.endKey}.csv`, toCSV(state.view.si.tagged.list, cols), 'text/csv');
  });

  $('#api-form').addEventListener('submit', handleAPISubmit);
  $('#find-ig').addEventListener('click', handleFindIG);

  const input = $('#csv-input');
  input.addEventListener('change', () => input.files.length && handleCSVFiles([...input.files]).finally(() => (input.value = '')));
  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer.files.length) handleCSVFiles([...e.dataTransfer.files]);
  });

  $('#export-json').addEventListener('click', () => {
    if (!state.dataset) return toast('バックアップするデータがありません');
    download(`instagram_insights_backup_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state.dataset), 'application/json');
  });
  $('#import-json').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const ds = JSON.parse(await file.text());
      if (!Array.isArray(ds.posts) || !Array.isArray(ds.daily)) throw new Error('形式が正しくありません');
      setDataset(ds, 'バックアップから復元しました');
      $('#data-dialog').close();
    } catch (err) {
      toast(`復元に失敗しました: ${err.message}`);
    }
    e.target.value = '';
  });
  $('#load-shared').addEventListener('click', () => loadSharedData({ silent: false }));
  $('#empty-shared').addEventListener('click', () => loadSharedData({ silent: false }));
  $('#clear-data').addEventListener('click', () => {
    if (!confirm('保存されているデータとアクセストークンを削除します。よろしいですか？')) return;
    store.clearDataset();
    delete state.settings.api;
    persistSettings();
    $('#api-form').reset();
    state.dataset = null;
    $('#data-dialog').close();
    render();
    toast('削除しました');
  });
}

/**
 * サーバーに data.json を置いておくと、どの端末からでも同じデータで開ける。
 * 取り込んだあと「データをバックアップ（JSON）」で書き出したファイルを
 * data.json という名前で index.html と同じ場所に置くだけ。
 * 置いていなければ 404 になるだけで、動作には影響しない。
 */
async function loadSharedData({ silent = true } = {}) {
  try {
    // index.html と同じ場所を見る（サブフォルダに置いても動く）
    const res = await fetch(new URL('data.json', location.href), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`サーバーに data.json がありません（${res.status}）`);
    const ds = await res.json();
    if (!Array.isArray(ds.posts) || !Array.isArray(ds.daily)) throw new Error('data.json の形式が正しくありません');
    setDataset(ds, 'サーバーの共有データを読み込みました');
    return true;
  } catch (e) {
    if (!silent) toast(`共有データを読み込めませんでした: ${e.message}`);
    return false;
  }
}

resolveTheme();
setupTableToggles();
bindEvents();
// ?demo を付けて開くとデモデータを読み込む（動作確認用）
if (new URLSearchParams(location.search).has('demo')) state.dataset = generateDemo();
render();
// このブラウザにデータが無ければ、サーバーに置かれた共有データを読む（無ければ何も起きない）
if (!state.dataset && location.protocol !== 'file:') loadSharedData();
