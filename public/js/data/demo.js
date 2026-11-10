// デモ用のサンプルデータ（シード固定なので毎回同じ結果になる）
import { addDays, fromJST, toDateKey, weekdayIndex, parseDateKey, DAY_MS } from '../analytics.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOPICS = [
  ['【保存版】朝のスキンケア手順', ['#スキンケア', '#美容', '#朝活']],
  ['乾燥肌さん向け 保湿のコツ3選', ['#スキンケア', '#乾燥肌', '#保湿']],
  ['スタッフおすすめ 日焼け止め比較', ['#日焼け止め', '#美容', '#コスメ']],
  ['よくある質問にお答えします', ['#美容', '#Q&A']],
  ['ビフォーアフター公開', ['#ビフォーアフター', '#美容', '#スキンケア']],
  ['新メニューのご案内', ['#お知らせ', '#美容']],
  ['1分でわかる毛穴ケア', ['#毛穴ケア', '#スキンケア', '#美容']],
  ['今月のキャンペーン情報', ['#キャンペーン', '#お知らせ']],
  ['スタッフの休日ルーティン', ['#ルーティン', '#vlog']],
  ['夜のリラックスケア', ['#スキンケア', '#夜活', '#癒し']],
];

export function generateDemo({ days = 180, endDate = new Date() } = {}) {
  const rand = rng(20260919);
  const endKey = toDateKey(endDate);
  const startKey = addDays(endKey, -(days - 1));

  // ---- 投稿 ----
  const posts = [];
  const tracked = []; // 投稿と投稿日（日次スナップショットを作るのに使う）
  const postBoostByDate = new Map();
  for (let i = 0; i < days; i++) {
    const dateKey = addDays(startKey, i);
    const [y, m, d] = dateKey.split('-').map(Number);
    const wd = weekdayIndex(new Date(y, m - 1, d));
    // 平日は約70%、週末は約85%の確率で投稿
    if (rand() > (wd >= 5 ? 0.85 : 0.7)) continue;

    // 投稿時間（日本時間）は 7〜23時に分散。夜（20〜22時）と昼休み（12時）に寄せる
    const r = rand();
    const hour = r < 0.3 ? 19 + Math.floor(rand() * 4) : r < 0.5 ? 12 : 7 + Math.floor(rand() * 16);
    const minute = Math.floor(rand() * 60);
    const ts = fromJST(y, m, d, hour, minute);

    const tr = rand();
    const type = tr < 0.45 ? 'REELS' : tr < 0.8 ? 'CAROUSEL' : 'IMAGE';
    const [title, tags] = TOPICS[Math.floor(rand() * TOPICS.length)];

    // 反応を決める要因：時間帯・曜日・投稿タイプ・ゆるやかな成長
    const timeFactor = hour >= 20 && hour <= 22 ? 1.45 : hour === 12 ? 1.2 : hour < 9 ? 0.75 : hour >= 14 && hour <= 17 ? 0.8 : 1;
    const dayFactor = wd === 1 || wd === 3 ? 1.12 : wd === 6 ? 1.1 : wd === 0 ? 0.9 : 1;
    const typeReach = { REELS: 2.1, CAROUSEL: 1.1, IMAGE: 0.8 }[type];
    const typeEng = { REELS: 0.95, CAROUSEL: 1.35, IMAGE: 0.85 }[type];
    const growth = 1 + (i / days) * 0.35;
    const noise = 0.7 + rand() * 0.6;

    const reach = Math.round(1800 * typeReach * timeFactor * dayFactor * growth * noise);
    const erBase = 0.055 * typeEng * timeFactor * dayFactor * (0.8 + rand() * 0.4);
    const total = Math.round(reach * erBase);
    const saves = Math.round(total * (type === 'CAROUSEL' ? 0.22 : 0.1) * (0.8 + rand() * 0.4));
    const shares = Math.round(total * (type === 'REELS' ? 0.09 : 0.04) * (0.8 + rand() * 0.4));
    const comments = Math.max(0, Math.round(total * 0.04 * (0.5 + rand())));
    const likes = Math.max(0, total - saves - shares - comments);

    const post = {
      id: `demo_${i}`,
      timestamp: ts.toISOString(),
      type,
      caption: `${title}\n\n${tags.join(' ')}`,
      permalink: '',
      thumbnail: '',
      likes,
      comments,
      saves,
      shares,
      reach,
      // フォロワー以外へのリーチ：リールは発見タブ経由で外に広がりやすい（乱数は使わず、他の値から決める）
      nonFollowerReach: Math.round(reach * (type === 'REELS' ? 0.58 : type === 'CAROUSEL' ? 0.32 : 0.24) * (0.85 + (likes % 30) / 100)),
      views: Math.round(reach * (type === 'REELS' ? 1.4 + rand() * 0.6 : 1.1 + rand() * 0.3)),
      follows: Math.max(0, Math.round(total * 0.05 * (0.4 + rand()))),
      account: 'demo_account',
      accountName: 'デモサロン',
      duration: type === 'REELS' ? 20 + Math.round(rand() * 80) : 0,
    };
    posts.push(post);
    tracked.push({ post, dateKey });
    postBoostByDate.set(dateKey, (postBoostByDate.get(dateKey) || 0) + reach / 1000);
  }

  // ---- 投稿ごとの日次スナップショット ----
  // 「毎日データを取り込んでいる」状態を再現する。直近30日分を、
  // その45日前までに投稿されたものについて作る（それより古い投稿はもう動かない）。
  const SNAP_DAYS = 30;
  const TRACK_DAYS = 45;
  const snapFrom = addDays(endKey, -(SNAP_DAYS - 1));
  const trackFrom = addDays(endKey, -(TRACK_DAYS - 1));
  // 投稿してから d 日目までに最終値の何割まで伸びるか（指標ごとに伸び方が違う）
  const share = (d, tau) => 1 - Math.exp(-(d + 0.7) / tau);
  const TAU = { likes: 1.1, comments: 1.3, saves: 2.1, shares: 1.6, reach: 1.2, views: 1.4, follows: 2.4, nonFollowerReach: 1.5 };
  const postHistory = [];
  for (const { post, dateKey } of tracked) {
    if (dateKey < trackFrom) continue;
    const from = dateKey > snapFrom ? dateKey : snapFrom;
    for (let date = from; date <= endKey; date = addDays(date, 1)) {
      const d = Math.round((parseDateKey(date) - parseDateKey(dateKey)) / DAY_MS);
      const row = { id: post.id, date };
      for (const [k, tau] of Object.entries(TAU)) {
        // 最終日はちょうど投稿一覧の値（集計の合計と食い違わないように）
        row[k] = date === endKey ? post[k] : Math.round(post[k] * share(d, tau));
      }
      postHistory.push(row);
    }
  }

  // ---- 日次アカウントデータ ----
  const daily = [];
  let followers = 4820;
  for (let i = 0; i < days; i++) {
    const dateKey = addDays(startKey, i);
    const boost = postBoostByDate.get(dateKey) || 0;
    const gained = Math.round(6 + boost * 3.2 + rand() * 8 + (i / days) * 6);
    let lost = Math.round(3 + rand() * 7);
    // 何回かキャンペーン終了後の離脱を入れる
    if (i % 41 === 40) lost += 45 + Math.round(rand() * 20);
    const net = gained - lost;
    followers += net;
    const reach = Math.round(900 + boost * 820 + rand() * 500 + i * 6);
    const visits = Math.round(reach * (0.028 + rand() * 0.012));
    daily.push({
      date: dateKey,
      followers,
      netChange: net,
      follows: gained,
      unfollows: lost,
      reach,
      nonFollowerReach: Math.round(reach * (0.34 + (i % 9) / 100)),
      views: Math.round(reach * (3.2 + rand() * 1.4)),
      profileVisits: visits,
      linkClicks: Math.round(visits * (0.55 + rand() * 0.35)),
      interactions: Math.round(boost * 9 + 4 + rand() * 10),
      engagedAccounts: null,
    });
  }

  return {
    source: 'demo',
    account: { username: 'demo_account', followersCount: followers, mediaCount: posts.length },
    daily,
    posts,
    // 毎日データを取り込んだときに溜まる、投稿ごとの推移
    postHistory,
    // Meta の「オーディエンス」エクスポートに相当するデモ値
    audience: {
      followersTotal: followers,
      ageSeries: [
        { key: 'women', label: '女性' },
        { key: 'men', label: '男性' },
      ],
      ageGender: [
        { age: '18-24', women: 6.4, men: 1.1 },
        { age: '25-34', women: 28.2, men: 4.3 },
        { age: '35-44', women: 30.1, men: 5.2 },
        { age: '45-54', women: 15.3, men: 3.8 },
        { age: '55-64', women: 4.1, men: 0.9 },
        { age: '65+', women: 0.4, men: 0.2 },
      ],
      countries: [
        { name: '日本', value: 92.4 },
        { name: '台湾', value: 3.1 },
        { name: 'アメリカ合衆国', value: 1.2 },
        { name: '韓国', value: 0.8 },
      ],
      cities: [
        { name: '大阪市, 日本', value: 18.6 },
        { name: '神戸市, 日本', value: 7.2 },
        { name: '京都市, 日本', value: 5.4 },
        { name: '堺市, 日本', value: 3.9 },
        { name: '西宮市, 日本', value: 2.8 },
      ],
    },
    fetchedAt: new Date().toISOString(),
  };
}
