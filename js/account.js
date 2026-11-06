// アカウント全体の内訳とベンチマークの集計（DOM に依存しない純粋関数のみ）。
// ソーシャルインサイトの日次インサイト・ハッシュタグ分析・フォロー中アカウント・タグ付き投稿を使う。
import { jstDateKey, mean, median } from './analytics.js';

/** 面（どこで見られたか）。日次インサイトの内訳列に対応する */
export const SURFACES = [
  { key: 'feed', label: 'フィード', views: 'viewsFeed', reach: 'reachFeed', interactions: 'interactionsFeed' },
  { key: 'reels', label: 'リール', views: 'viewsReels', reach: 'reachReels', interactions: 'interactionsReels' },
  { key: 'stories', label: 'ストーリーズ', views: 'viewsStories', reach: 'reachStories', interactions: 'interactionsStories' },
  { key: 'ads', label: '広告', views: 'viewsAds', reach: 'reachAds', interactions: 'interactionsAds' },
  { key: 'other', label: 'その他', views: 'viewsOther', reach: 'reachOther', interactions: 'interactionsOther' },
];

/** プロフィールからのアクション（クリックの種類） */
export const CLICK_KINDS = [
  { key: 'linkClicks', label: 'ウェブサイト' },
  { key: 'callClicks', label: '電話' },
  { key: 'messageClicks', label: 'メッセージ' },
  { key: 'emailClicks', label: 'メール' },
  { key: 'directionClicks', label: '道順' },
  { key: 'otherClicks', label: 'その他' },
];

const values = (rows, key) => rows.map((r) => r[key]).filter((v) => v !== null && v !== undefined);

function total(rows, key) {
  const v = values(rows, key);
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
}

const rate = (a, b) => (a === null || !b ? null : (a / b) * 100);

/**
 * ソーシャルインサイトのファイル名のラベル（例「ミセルクリニック大阪」）やアカウント名から、ユーザーネームを引く関数を作る。
 * ファイル名のラベルにはユーザーネームが入らないため、
 * 日次インサイト（ラベル＋アカウント名）と投稿インサイト・ストーリーズ（アカウント名＋ユーザーネーム）を突き合わせる。
 * 分からなければ null。
 */
export function accountResolver({ posts = [], accountDaily = [], stories = [] } = {}) {
  const users = new Set(posts.map((p) => p.account).filter(Boolean));
  const fullToUser = new Map();
  for (const x of [...posts, ...stories]) if (x.account && x.accountName) fullToUser.set(x.accountName, x.account);
  const labelToUser = new Map();
  for (const r of accountDaily) {
    const u = fullToUser.get(r.accountName);
    if (r.account && u) labelToUser.set(r.account, u);
  }
  return (key) => (!key ? null : users.has(key) ? key : labelToUser.get(key) ?? fullToUser.get(key) ?? null);
}

/**
 * 日次データから、1アカウントぶんを取り出す。
 * ソーシャルインサイトの日次は取り込み時にファイルのラベル（account）を付けてある。
 * 複数アカウントを取り込んでも、日付だけで重ねると別アカウントの数字（フォロワー数など）で上書きされてしまうため、
 * 選んだアカウントのぶんだけを使う。ラベルの無い行（Meta の書き出し・API）は、そのまま土台にする。
 * @returns {{rows:object[], label:?string, others:string[], unresolved:string[]}}
 *          label: 使ったラベル。others: 使わなかったラベル。unresolved: どのアカウントか分からず使わなかったラベル
 */
export function pickAccountDaily(rows = [], { resolve = () => null, account = '' } = {}) {
  const base = rows.filter((r) => !r.account);
  const groups = new Map();
  for (const r of rows) {
    if (!r.account) continue;
    if (!groups.has(r.account)) groups.set(r.account, []);
    groups.get(r.account).push(r);
  }
  const labels = [...groups.keys()];
  let label = labels.find((k) => account && resolve(k) === account) ?? null;
  // 1アカウントぶんしか無く、どのアカウントか判別できないときは、それを使う（従来どおり）
  if (!label && labels.length === 1 && !resolve(labels[0])) label = labels[0];
  const unresolved = labels.filter((k) => k !== label && !resolve(k));
  if (!label) return { rows: base, label: null, others: labels, unresolved };

  // ラベルの無い行を土台に、選んだアカウントの値で上書きする（指標ごとにファイルが分かれていても埋まる）
  const byDate = new Map(base.map((r) => [r.date, { ...r }]));
  for (const r of groups.get(label)) {
    const prev = byDate.get(r.date) || {};
    const merged = { ...prev };
    for (const [k, v] of Object.entries(r)) if (k !== 'account' && v !== null && v !== undefined) merged[k] = v;
    byDate.set(r.date, merged);
  }
  return {
    rows: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    label,
    others: labels.filter((k) => k !== label),
    unresolved,
  };
}

/** 日付キーを持つ行（アカウント日次）を期間で絞り込む */
export function sliceByDate(rows = [], startKey = null, endKey = null) {
  return rows
    .filter((r) => r.date && (!startKey || r.date >= startKey) && (!endKey || r.date <= endKey))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 面別（フィード・リール・ストーリーズ…）の閲覧数・リーチ・エンゲージメントの期間合計。
 * 内訳がまったく無い面は返さない（グラフに空の棒を出さないため）。
 */
export function surfaceBreakdown(rows = []) {
  return SURFACES.map((s) => ({
    key: s.key,
    label: s.label,
    values: {
      views: total(rows, s.views),
      reach: total(rows, s.reach),
      interactions: s.interactions ? total(rows, s.interactions) : null,
    },
  })).filter((s) => Object.values(s.values).some((v) => v !== null && v !== 0));
}

/** プロフィールからのアクションの期間合計（多い順）。0 のものは返さない */
export function clickBreakdown(rows = []) {
  return CLICK_KINDS.map((c) => ({ key: c.key, label: c.label, value: total(rows, c.key) }))
    .filter((c) => c.value)
    .sort((a, b) => b.value - a.value);
}

/**
 * リーチのフォロワー／フォロワー以外の内訳と、プロフィールアクセスからのフォロー転換率。
 * 転換率は期間合計から出す（日ごとの率の平均ではアクセスの少ない日に引っ張られる）。
 */
export function accountTotals(rows = []) {
  const profileVisits = total(rows, 'profileVisits');
  const follows = total(rows, 'follows');
  const reach = total(rows, 'reach');
  const followerReach = total(rows, 'followerReach');
  const nonFollowerReach = total(rows, 'nonFollowerReach');
  return {
    days: rows.length,
    reach,
    followerReach,
    nonFollowerReach,
    nonFollowerShare: rate(nonFollowerReach, (followerReach ?? 0) + (nonFollowerReach ?? 0) || null),
    views: total(rows, 'views'),
    viewsFollowers: total(rows, 'viewsFollowers'),
    viewsNonFollowers: total(rows, 'viewsNonFollowers'),
    profileVisits,
    follows,
    unfollows: total(rows, 'unfollows'),
    // フォロワー転換率：プロフィールに来た人のうち、フォローした割合
    conversionRate: rate(follows, profileVisits),
    profileVisitRate: mean(values(rows, 'profileVisitRate')),
    saves: total(rows, 'saves'),
    shares: total(rows, 'shares'),
    replies: total(rows, 'replies'),
  };
}

/**
 * 取り込んだハッシュタグ分析を「書き出しの種類 × 集計期間」ごとにまとめる。
 * 分母の違う指標を混ぜないよう、画面ではこの単位で切り替えて見せる。
 */
export function hashtagSets(hashtags = []) {
  const map = new Map();
  for (const h of hashtags) {
    const key = `${h.account || ''}|${h.source || 'accounts'}|${h.start || ''}|${h.end || ''}`;
    const set = map.get(key) || {
      key,
      account: h.account || '',
      source: h.source || 'accounts',
      erBasis: h.erBasis || 'followers',
      start: h.start || null,
      end: h.end || null,
      rows: [],
    };
    set.rows.push(h);
    map.set(key, set);
  }
  return [...map.values()]
    .map((set) => ({
      ...set,
      label: `${set.source === 'insights' ? 'インサイト' : 'アカウント'}${set.start && set.end ? `／${set.start.replaceAll('-', '/')}〜${set.end.replaceAll('-', '/')}` : ''}`,
      rows: [...set.rows].sort((a, b) => (b.posts ?? 0) - (a.posts ?? 0) || a.tag.localeCompare(b.tag)),
    }))
    .sort(
      (a, b) => String(b.end || '').localeCompare(String(a.end || ''))
        || String(b.start || '').localeCompare(String(a.start || ''))
        || a.source.localeCompare(b.source),
    );
}

/** フォロー中アカウント（ベンチマーク先）のまとめ。よく使うハッシュタグも数える */
export function benchmarkSummary(followed = []) {
  const followers = followed.map((f) => f.followers).filter((v) => v !== null && v !== undefined);
  const counts = new Map();
  for (const f of followed) for (const tag of f.hashtags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
  return {
    n: followed.length,
    followersMedian: median(followers),
    followersMax: followers.length ? Math.max(...followers) : null,
    postsMedian: median(followed.map((f) => f.posts).filter((v) => v !== null && v !== undefined)),
    topHashtags: [...counts.entries()]
      .map(([tag, n]) => ({ tag, n }))
      .sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag))
      .slice(0, 12),
  };
}

/** タグ付き投稿を期間で絞り込む（新しい順）。アカウント別の件数も返す */
export function taggedInPeriod(tagged = [], startKey = null, endKey = null) {
  const list = tagged
    .filter((t) => {
      const key = jstDateKey(t.timestamp);
      return (!startKey || key >= startKey) && (!endKey || key <= endKey);
    })
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const byAccount = new Map();
  for (const t of list) {
    const row = byAccount.get(t.account) || { account: t.account, n: 0, likes: 0, comments: 0 };
    row.n++;
    row.likes += t.likes ?? 0;
    row.comments += t.comments ?? 0;
    byAccount.set(t.account, row);
  }
  return { list, accounts: [...byAccount.values()].sort((a, b) => b.n - a.n) };
}
