// GA4 の流入データ（参照元/メディア別の日次・週次）の取り込み。
// Meta のインサイトとは別系統のデータなので、独立した行として持つ。
import { toDateKey } from '../analytics.js';
import { excelSerialToDateKey } from './xlsx.js';

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[\s"'（）()・_-]/g, '');

const ALIASES = {
  date: ['日付', 'date', '週', 'week', '日', '年月日', 'デイ'],
  sourceMedium: [
    '参照元/メディア', 'セッションの参照元/メディア', 'sourcemedium', 'source/medium',
    'sessionsourcemedium', 'sessionsource/medium', '参照元メディア', 'ソース/メディア',
  ],
  campaign: ['キャンペーン', 'キャンペーン(utmcampaign)', 'campaign', 'utmcampaign', 'sessioncampaign', 'セッションのキャンペーン'],
  content: ['コンテンツ', 'コンテンツ(utmcontent)', 'content', 'utmcontent', 'adcontent'],
  sessions: ['セッション', 'セッション数', 'sessions'],
  engagedSessions: ['エンゲージのあったセッション', 'エンゲージメントのあったセッション', 'engagedsessions'],
  users: ['ユーザー', 'ユーザー数', 'totalusers', 'users', 'アクティブユーザー', 'activeusers'],
  newUsers: ['新規ユーザー', '新規ユーザー数', 'newusers'],
  pageViews: ['表示回数', 'ページビュー', 'ページビュー数', 'pv', 'pv数', 'views', 'pageviews', 'screenpageviews', '表示回数(ページビュー)'],
  reserveTaps: ['予約タップ', '予約タップ数', 'reservetap', 'reservetaps'],
  cv: ['cv', 'コンバージョン', 'コンバージョン数', 'conversions', 'keyevents', 'キーイベント', 'キーイベント数'],
};

// 明らかに Instagram 以外だと分かる行（ワークブックが集計済みの「その他」行を入れていることがある）
const NON_INSTAGRAM = ['（instagram以外の合計）', '(instagram以外の合計)', 'instagram以外', 'その他合計', 'other'];

function mapHeader(header) {
  const map = {};
  header.forEach((h, i) => {
    const n = norm(h);
    if (!n) return;
    for (const [key, list] of Object.entries(ALIASES)) {
      if (map[key] === undefined && list.some((a) => norm(a) === n)) map[key] = i;
    }
  });
  return map;
}

const toNumber = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[,\s%％]/g, '');
  if (s === '' || s === '-' || s === '–') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** 数値（Excel シリアル）でも文字列でも日付キーにする */
function toDate(v) {
  if (typeof v === 'number') return excelSerialToDateKey(v);
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/))) {
    return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
  }
  if ((m = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日/))) {
    return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : toDateKey(d);
}

/** Instagram からの流入か（参照元/メディアの文字列で判定） */
export function isInstagram(sourceMedium) {
  const s = String(sourceMedium ?? '').toLowerCase();
  if (NON_INSTAGRAM.some((x) => s.includes(x))) return false;
  return /instagram|(^|[^a-z])ig([^a-z]|$)|insta/.test(s);
}

/** 広告（有料）流入か。オーガニックと混ぜると投稿の効果が読めなくなる */
export function isPaid(sourceMedium) {
  const s = String(sourceMedium ?? '').toLowerCase();
  return /\/\s*(paid|cpc|ppc|cpm)\b/.test(s) || /\bpaid\b/.test(s.split('/')[1] || '');
}

/** 検索エンジン（自然検索・検索広告の判定に使う） */
const SEARCH_ENGINES = ['google', 'yahoo', 'bing', 'microsoft', 'duckduckgo', 'baidu', 'naver', 'ecosia'];

const splitSourceMedium = (sourceMedium) => {
  const [source = '', medium = ''] = String(sourceMedium ?? '').toLowerCase().split('/');
  // 「paid-search」「paid_search」などの表記ゆれをまとめる
  return { source: source.trim(), medium: medium.trim().replace(/[\s_-]/g, '') };
};

/**
 * 自然検索からの流入か（Instagram は除く）。
 * メディアが organic のものを自然検索とみなす。
 */
export function isOrganicSearch(sourceMedium) {
  if (isInstagram(sourceMedium)) return false;
  return /organic/.test(splitSourceMedium(sourceMedium).medium);
}

/**
 * 検索広告（リスティング広告）からの流入か。
 * メディアが cpc / ppc / paidsearch などで、かつ参照元が検索エンジンのもの。
 * SNS の広告（ig / paid など）は含めない。
 */
export function isSearchAd(sourceMedium) {
  if (isInstagram(sourceMedium)) return false;
  const { source, medium } = splitSourceMedium(sourceMedium);
  if (!/^(cpc|ppc|paid|paidsearch|sem|cpm)$/.test(medium)) return false;
  return SEARCH_ENGINES.some((e) => source.includes(e));
}

/**
 * 参照元/メディアから Instagram アカウントを推定する既定ルール。
 * 利用者が画面で対応づけを上書きできるよう、ルールは配列で返す。
 */
export const DEFAULT_ACCOUNT_RULES = [
  { match: 'web_instagram_okudate', account: 'dr.okudate_miselclinic', label: '奥立医師' },
  { match: 'instagram_artmake', account: 'instagram_artmake', label: 'アートメイク' },
  { match: 'instagram_phimosis', account: 'instagram_phimosis', label: '包茎' },
  { match: 'tatto', account: 'tattoo', label: 'タトゥー' },
  { match: 'surgeryshourei', account: 'surgery', label: '症例' },
];

/**
 * 参照元/メディア → アカウント名。
 * どのルールにも当たらない Instagram 流入は既定アカウント（本アカウント）とみなす。
 */
export function accountOf(sourceMedium, { rules = DEFAULT_ACCOUNT_RULES, fallback = '' } = {}) {
  const s = String(sourceMedium ?? '').toLowerCase();
  if (isPaid(s)) return '(広告)';
  for (const r of rules) if (s.includes(String(r.match).toLowerCase())) return r.account;
  return fallback;
}

/**
 * 行配列から GA4 の流入行を取り出す。CSV でも Excel のシートでも同じ関数を使う。
 * @returns {{rows:object[], headerIdx:number}|null} GA4 の表でなければ null
 */
export function readGA4Table(rows) {
  if (!rows?.length) return null;
  let headerIdx = -1;
  let col = null;
  // 先頭に説明行があるので、少し下まで見てヘッダーを探す
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const m = mapHeader(rows[i] || []);
    if (m.date !== undefined && m.sourceMedium !== undefined && m.sessions !== undefined) {
      headerIdx = i;
      col = m;
      break;
    }
  }
  if (headerIdx < 0) return null;

  const get = (r, key) => (col[key] === undefined ? undefined : r[col[key]]);
  // キャンペーン列があれば、同じ流入をさらに細かく割った表。合計すると二重計上になるので区別する
  const level = col.campaign !== undefined || col.content !== undefined ? 'campaign' : 'source';
  const out = [];
  for (const r of rows.slice(headerIdx + 1)) {
    const date = toDate(r[col.date]);
    const sourceMedium = String(get(r, 'sourceMedium') ?? '').trim();
    if (!date || !sourceMedium) continue;
    const sessions = toNumber(get(r, 'sessions'));
    if (sessions === null) continue;
    out.push({
      date,
      sourceMedium,
      level,
      campaign: String(get(r, 'campaign') ?? '').trim() || null,
      content: String(get(r, 'content') ?? '').trim() || null,
      sessions,
      engagedSessions: toNumber(get(r, 'engagedSessions')),
      users: toNumber(get(r, 'users')),
      newUsers: toNumber(get(r, 'newUsers')),
      pageViews: toNumber(get(r, 'pageViews')),
      reserveTaps: toNumber(get(r, 'reserveTaps')),
      cv: toNumber(get(r, 'cv')),
    });
  }
  return out.length ? { rows: out, headerIdx, level } : null;
}

/**
 * Excel ブックの全シートから GA4 の表を探して取り込む。
 * @param {{name:string, rows:any[][]}[]} sheets
 * @param {{property?: string}} [opts] プロパティ名（HP のアカウント）
 */
export function importGA4Workbook(sheets, { property = '' } = {}) {
  const rows = [];
  const channels = [];
  const found = [];
  for (const sheet of sheets) {
    // チャネル別（Organic Search / Paid Search など）の表を先に見る。
    // 参照元/メディアの表は Instagram 以外をまとめていることがあり、自然検索・検索広告を分けられないため。
    const ch = readChannelTable(sheet.rows);
    if (ch) {
      for (const r of ch.rows) channels.push({ ...r, property, sheet: sheet.name });
      found.push(`${sheet.name}（${ch.rows.length}行・チャネル別）`);
      continue;
    }
    const table = readGA4Table(sheet.rows);
    if (!table) continue;
    for (const r of table.rows) rows.push({ ...r, property, sheet: sheet.name });
    found.push(`${sheet.name}（${table.rows.length}行・${table.level === 'campaign' ? 'キャンペーン別' : '参照元別'}）`);
  }
  if (!rows.length && !channels.length) return null;
  return { rows, channels, sheets: found };
}

/** GA4 の既定チャネルグループ → アプリ内のキー */
const CHANNEL_KEYS = {
  organicsearch: 'searchOrganic',
  paidsearch: 'searchAds',
  自然検索: 'searchOrganic',
  有料検索: 'searchAds',
  検索広告: 'searchAds',
};

/** チャネル名をキーにする（表記ゆれを吸収） */
export const channelKey = (name) => CHANNEL_KEYS[String(name ?? '').toLowerCase().replace(/[\s_-]/g, '')] || null;

const CHANNEL_HEADS = ['チャネル', 'チャネルグループ', 'channel', 'defaultchannelgroup', 'sessiondefaultchannelgroup'];
const CHANNEL_DATE_HEADS = ['週開始', '日付', 'date', 'week', 'weekstart'];

/**
 * 「週開始・チャネル・セッション」のチャネル別の表を読む。
 * GA4 の「セッションのデフォルト チャネル グループ」で書き出したもの。
 * @returns {null|{rows:{date:string, channel:string, key:?string, sessions:number, ...}[]}}
 */
export function readChannelTable(rows) {
  if (!rows?.length) return null;
  for (let h = 0; h < Math.min(rows.length, 8); h++) {
    const head = (rows[h] || []).map((x) => String(x ?? '').toLowerCase().replace(/[\s\n_-]/g, ''));
    const iDate = head.findIndex((x) => CHANNEL_DATE_HEADS.some((a) => x === a.toLowerCase()));
    const iCh = head.findIndex((x) => CHANNEL_HEADS.some((a) => x === a.toLowerCase()));
    const iSessions = head.findIndex((x) => x === 'セッション' || x === 'sessions');
    if (iDate < 0 || iCh < 0 || iSessions < 0) continue;
    const at = (name) => head.findIndex((x) => x === name);
    const cols = {
      users: at('総ユーザー'), newUsers: at('新規ユーザー'),
      engagedSessions: at('エンゲージのあったセッション'),
      reserveTaps: at('予約タップ'), cv: at('cv'),
    };
    const out = [];
    for (const r of rows.slice(h + 1)) {
      const channel = String(r[iCh] ?? '').trim();
      const date = toDate(r[iDate]);
      if (!channel || !date) continue;
      const num = (i) => (i < 0 ? null : toNumber(r[i]));
      out.push({
        date,
        channel,
        key: channelKey(channel),
        sessions: toNumber(r[iSessions]) ?? 0,
        users: num(cols.users),
        newUsers: num(cols.newUsers),
        engagedSessions: num(cols.engagedSessions),
        reserveTaps: num(cols.reserveTaps),
        cv: num(cols.cv),
      });
    }
    if (out.length) return { rows: out };
  }
  return null;
}

/**
 * 集計に使う行だけを返す。
 * 参照元別（粗い）とキャンペーン別（細かい）が両方あると、同じ流入を二重に数えてしまうため、
 * 粗いほうがあればそちらを使う。
 */
export function primaryRows(rows) {
  const source = rows.filter((r) => r.level !== 'campaign');
  return source.length ? source : rows;
}

/** キャンペーン別（UTM）の行だけ。どの投稿・施策からの流入かを見るのに使う */
export function campaignRows(rows) {
  return rows.filter((r) => r.level === 'campaign' && r.campaign);
}

/** ファイル名からプロパティ名を推定する（Instagram流入分析_miselcl_過去90日.xlsx → miselcl） */
export function propertyFromFileName(name) {
  const base = String(name || '').replace(/\.[a-z0-9]+$/i, '');
  const m = base.match(/[_＿]([A-Za-z0-9.\-]+)/);
  return m ? m[1] : base;
}

/** 同じ日・同じ参照元/メディア・同じキャンペーンの行をひとつにまとめる */
export function mergeGA4(oldRows = [], newRows = []) {
  const key = (r) => `${r.property || ''}|${r.date}|${r.sourceMedium}|${r.campaign || ''}|${r.content || ''}`;
  const map = new Map(oldRows.map((r) => [key(r), r]));
  for (const r of newRows) map.set(key(r), r);
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date) || a.sourceMedium.localeCompare(b.sourceMedium));
}

/** チャネル別の行をマージ（同じプロパティ・同じ週・同じチャネルは新しい方で上書き） */
export function mergeGA4Channels(oldRows = [], newRows = []) {
  const key = (r) => `${r.property || ''}|${r.date}|${r.channel}`;
  const map = new Map(oldRows.map((r) => [key(r), r]));
  for (const r of newRows) map.set(key(r), r);
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date) || a.channel.localeCompare(b.channel));
}
