// 投稿ごとの指標を、取り込みのたびに「その日のスナップショット」として残す。
//
// 投稿一覧やインサイトの書き出しに入っている数字は、どれも書き出した時点までの
// 累計（いいねの合計・保存の合計…）なので、日次で取り込み続けると
// 「投稿してから何日目にどれだけ伸びたか」を後から追えるようになる。
//
// 集計（ダッシュボードの合計・ER など）は今までどおり posts の最新値だけを使い、
// この履歴は「詳細を見る」で推移を表示するためにだけ使う。
import { DAY_MS, jstDateKey, parseDateKey } from './analytics.js';

/** 推移を残す指標。表・グラフ・CSV の列順もこの順に並べる */
export const HISTORY_METRICS = [
  { key: 'likes', label: 'いいね' },
  { key: 'saves', label: '保存' },
  { key: 'comments', label: 'コメント' },
  { key: 'shares', label: 'シェア' },
  { key: 'interactions', label: '反応計' },
  { key: 'reach', label: 'リーチ' },
  { key: 'views', label: 'ビュー' },
  { key: 'follows', label: 'フォロー' },
  { key: 'profileVisits', label: 'プロフ遷移' },
];

export const HISTORY_FIELDS = HISTORY_METRICS.map((m) => m.key);
export const HISTORY_LABELS = Object.fromEntries(HISTORY_METRICS.map((m) => [m.key, m.label]));

/** 履歴の保存上限（localStorage に収まる目安）。超えたら古い投稿から丸ごと落とす */
export const MAX_HISTORY_ROWS = 8000;

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s%]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const blank = (v) => v === null || v === undefined;

/** 反応計は保存しない（4指標がそろったときだけ足して出す） */
const sumInteractions = (row) => {
  const parts = [row.likes, row.comments, row.saves, row.shares];
  return parts.some(blank) ? null : parts.reduce((s, v) => s + v, 0);
};

const dayDiff = (from, to) => Math.round((parseDateKey(to) - parseDateKey(from)) / DAY_MS);

/**
 * 取り込んだ投稿から asOf 日付のスナップショットを作る。
 * 値が無い指標は列ごと持たない（後から別のファイルで埋められるようにするため）。
 * @param {object[]} posts 取り込み結果の投稿（正規化前。0 埋めされていない生の値）
 * @param {string} asOf スナップショットの日付キー（YYYY-MM-DD）
 */
export function snapshotPosts(posts = [], asOf) {
  if (!asOf) return [];
  const out = [];
  for (const p of posts) {
    const id = String(p?.id ?? '');
    if (!id) continue;
    const row = { id, date: asOf };
    let has = false;
    for (const k of HISTORY_FIELDS) {
      if (k === 'interactions') continue; // 足し算で出せるので保存しない
      const v = num(p[k]);
      if (v === null) continue;
      row[k] = v;
      has = true;
    }
    if (has) out.push(row);
  }
  return out;
}

/**
 * スナップショットを「投稿ID × 日付」でマージする。
 * 新しい取り込みに無い指標は前に入っていた値を残すので、
 * 同じ日の投稿一覧と投稿インサイトを別々に読み込んでも 1 行にまとまる。
 */
export function mergeHistory(oldRows = [], newRows = []) {
  const key = (r) => `${r.id}\u0000${r.date}`;
  const map = new Map(oldRows.filter((r) => r?.id && r?.date).map((r) => [key(r), { ...r }]));
  for (const r of newRows) {
    if (!r?.id || !r?.date) continue;
    const prev = map.get(key(r));
    if (!prev) {
      map.set(key(r), { ...r });
      continue;
    }
    const merged = { ...prev };
    for (const k of HISTORY_FIELDS) if (!blank(r[k])) merged[k] = r[k];
    map.set(key(r), merged);
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id) || a.date.localeCompare(b.date));
}

/**
 * 1投稿の推移。日付順に並べ、投稿日からの経過日数と前回からの増加を付ける。
 * 増加は「その指標が前に分かっていた時点」との差なので、
 * 途中の取り込みにその指標が無くても途切れない。
 * @returns {{date:string, day:?number, likes:?number, d_likes:?number, …}[]}
 */
export function postTimeline(rows = [], post) {
  const id = String(typeof post === 'object' && post !== null ? post?.id ?? '' : post ?? '');
  if (!id) return [];
  const postedOn = typeof post === 'object' && post?.timestamp ? jstDateKey(post.timestamp) : null;
  const mine = rows.filter((r) => r.id === id).sort((a, b) => a.date.localeCompare(b.date));
  const lastKnown = new Map();
  return mine.map((r) => {
    const out = { date: r.date, day: postedOn ? dayDiff(postedOn, r.date) : null };
    for (const k of HISTORY_FIELDS) out[k] = k === 'interactions' ? null : r[k] ?? null;
    out.interactions = sumInteractions(out);
    for (const k of HISTORY_FIELDS) {
      const prev = lastKnown.get(k);
      out[`d_${k}`] = out[k] === null || prev === undefined ? null : out[k] - prev;
      if (out[k] !== null) lastKnown.set(k, out[k]);
    }
    return out;
  });
}

/** 投稿IDごとの履歴の本数と期間（表に「詳細」を出すかの判断に使う） */
export function historyIndex(rows = []) {
  const map = new Map();
  for (const r of rows) {
    if (!r?.id || !r?.date) continue;
    const cur = map.get(r.id);
    if (!cur) map.set(r.id, { count: 1, first: r.date, last: r.date });
    else {
      cur.count++;
      if (r.date < cur.first) cur.first = r.date;
      if (r.date > cur.last) cur.last = r.date;
    }
  }
  return map;
}

/** 取り込んだスナップショットの日付一覧（古い順） */
export function historyDates(rows = []) {
  return [...new Set(rows.map((r) => r.date).filter(Boolean))].sort();
}

/**
 * 履歴全体の収集状況。「いつから何回分たまっているか」を画面に出すため。
 */
export function historyStatus(rows = []) {
  const dates = historyDates(rows);
  const ids = new Set(rows.map((r) => r.id));
  return {
    rows: rows.length,
    posts: ids.size,
    days: dates.length,
    first: dates[0] || null,
    last: dates.at(-1) || null,
  };
}

/**
 * 保存容量に収まるよう履歴を間引く。
 * - 投稿一覧から消えた投稿（orphan）の履歴を捨てる
 * - それでも多ければ、古い投稿のものを丸ごと捨てる（新しい投稿の曲線は途切れさせない）
 */
export function pruneHistory(rows = [], posts = [], { maxRows = MAX_HISTORY_ROWS } = {}) {
  const order = new Map(posts.map((p) => [String(p.id), p.timestamp || '']));
  const kept = order.size ? rows.filter((r) => order.has(r.id)) : [...rows];
  if (kept.length <= maxRows) return kept;

  const byId = new Map();
  for (const r of kept) {
    if (!byId.has(r.id)) byId.set(r.id, []);
    byId.get(r.id).push(r);
  }
  // 新しい投稿を先に残す
  const ids = [...byId.keys()].sort((a, b) => String(order.get(b) ?? '').localeCompare(String(order.get(a) ?? '')));
  const out = [];
  for (const id of ids) {
    const group = byId.get(id);
    if (out.length + group.length > maxRows) break;
    out.push(...group);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id) || a.date.localeCompare(b.date));
}

/**
 * スナップショットを取る日付。
 * ソーシャルインサイトは書き出しの期間末（無ければ取得日）を、
 * それ以外は取り込んだ日を「その時点の数字」として扱う。
 */
export function snapshotDate({ end = null, fetchedAt = null } = {}, now = new Date()) {
  return end || fetchedAt || jstDateKey(now);
}
