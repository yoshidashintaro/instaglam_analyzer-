// Instagram の投稿活動と、GA4 で計測した HP への流入の関係を調べる。
// 投稿は日次、GA4 は日次にも週次にもなり得るので、どちらも「週」に揃えて突き合わせる。
import { addDays, weekdayIndex, parseDateKey, interactions } from './analytics.js';
import { isInstagram, isPaid, accountOf, primaryRows } from './data/ga4.js';
import { correlate, linearRegression, mean } from './stats.js';

/** その日が属する週の月曜日 */
export function weekStart(dateKey) {
  return addDays(dateKey, -weekdayIndex(parseDateKey(dateKey)));
}

/**
 * GA4 の行を週ごとにまとめる。
 * 元データが週次（同じ週に1行）でも日次でも、同じ結果になる。
 */
export function weeklyTraffic(ga4Rows, { rules, fallbackAccount = '' } = {}) {
  const weeks = new Map();
  for (const r of ga4Rows) {
    if (!isInstagram(r.sourceMedium)) continue;
    const w = weekStart(r.date);
    const g =
      weeks.get(w) ||
      {
        week: w,
        sessions: 0, organic: 0, paid: 0,
        users: 0, newUsers: 0, engagedSessions: 0,
        reserveTaps: 0, organicTaps: 0, paidTaps: 0, cv: 0,
        byAccount: {}, bySource: {},
      };
    const paid = isPaid(r.sourceMedium);
    const s = r.sessions || 0;
    const taps = r.reserveTaps || 0;
    g.sessions += s;
    g.reserveTaps += taps;
    g.cv += r.cv || 0;
    if (paid) {
      g.paid += s;
      g.paidTaps += taps;
    } else {
      g.organic += s;
      g.organicTaps += taps;
      g.users += r.users || 0;
      g.newUsers += r.newUsers || 0;
      g.engagedSessions += r.engagedSessions || 0;
    }
    const acct = accountOf(r.sourceMedium, { rules, fallback: fallbackAccount });
    g.byAccount[acct] = (g.byAccount[acct] || 0) + s;
    g.bySource[r.sourceMedium] = (g.bySource[r.sourceMedium] || 0) + s;
    weeks.set(w, g);
  }
  return [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week));
}

/** Instagram 側（投稿とアカウント日次指標）を週ごとにまとめる */
export function weeklyInstagram(posts, daily) {
  const weeks = new Map();
  const blank = (w) => ({
    week: w, posts: 0, reach: 0, views: 0, interactions: 0, saves: 0, shares: 0,
    postFollows: 0, reels: 0, carousels: 0, byAccount: {},
    accountReach: null, accountViews: null, accountNonFollowerReach: null, profileVisits: null, linkClicks: null, accountFollows: null,
  });
  for (const p of posts) {
    const w = weekStart(p.dateKey ?? p.timestamp.slice(0, 10));
    const g = weeks.get(w) || blank(w);
    g.posts++;
    g.reach += p.reach ?? 0;
    g.views += p.views ?? 0;
    g.interactions += p.interactions ?? interactions(p);
    g.saves += p.saves ?? 0;
    g.shares += p.shares ?? 0;
    g.postFollows += p.follows ?? 0;
    if (p.type === 'REELS') g.reels++;
    if (p.type === 'CAROUSEL') g.carousels++;
    if (p.account) {
      const a = (g.byAccount[p.account] = g.byAccount[p.account] || { posts: 0, reach: 0, interactions: 0 });
      a.posts++;
      a.reach += p.reach ?? 0;
      a.interactions += p.interactions ?? interactions(p);
    }
    weeks.set(w, g);
  }
  for (const d of daily) {
    const w = weekStart(d.date);
    const g = weeks.get(w) || blank(w);
    const add = (key, value) => {
      if (value === null || value === undefined) return;
      g[key] = (g[key] ?? 0) + value;
    };
    add('accountReach', d.reach);
    add('accountViews', d.views);
    add('accountNonFollowerReach', d.nonFollowerReach);
    add('profileVisits', d.profileVisits);
    add('linkClicks', d.linkClicks);
    add('accountFollows', d.follows);
    weeks.set(w, g);
  }
  return [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week));
}

/**
 * 両方そろっている週だけを突き合わせる。
 * 期間の端は「週の一部しかない」ため、そのままでは低く出る。dropPartial で落とす。
 */
export function joinWeeks(igWeeks, gaWeeks, { dropPartial = true } = {}) {
  const igMap = new Map(igWeeks.map((w) => [w.week, w]));
  let rows = gaWeeks
    .filter((g) => igMap.has(g.week))
    .map((g) => ({ week: g.week, ig: igMap.get(g.week), ga: g }));
  if (dropPartial && rows.length >= 3) rows = rows.slice(1, -1);
  return rows;
}

/** 相関を出す投稿側の指標 */
// step・unit は推定値の単位（「投稿 +1件」「リーチ +1,000」あたりで、流入が何件増えるか）
export const DRIVERS = [
  { key: 'posts', label: '投稿数', step: 1, unit: '件' },
  { key: 'reels', label: 'リール本数', step: 1, unit: '本' },
  { key: 'reach', label: '投稿リーチ合計', step: 1000, unit: 'リーチ' },
  { key: 'views', label: '投稿ビュー合計', step: 1000, unit: 'ビュー' },
  { key: 'interactions', label: '反応数合計', step: 100, unit: '反応' },
  { key: 'saves', label: '保存合計', step: 10, unit: '保存' },
  { key: 'linkClicks', label: 'リンククリック', step: 10, unit: 'クリック' },
  { key: 'profileVisits', label: 'プロフィールアクセス', step: 100, unit: 'アクセス' },
];

/**
 * 「投稿と行動の相関」で使う投稿側の指標。
 * 行動側（保存・プロフィールアクセス・フォロー）と同じ数字を入れると
 * 自分自身との相関になってしまうので、投稿量と届いた量だけに絞る。
 */
export const ACTION_DRIVERS = [
  { key: 'posts', label: '投稿数', step: 1, unit: '件' },
  { key: 'reels', label: 'リール本数', step: 1, unit: '本' },
  { key: 'carousels', label: 'カルーセル本数', step: 1, unit: '本' },
  { key: 'reach', label: '投稿リーチ合計', step: 1000, unit: 'リーチ' },
  { key: 'views', label: '投稿ビュー合計', step: 1000, unit: 'ビュー' },
  { key: 'accountNonFollowerReach', label: 'フォロワー以外へのリーチ', step: 1000, unit: 'リーチ' },
];

/** 「投稿と行動の相関」の相手（Instagram 内で起きた行動） */
export const ACTION_TARGETS = [
  { key: 'keepActions', label: '保存数＋シェア数', unit: '件' },
  { key: 'profileVisits', label: 'プロフィールアクセス', unit: 'アクセス' },
  { key: 'newFollows', label: '新規フォロー', unit: 'フォロー' },
];

/**
 * 投稿側と行動側を同じ週データから組み立てる。
 * どちらも Instagram のデータなので期間のズレは起きない。
 * 期間の端は週の一部しかないことがあるため、GA4 との突き合わせと同じように落とす。
 */
export function joinActions(igWeeks = [], { dropPartial = true } = {}) {
  let rows = igWeeks.map((w) => ({
    week: w.week,
    ig: w,
    ga: {
      // 保存とシェアは「残す（興味）」の行動としてまとめて見る
      keepActions: w.saves === null && w.shares === null ? null : (w.saves ?? 0) + (w.shares ?? 0),
      profileVisits: w.profileVisits,
      // アカウント全体の新規フォロー。日次が無ければ投稿由来のフォローで代用する
      newFollows: w.accountFollows ?? (w.postFollows || null),
    },
  }));
  if (dropPartial && rows.length >= 3) rows = rows.slice(1, -1);
  return rows;
}

/** その週データで実際に選べる行動側の指標だけを返す */
export function availableActionTargets(rows = []) {
  return ACTION_TARGETS.filter((t) => rows.some((r) => r.ga[t.key] !== null && r.ga[t.key] !== undefined && r.ga[t.key] !== 0));
}

/** 相関の相手（HP 側の指標）。source は必要なデータ源 */
export const TARGETS = [
  { key: 'organic', label: 'HPへの流入（Instagram）', unit: 'セッション', source: 'ga4', def: '広告を除く Instagram 経由のセッション' },
  // 指名検索は、Search Console の日次クリックを「指名の割合」で按分した推定値
  { key: 'brandedClicks', label: 'HPへの流入（指名キーワード）', unit: 'クリック', source: 'sc', estimated: true, def: 'ブランド名を含む検索語からのクリック（日次は指名の割合で按分した推定値）' },
];

/**
 * Search Console の日次を週単位にまとめ、相関の相手として使える形にする。
 * 掲載順位は足せないので、表示回数で重み付けした平均にする。
 */
export function weeklySearch(scDaily = [], { brandedShare = null } = {}) {
  const weeks = new Map();
  for (const r of scDaily) {
    if (!r?.date) continue;
    const w = weekStart(r.date);
    const cur = weeks.get(w) || { week: w, searchClicks: 0, searchImpressions: 0, _w: 0, days: 0 };
    cur.searchClicks += r.clicks ?? 0;
    cur.searchImpressions += r.impressions ?? 0;
    if (r.position !== null && r.position !== undefined && r.impressions) cur._w += r.position * r.impressions;
    cur.days++;
    weeks.set(w, cur);
  }
  return [...weeks.values()]
    .map((r) => ({
      week: r.week,
      searchClicks: r.searchClicks,
      searchImpressions: r.searchImpressions,
      searchPosition: r.searchImpressions && r._w ? r._w / r.searchImpressions : null,
      // 指名キーワードぶん（期間全体の割合で按分した推定値）
      brandedClicks: brandedShare === null ? null : Math.round(r.searchClicks * brandedShare),
      searchDays: r.days,
    }))
    .sort((a, b) => a.week.localeCompare(b.week));
}

/**
 * GA4 の週と Search Console の週を 1 本にまとめる。
 * どちらか片方しか無くても相関を出せるようにするため、週の和集合を返す。
 */
export function mergeTargetWeeks(gaWeeks = [], scWeeks = []) {
  const map = new Map(gaWeeks.map((w) => [w.week, { ...w }]));
  for (const s of scWeeks) {
    const cur = map.get(s.week);
    if (cur) Object.assign(cur, s);
    else map.set(s.week, { ...s });
  }
  return [...map.values()].sort((a, b) => a.week.localeCompare(b.week));
}

/** その週データで実際に選べる相関の相手だけを返す */
export function availableTargets(weeks = []) {
  return TARGETS.filter((t) => weeks.some((w) => w[t.key] !== null && w[t.key] !== undefined));
}

/**
 * 投稿指標 × HP 流入の相関表。
 * 週番号を制御した偏相関と、前週差分の相関も一緒に出して、
 * 「どちらも右肩上がりなだけ」の見かけの相関を見分けられるようにする。
 */
export function correlationTable(joined, { target = 'organic', drivers = DRIVERS } = {}) {
  if (joined.length < 3) return [];
  const trend = joined.map((_, i) => i);
  const y = joined.map((r) => r.ga[target] ?? 0);
  return drivers.map((d) => {
    const x = joined.map((r) => r.ig[d.key] ?? 0);
    const usable = x.some((v) => v !== 0);
    // 推定値：回帰直線の傾き × 単位（投稿 +1件で流入が何セッション増えるか）
    const fit = usable ? linearRegression(x, y) : null;
    const estimate = fit ? fit.slope * d.step : null;
    return { ...d, target, x, y, estimate, ...(usable ? correlate(x, y, { trend }) : { n: joined.length, r: null }) };
  }).filter((d) => d.r !== null);
}

/** 今週の投稿が翌週の流入に効いているか */
export function laggedCorrelation(joined, { target = 'organic', lag = 1, drivers = DRIVERS } = {}) {
  if (joined.length < lag + 3) return [];
  const y = joined.map((r) => r.ga[target] ?? 0).slice(lag);
  return drivers.map((d) => {
    const x = joined.map((r) => r.ig[d.key] ?? 0).slice(0, -lag);
    if (!x.some((v) => v !== 0)) return null;
    return { ...d, lag, ...correlate(x, y) };
  }).filter(Boolean);
}

/**
 * Instagram が数えたリンククリックのうち、GA4 で実際に着地が計測できた割合。
 * 大きく下回る場合、リンク先が計測対象外（LINE・予約システムなど）か、計測漏れが疑われる。
 */
export function landingRate(joined, { account = '' } = {}) {
  // GA4 の無い週（Search Console だけの週）は到達率を出せないので外す
  const rows = joined.filter((r) => (r.ig.linkClicks ?? 0) > 0 && r.ga.byAccount);
  if (!rows.length) return null;
  const clicks = rows.reduce((s, r) => s + r.ig.linkClicks, 0);
  const sessions = rows.reduce((s, r) => s + (account ? r.ga.byAccount[account] || 0 : r.ga.organic), 0);
  return {
    weeks: rows.length,
    clicks,
    sessions,
    rate: clicks ? (sessions / clicks) * 100 : null,
    rows: rows.map((r) => ({
      week: r.week,
      clicks: r.ig.linkClicks,
      sessions: account ? r.ga.byAccount[account] || 0 : r.ga.organic,
    })),
  };
}

/**
 * 認知（フォロワー以外へのリーチ）に対する HP 流入の通過率。
 * GA4 と Instagram は書き出しの期間が違うことが多いため、両方そろっている週だけで出す。
 */
export function reachToSiteRate(joined, { account = '' } = {}) {
  const rows = joined.filter((r) => (r.ig.accountNonFollowerReach ?? 0) > 0 && r.ga.byAccount);
  if (!rows.length) return null;
  const reach = rows.reduce((s, r) => s + r.ig.accountNonFollowerReach, 0);
  const sessions = rows.reduce((s, r) => s + (account ? r.ga.byAccount[account] || 0 : r.ga.organic), 0);
  const clicks = rows.reduce((s, r) => s + (r.ig.linkClicks ?? 0), 0);
  return { weeks: rows.length, reach, sessions, clicks, rate: reach ? (sessions / reach) * 100 : null };
}

/**
 * 上部の指標用：Instagram から HP への流入（GA4）の期間合計。
 * UU = ユーザー数、新規率 = 新規ユーザー ÷ ユーザー、エンゲージメント率 = エンゲージのあったセッション ÷ セッション、
 * CV = 予約完了（キーイベント）、CVR = CV ÷ セッション。
 * 参照元別とキャンペーン別の表が両方あると二重計上になるので、粗いほうだけを使う。
 * 列が無い指標は null（「0件」と「データなし」を区別する）。
 * @returns {null|{users, newUsers, newUserRate, pageViews, sessions, paidSessions, engagedSessions, engagementRate, cv, cvr}}
 */
export function hpSummary(ga4Rows, startKey, endKey) {
  const rows = primaryRows((ga4Rows || []).filter((r) => r.date >= startKey && r.date <= endKey && isInstagram(r.sourceMedium)));
  if (!rows.length) return null;
  const sum = (key, list = rows) => {
    const vs = list.map((r) => r[key]).filter((v) => v !== null && v !== undefined);
    return vs.length ? vs.reduce((s, v) => s + v, 0) : null;
  };
  const sessions = sum('sessions') ?? 0;
  const users = sum('users');
  const newUsers = sum('newUsers');
  const engagedSessions = sum('engagedSessions');
  const cv = sum('cv');
  return {
    users,
    newUsers,
    newUserRate: newUsers !== null && users ? (newUsers / users) * 100 : null,
    pageViews: sum('pageViews'),
    sessions,
    paidSessions: sum('sessions', rows.filter((r) => isPaid(r.sourceMedium))) ?? 0,
    engagedSessions,
    engagementRate: engagedSessions !== null && sessions ? (engagedSessions / sessions) * 100 : null,
    cv,
    cvr: cv !== null && sessions ? (cv / sessions) * 100 : null,
  };
}

/** 流入の内訳（オーガニック／広告、アカウント別、参照元別） */
export function trafficBreakdown(gaWeeks, { rules, fallbackAccount = '' } = {}) {
  const totals = { sessions: 0, organic: 0, paid: 0, reserveTaps: 0, organicTaps: 0, paidTaps: 0, cv: 0, users: 0, newUsers: 0 };
  const byAccount = new Map();
  const bySource = new Map();
  for (const w of gaWeeks) {
    for (const k of Object.keys(totals)) totals[k] += w[k] || 0;
    for (const [a, v] of Object.entries(w.byAccount)) byAccount.set(a, (byAccount.get(a) || 0) + v);
    for (const [s, v] of Object.entries(w.bySource)) bySource.set(s, (bySource.get(s) || 0) + v);
  }
  const sort = (m) => [...m.entries()].map(([name, sessions]) => ({ name, sessions })).sort((a, b) => b.sessions - a.sessions);
  return {
    totals,
    accounts: sort(byAccount),
    sources: sort(bySource),
    organicTapRate: totals.organic ? (totals.organicTaps / totals.organic) * 100 : null,
    paidTapRate: totals.paid ? (totals.paidTaps / totals.paid) * 100 : null,
    weeks: gaWeeks.length,
  };
}

/** 散布図＋回帰直線に渡すデータ */
export function scatterData(joined, driverKey, targetKey) {
  const points = joined.map((r) => ({ x: r.ig[driverKey] ?? 0, y: r.ga[targetKey] ?? 0, week: r.week }));
  const fit = linearRegression(points.map((p) => p.x), points.map((p) => p.y));
  return { points, fit };
}

const fmtR = (r) => (r >= 0 ? '+' : '−') + Math.abs(r).toFixed(2);

/**
 * 相関表から日本語の所見を作る。
 * 「相関があった」で終わらせず、偏相関・差分相関でトレンドの影響を確認した結果まで述べる。
 */
export function trafficInsights({ table, lagged, breakdown, landing, joined }) {
  const out = [];
  if (!joined?.length) return out;
  const n = joined.length;

  if (n < 8) {
    out.push({
      level: 'info',
      title: `相関に使えた週は ${n} 週です`,
      text: '週数が少ないうちは、相関係数は偶然で大きく動きます。10週以上たまってから判断してください。ここでの数値は方向性の目安です。',
    });
  }

  const ranked = [...table].filter((t) => t.r !== null).sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  const top = ranked[0];
  if (top) {
    const trendWarn = top.partial !== null && top.partial !== undefined && Math.abs(top.partial) < Math.abs(top.r) * 0.7;
    out.push({
      level: top.significant ? 'good' : 'info',
      title: `${top.label} と HP 流入の相関は ${fmtR(top.r)}（${top.strength}）`,
      text:
        `n=${top.n}週、p=${top.p.toFixed(3)}${top.significant ? '（統計的に有意）' : '（有意とは言えません）'}。` +
        (trendWarn
          ? `ただし時間の経過を除くと ${fmtR(top.partial)} まで落ちるため、両方が右肩上がりなだけの可能性があります。`
          : top.deltaR !== null && top.deltaR !== undefined
            ? `週ごとの増減どうしで見ても ${fmtR(top.deltaR)} で、関係は保たれています。`
            : ''),
    });
  }

  const weak = ranked.filter((t) => Math.abs(t.r) < 0.2);
  if (weak.length) {
    out.push({
      level: 'info',
      title: `${weak.map((w) => w.label).slice(0, 3).join('・')} は流入とほぼ無関係`,
      text: 'リーチやビューが伸びてもHPの流入は増えていません。「見られること」と「サイトに来てもらうこと」は別の打ち手が必要です。',
    });
  }

  const bestLag = [...(lagged || [])].filter((t) => t.r !== null).sort((a, b) => Math.abs(b.r) - Math.abs(a.r))[0];
  if (bestLag && Math.abs(bestLag.r) > 0.5 && bestLag.p < 0.1) {
    out.push({
      level: 'info',
      title: `${bestLag.label} と翌週の流入は ${fmtR(bestLag.r)}`,
      text:
        bestLag.r > 0
          ? `投稿した週より翌週に効いている可能性があります（p=${bestLag.p.toFixed(3)}）。効果を測るときは1週ずらして見てください。`
          : `よく伸びた週の翌週は流入が落ちる傾向です（p=${bestLag.p.toFixed(3)}）。山と谷を繰り返しているだけの可能性もあるため、投稿ペースを一定にして確かめてください。`,
    });
  }

  if (breakdown?.totals.paid > 0) {
    const share = (breakdown.totals.paid / breakdown.totals.sessions) * 100;
    out.push({
      level: share > 30 ? 'warn' : 'info',
      title: `Instagram 流入の ${share.toFixed(0)}% は広告経由`,
      text:
        `広告 ${breakdown.totals.paid.toLocaleString()} セッション／オーガニック ${breakdown.totals.organic.toLocaleString()} セッション。` +
        (breakdown.organicTapRate !== null && breakdown.paidTapRate !== null
          ? `予約タップ率はオーガニック ${breakdown.organicTapRate.toFixed(1)}%、広告 ${breakdown.paidTapRate.toFixed(1)}% です。`
          : '') +
        '投稿の効果を見るときは広告分を除いて比べてください。',
    });
  }

  if (landing && landing.rate !== null && landing.rate < 60) {
    out.push({
      level: 'warn',
      title: `リンククリックのうち HP に到達しているのは ${landing.rate.toFixed(0)}%`,
      text:
        `Instagram 上のリンククリック ${landing.clicks.toLocaleString()}回に対し、GA4 で計測できた流入は ${landing.sessions.toLocaleString()}セッション（${landing.weeks}週分）。` +
        'プロフィールのリンク先が LINE や予約システムなど GA4 の計測対象外になっている、または UTM が付いていない可能性があります。ここが最も改善余地の大きい箇所です。',
    });
  }

  const acc = breakdown?.accounts?.filter((a) => a.name && a.name !== '(広告)') || [];
  if (acc.length >= 2) {
    out.push({
      level: 'info',
      title: `流入の最多は ${acc[0].name}（${acc[0].sessions.toLocaleString()}セッション）`,
      text: `2位は ${acc[1].name}（${acc[1].sessions.toLocaleString()}）。アカウントごとに UTM を分けておくと、どの発信がHPに効いているか比べられます。`,
    });
  }

  return out;
}

/** 表示用：相関の要約テキスト */
export function describeCorrelation(c) {
  if (!c || c.r === null) return 'データ不足';
  const sig = c.p === null ? '' : c.p < 0.01 ? ' **' : c.p < 0.05 ? ' *' : c.p < 0.1 ? ' +' : '';
  return `${fmtR(c.r)}${sig}`;
}

export { mean };

/**
 * 推定値の表示：「+1件あたり 約 +12.3セッション」
 * 回帰直線の傾きから出した目安。相関が有意でないときは偶然の範囲なので（参考）を付ける。
 */
export function describeEstimate(c, targetKey) {
  if (!c || c.estimate === null || c.estimate === undefined || !Number.isFinite(c.estimate)) return '–';
  const unit = TARGETS.find((t) => t.key === targetKey)?.unit ?? '';
  const v = c.estimate;
  const abs = Math.abs(v);
  const body = abs >= 10 ? Math.round(abs).toLocaleString('ja-JP') : abs.toFixed(1);
  const per = `+${c.step.toLocaleString('ja-JP')}${c.unit}あたり`;
  return `${per} 約 ${v >= 0 ? '+' : '−'}${body}${unit}${c.significant ? '' : '（参考）'}`;
}
