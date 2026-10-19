// Google Search Console の「検索パフォーマンス → エクスポート」で出力した ZIP / CSV を読む。
//
// 書き出しは 1 プロパティにつき 7 ファイル（クエリ・ページ／投稿・日付・デバイス・国・
// 検索での見え方・フィルタ）で、どれも同じ指標列（クリック数・表示回数・CTR・掲載順位）を持つ。
// ファイル名は 3 プロパティとも同じなので、どのプロパティのものかは ZIP 名から判別する。
// ZIP のまま読めば、Windows で展開したときのファイル名の文字化けも避けられる。
//
// 重要：どの表も「期間全体の集計」であって日々の積み上げではない。
// 同じプロパティを取り込み直したときは足さずに置き換える（日付の表だけは時系列なので日付単位でマージ）。
import { unzip } from './xlsx.js';
import { parseCSV, decodeCSV } from './csv.js';

/** 指標列の見出し（日本語／英語） */
const METRIC_ALIASES = {
  clicks: ['クリック数', 'クリック', 'clicks', 'url clicks'],
  impressions: ['表示回数', 'インプレッション', 'impressions'],
  ctr: ['ctr', 'クリック率'],
  position: ['掲載順位', '平均掲載順位', 'position', 'average position'],
};

/** 1 列目の見出しから、その表が何の切り口かを決める */
const DIMENSIONS = [
  { key: 'queries', item: 'query', label: '検索クエリ', heads: ['上位のクエリ', 'クエリ', 'top queries', 'query'] },
  { key: 'pages', item: 'url', label: 'ページ', heads: ['上位のページ', 'ページ', 'top pages', 'page'] },
  { key: 'posts', item: 'url', label: '投稿', heads: ['上位の投稿', '投稿', 'top posts'] },
  { key: 'daily', item: 'date', label: '日付', heads: ['日付', 'date'] },
  { key: 'devices', item: 'device', label: 'デバイス', heads: ['デバイス', 'device'] },
  { key: 'countries', item: 'country', label: '国', heads: ['国', 'country'] },
  { key: 'appearance', item: 'name', label: '検索での見え方', heads: ['検索での見え方', 'search appearance'] },
];

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '');

const num = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/[,\s]/g, '').replace(/%$/, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const dateKey = (v) => {
  const m = String(v ?? '').trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : null;
};

/** 見出し行から指標列の位置を拾う */
function metricColumns(head) {
  const cols = {};
  head.forEach((h, i) => {
    const n = norm(h);
    for (const [key, aliases] of Object.entries(METRIC_ALIASES)) {
      if (cols[key] === undefined && aliases.some((a) => n === norm(a))) cols[key] = i;
    }
  });
  return cols;
}

/**
 * Search Console の 1 ファイルを読む。形が違えば null を返す（取り込みの判別に使う）。
 * @param {string[][]} rows parseCSV の結果
 * @returns {null|{kind:'filter', filter:object}|{kind:'table', dimension:string, item:string, label:string, rows:object[]}}
 */
export function readSCTable(rows) {
  const head = rows?.[0];
  if (!head || head.length < 2) return null;

  // フィルタ.csv は「フィルタ,値」の 2 列だけ
  if (['フィルタ', 'filter'].includes(norm(head[0])) && head.length === 2) {
    const filter = {};
    for (const r of rows.slice(1)) if (r[0]) filter[String(r[0]).trim()] = String(r[1] ?? '').trim();
    return { kind: 'filter', filter };
  }

  const dim = DIMENSIONS.find((d) => d.heads.some((h) => norm(h) === norm(head[0])));
  if (!dim) return null;
  const cols = metricColumns(head);
  // クリック数と表示回数がそろっていなければ Search Console の書き出しではない
  if (cols.clicks === undefined || cols.impressions === undefined) return null;

  const out = [];
  for (const r of rows.slice(1)) {
    const name = String(r[0] ?? '').trim();
    if (!name) continue;
    const row = {
      [dim.item]: dim.item === 'date' ? dateKey(name) : name,
      clicks: num(r[cols.clicks]),
      impressions: num(r[cols.impressions]),
      ctr: cols.ctr === undefined ? null : num(r[cols.ctr]),
      position: cols.position === undefined ? null : num(r[cols.position]),
    };
    if (dim.item === 'date' && !row.date) continue;
    // CTR 列が無い書き出しでも、クリック ÷ 表示回数 で出せる
    if (row.ctr === null && row.clicks !== null && row.impressions) row.ctr = (row.clicks / row.impressions) * 100;
    if (dim.key === 'posts' || dim.key === 'pages') row.shortcode = shortcodeOfUrl(row.url);
    out.push(row);
  }
  if (!out.length) return null;
  return { kind: 'table', dimension: dim.key, item: dim.item, label: dim.label, rows: out };
}

/** Instagram の投稿 URL から shortcode（/p/xxxx/ ・ /reel/xxxx/）を取り出す */
export function shortcodeOfUrl(url) {
  const m = String(url ?? '').match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}

/**
 * 書き出し名からプロパティを判別する。
 * 例: instagram.com_miselclinic_osaka-Performance-on-Search-2026-10-19
 *     → { id:'instagram.com/miselclinic_osaka', kind:'instagram', account:'miselclinic_osaka', exportedAt:'2026-10-19' }
 * プロパティ名の「/」は「_」に置き換えられているが、置換されるのはホスト名の直後だけ。
 */
export function propertyFromName(name = '') {
  const base = String(name).replace(/\.[a-z0-9]+$/i, '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const m = base.match(/^(.*?)-Performance-on-Search-(\d{4}-\d{2}-\d{2})$/i);
  const raw = (m ? m[1] : base).trim();
  const exportedAt = m ? m[2] : null;
  if (!raw) return null;

  const host = raw.replace(/^https?_+/i, '').replace(/^(www\.)/i, '');
  const igHost = host.match(/^instagram\.com[_/](.+)$/i);
  if (igHost) {
    const account = igHost[1].replace(/[_/]+$/, '');
    return { id: `instagram.com/${account}`, kind: 'instagram', account, label: `@${account}`, exportedAt };
  }
  const site = host.replace(/[_/]+$/, '');
  return { id: site, kind: 'site', account: '', label: site, exportedAt };
}

const emptyProperty = (meta) => ({
  ...meta,
  filter: null,
  queries: [],
  pages: [],
  posts: [],
  daily: [],
  devices: [],
  countries: [],
  appearance: [],
});

/** 読んだ表をプロパティに入れる（daily だけ日付でマージ、他は置き換え） */
function applyTable(prop, table) {
  if (table.kind === 'filter') {
    prop.filter = { ...(prop.filter || {}), ...table.filter };
    return;
  }
  if (table.dimension === 'daily') {
    const map = new Map(prop.daily.map((r) => [r.date, r]));
    for (const r of table.rows) map.set(r.date, r);
    prop.daily = [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
    return;
  }
  prop[table.dimension] = table.rows;
}

/**
 * Search Console の ZIP を 1 プロパティとして読む。
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {string} fileName プロパティ名と書き出し日を読むために使う
 */
export async function readSearchConsoleZip(buffer, fileName = '') {
  const files = await unzip(buffer);
  const meta = propertyFromName(fileName);
  if (!meta) return null;
  const prop = emptyProperty(meta);
  const read = [];
  for (const [name, bytes] of files) {
    if (!/\.csv$/i.test(name)) continue;
    const table = readSCTable(parseCSV(decodeCSV(bytes)));
    if (!table) continue;
    applyTable(prop, table);
    read.push(table.kind === 'filter' ? 'フィルタ' : `${table.label} ${table.rows.length}件`);
  }
  if (!read.length) return null;
  // 投稿一覧にプロフィール URL が入っているので、そこからアカウント名を取り直す（名前の「_」の切れ目に頼らない）
  const profile = prop.posts.find((r) => !r.shortcode)?.url?.match(/instagram\.com\/([A-Za-z0-9._]+)\/?$/i);
  if (profile && prop.kind === 'instagram') {
    prop.account = profile[1];
    prop.id = `instagram.com/${profile[1]}`;
    prop.label = `@${profile[1]}`;
  }
  return { property: prop, read };
}

/**
 * 1 枚ずつ読んだ表をまとめて 1 プロパティにする（ZIP を使わず CSV を直接読み込んだとき）。
 * @param {object|null} meta propertyFromName / 内容から推測したプロパティ
 * @param {object[]} tables readSCTable の結果
 */
export function buildProperty(meta, tables = []) {
  const base = meta || { id: '(プロパティ不明)', kind: 'unknown', account: '', label: 'プロパティ不明', exportedAt: null };
  const prop = emptyProperty(base);
  for (const t of tables) if (t) applyTable(prop, t);
  return prop;
}

/**
 * ZIP を使わず 1 ファイルずつ読み込んだ場合。
 * ファイル名ではプロパティを見分けられないので、内容から分かる範囲で推測する。
 */
export function readSearchConsoleCSV(rows, { fileName = '', folder = '' } = {}) {
  const table = readSCTable(rows);
  if (!table) return null;
  // フォルダ名（webkitRelativePath）が取れればそこから、無ければ中身の URL から判別する
  const meta =
    propertyFromName(folder) ||
    (table.kind === 'table' && table.dimension === 'posts' ? propertyFromUrls(table.rows) : null) ||
    (table.kind === 'table' && table.dimension === 'pages' ? propertyFromUrls(table.rows) : null);
  return { table, property: meta, fileName };
}

/** URL の並びからプロパティを推測する（投稿一覧・ページ一覧だけ） */
function propertyFromUrls(rows = []) {
  const urls = rows.map((r) => r.url).filter(Boolean);
  // プロフィール URL（instagram.com/アカウント名/）があればアカウント名が確実に分かる
  for (const u of urls) {
    const m = u.match(/instagram\.com\/([A-Za-z0-9._]+)\/?$/i);
    if (m && !['p', 'reel', 'reels', 'tv'].includes(m[1].toLowerCase())) {
      return { id: `instagram.com/${m[1]}`, kind: 'instagram', account: m[1], label: `@${m[1]}`, exportedAt: null };
    }
  }
  if (urls.some((u) => /instagram\.com/i.test(u))) {
    // 投稿 URL しか無い：アカウント名までは決められない
    return { id: 'instagram.com', kind: 'instagram', account: '', label: 'Instagram', exportedAt: null };
  }
  const host = urls[0]?.match(/^https?:\/\/(?:www\.)?([^/]+)/i);
  return host ? { id: host[1], kind: 'site', account: '', label: host[1], exportedAt: null } : null;
}

/** プロパティ単位でマージ（同じプロパティは置き換え、daily だけ日付でマージ） */
export function mergeSearchConsole(oldProps = [], newProps = []) {
  const map = new Map(oldProps.map((p) => [p.id, p]));
  for (const p of newProps) {
    const prev = map.get(p.id);
    if (!prev) {
      map.set(p.id, p);
      continue;
    }
    const merged = { ...prev, ...p };
    const dailyMap = new Map((prev.daily || []).map((r) => [r.date, r]));
    for (const r of p.daily || []) dailyMap.set(r.date, r);
    merged.daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));
    // 新しい書き出しに無い表は前のものを残す
    for (const k of ['queries', 'pages', 'posts', 'devices', 'countries', 'appearance']) {
      if (!p[k]?.length && prev[k]?.length) merged[k] = prev[k];
    }
    merged.filter = p.filter || prev.filter;
    map.set(p.id, merged);
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** 取り込み結果の説明文 */
export function describeSearchConsole(prop, read = []) {
  const parts = read.length
    ? read
    : [
        prop.queries.length && `検索クエリ ${prop.queries.length}件`,
        prop.posts.length && `投稿 ${prop.posts.length}件`,
        prop.pages.length && `ページ ${prop.pages.length}件`,
        prop.daily.length && `日次 ${prop.daily.length}日分`,
      ].filter(Boolean);
  const period = prop.daily.length ? `（${prop.daily[0].date}〜${prop.daily.at(-1).date}）` : '';
  return `Search Console／${prop.label} ${parts.join(' / ')}${period}`;
}

// ---------- 集計 ----------

const sum = (rows, key) => rows.reduce((s, r) => s + (r[key] ?? 0), 0);

/** 加重平均の掲載順位（表示回数で重み付け。単純平均だと表示の少ない語に引っ張られる） */
export function weightedPosition(rows = []) {
  let w = 0;
  let total = 0;
  for (const r of rows) {
    if (r.position === null || r.position === undefined || !r.impressions) continue;
    w += r.position * r.impressions;
    total += r.impressions;
  }
  return total ? w / total : null;
}

/** Instagram のプロパティだけを返す（アカウント名で絞り込める） */
export function instagramProperties(props = [], account = '') {
  const ig = props.filter((p) => p.kind === 'instagram');
  if (!account) return ig;
  const hit = ig.filter((p) => p.account === account);
  return hit.length ? hit : [];
}

export const siteProperties = (props = []) => props.filter((p) => p.kind === 'site');

/**
 * 投稿 URL → 検索の指標。複数プロパティに同じ投稿があれば足す。
 * @returns {Map<string, {clicks:number, impressions:number, ctr:?number, position:?number}>}
 */
export function postIndex(props = []) {
  const map = new Map();
  for (const p of props) {
    for (const r of p.posts || []) {
      if (!r.shortcode) continue;
      const cur = map.get(r.shortcode) || { clicks: 0, impressions: 0, position: null, ctr: null, _w: 0 };
      cur.clicks += r.clicks ?? 0;
      cur.impressions += r.impressions ?? 0;
      if (r.position !== null && r.impressions) {
        cur._w += r.position * r.impressions;
      }
      map.set(r.shortcode, cur);
    }
  }
  for (const v of map.values()) {
    v.position = v.impressions && v._w ? v._w / v.impressions : null;
    v.ctr = v.impressions ? (v.clicks / v.impressions) * 100 : null;
    delete v._w;
  }
  return map;
}

/** プロパティ全体の集計（カードの見出しに出す） */
export function searchSummary(props = []) {
  if (!props.length) return null;
  const all = props.flatMap((p) => p.daily?.length ? p.daily : p.queries || []);
  const queries = props.flatMap((p) => p.queries || []);
  return {
    properties: props.length,
    clicks: sum(all, 'clicks'),
    impressions: sum(all, 'impressions'),
    ctr: sum(all, 'impressions') ? (sum(all, 'clicks') / sum(all, 'impressions')) * 100 : null,
    position: weightedPosition(all),
    queryCount: queries.length,
    from: props.map((p) => p.daily?.[0]?.date).filter(Boolean).sort()[0] || null,
    to: props.map((p) => p.daily?.at(-1)?.date).filter(Boolean).sort().at(-1) || null,
  };
}

/**
 * 検索クエリの一覧（複数プロパティ分をまとめ、同じ語は足す）。
 * @param {object[]} props
 * @param {{sort?:'clicks'|'impressions'|'ctr'|'position', limit?:number, minImpressions?:number}} opts
 */
export function queryRows(props = [], { sort = 'clicks', limit = 0, minImpressions = 0 } = {}) {
  const map = new Map();
  for (const p of props) {
    for (const r of p.queries || []) {
      const cur = map.get(r.query) || { query: r.query, clicks: 0, impressions: 0, _w: 0 };
      cur.clicks += r.clicks ?? 0;
      cur.impressions += r.impressions ?? 0;
      if (r.position !== null && r.impressions) cur._w += r.position * r.impressions;
      map.set(r.query, cur);
    }
  }
  let rows = [...map.values()].map((r) => ({
    query: r.query,
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.impressions ? (r.clicks / r.impressions) * 100 : null,
    position: r.impressions && r._w ? r._w / r.impressions : null,
  }));
  if (minImpressions) rows = rows.filter((r) => r.impressions >= minImpressions);
  const dir = sort === 'position' ? 1 : -1; // 掲載順位だけは小さいほうが上位
  rows.sort((a, b) => ((a[sort] ?? (dir === 1 ? Infinity : -Infinity)) - (b[sort] ?? (dir === 1 ? Infinity : -Infinity))) * dir);
  return limit ? rows.slice(0, limit) : rows;
}

/**
 * 「順位は高いのにクリックされていない」クエリ。
 * 上位に出ているのに CTR が平均を大きく下回る語は、見出しや内容の見直しで伸びしろがある。
 */
export function underperformingQueries(props = [], { limit = 5, maxPosition = 10, minImpressions = 50 } = {}) {
  const rows = queryRows(props, { minImpressions });
  if (rows.length < 3) return [];
  const base = rows.reduce((s, r) => s + r.impressions, 0);
  const avgCtr = base ? (rows.reduce((s, r) => s + r.clicks, 0) / base) * 100 : 0;
  return rows
    .filter((r) => r.position !== null && r.position <= maxPosition && r.ctr !== null && r.ctr < avgCtr)
    .map((r) => ({ ...r, avgCtr, gap: avgCtr - r.ctr, lostClicks: Math.round((r.impressions * (avgCtr - r.ctr)) / 100) }))
    .sort((a, b) => b.lostClicks - a.lostClicks)
    .slice(0, limit);
}

/** 日次の検索データを期間で切り出す */
export function sliceSearchDaily(props = [], startKey, endKey) {
  const map = new Map();
  for (const p of props) {
    for (const r of p.daily || []) {
      if (startKey && r.date < startKey) continue;
      if (endKey && r.date > endKey) continue;
      const cur = map.get(r.date) || { date: r.date, clicks: 0, impressions: 0, _w: 0 };
      cur.clicks += r.clicks ?? 0;
      cur.impressions += r.impressions ?? 0;
      if (r.position !== null && r.impressions) cur._w += r.position * r.impressions;
      map.set(r.date, cur);
    }
  }
  return [...map.values()]
    .map((r) => ({
      date: r.date,
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.impressions ? (r.clicks / r.impressions) * 100 : null,
      position: r.impressions && r._w ? r._w / r.impressions : null,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
