// KPI ツリーと、投稿を見た人がたどる4段階（見る → 残す → つながる → HPへ）。
//
// 運用で決めた指標の定義・ベースライン・目標をここに1か所でまとめ、
// 期間の合計から「月あたり」に直して進捗を出す。
// ベースラインと目標は画面から変更でき、設定として保存する。
import { DAY_MS, parseDateKey } from './analytics.js';

/** 月あたりに直すときの1か月の日数（30.4日＝365÷12） */
export const DAYS_PER_MONTH = 365 / 12;

/** ファネルの段階。KPI はどれかの段階に属する */
export const KPI_STAGES = [
  { key: 'kgi', label: 'KGI', note: '最終目標。興味を持った人がどれだけ増えたか' },
  { key: 'see', label: '1. 見る（認知）', note: 'リールを最後まで見る・カルーセルを最後までめくる' },
  { key: 'keep', label: '2. 残す（興味）', note: '保存・シェア。興味関心層になった証拠で、ここが最重要' },
  { key: 'connect', label: '3. つながる（関係化）', note: 'プロフィール訪問 → フォロー' },
  { key: 'bridge', label: '4. HPへ（検討への橋渡し）', note: 'プロフィールのリンクから HP・LINE へ。ここから先は LINE・広告・HP が担う' },
];

/**
 * KPI の定義。
 * kind: 'monthly' … 期間合計を月あたりに直して比べる
 *       'rate'    … 率なので期間の長さで割らない
 */
export const KPI_DEFS = [
  {
    key: 'interestGain', stage: 'kgi', kind: 'monthly', unit: '',
    label: '興味関心層の獲得数', def: '保存数 ＋ フォロワー純増',
    baseline: 200, target: 400, source: 'インサイト',
    note: '保存とフォロワー純増は「興味を持った人が取った行動」なので、足して1本の目標にしています。',
  },
  {
    key: 'saves', stage: 'keep', kind: 'monthly', unit: '',
    label: '保存数', def: '全投稿の保存の合計',
    baseline: 122, target: 250, source: 'インサイト',
  },
  {
    key: 'carouselSaveRate', stage: 'keep', kind: 'rate', unit: '%', digits: 2,
    label: 'カルーセル保存率', def: 'カルーセル投稿の保存 ÷ カルーセル投稿のリーチ',
    baseline: 0.3, target: 0.6, source: 'インサイト（投稿別）',
  },
  {
    key: 'reels', stage: 'see', kind: 'monthly', unit: '本', digits: 1,
    label: 'リール本数', def: 'フィードに出したリールの本数',
    baseline: 8, target: 12, source: '投稿実績', targetNote: '週3本',
  },
  {
    key: 'nonFollowerReach', stage: 'see', kind: 'monthly', unit: '',
    label: '非フォロワーリーチ（広告込み）', def: 'リーチのうちフォロワー以外（広告配信分を含む）',
    baseline: 126000, target: 150000, source: 'インサイト（リーチの内訳）',
    note: '広告の出し方に大きく左右されます。投稿そのものの実力は、同じカードのオーガニック分で見てください。',
  },
  {
    key: 'followRate', stage: 'connect', kind: 'rate', unit: '%', digits: 1,
    label: 'プロフィール→フォロー率', def: '新規フォロー ÷ プロフィールアクセス',
    baseline: 3.9, target: 5.0, source: 'インサイト',
  },
  {
    key: 'netFollowers', stage: 'connect', kind: 'monthly', unit: '人',
    label: 'フォロワー純増', def: 'フォロー − フォロー解除',
    baseline: 75, target: 150, source: 'インサイト',
  },
  {
    key: 'organicSessions', stage: 'bridge', kind: 'monthly', unit: '',
    label: 'オーガニックHP流入', def: '広告を除く Instagram 経由のセッション',
    baseline: 710, target: 900, source: 'GA4（UTM別）', targetNote: '+25%',
  },
  {
    key: 'organicTapRate', stage: 'bridge', kind: 'rate', unit: '%', digits: 1,
    label: '予約タップ率（オーガニック）', def: '予約ボタンのタップ ÷ セッション',
    baseline: 6.7, target: 6.7, source: 'GA4', targetNote: '維持',
  },
];

export const kpiDef = (key) => KPI_DEFS.find((d) => d.key === key) || null;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sum = (list, get) => {
  const vs = list.map(get).filter((v) => v !== null && v !== undefined);
  return vs.length ? vs.reduce((s, v) => s + v, 0) : null;
};
const ratio = (a, b) => (a === null || !b ? null : (a / b) * 100);

/** 期間の日数（両端を含む） */
export const periodDays = (startKey, endKey) =>
  Math.round((parseDateKey(endKey) - parseDateKey(startKey)) / DAY_MS) + 1;

/**
 * 期間の実測値を KPI ごとに取り出す。
 * monthly の指標は「期間の合計」、rate の指標は「率そのもの」を返す。
 * データが無い指標は null（0 と区別する）。
 */
/** その指標の値が入っている日数（取り込んでいない日を「0」として薄めないため） */
const daysWith = (daily, ...fields) => {
  const n = daily.filter((d) => fields.some((f) => d[f] !== null && d[f] !== undefined)).length;
  return n || null;
};

export function kpiValues({ summary, posts = [], daily = [], traffic = null, si = null }) {
  const byType = (type) => posts.filter((p) => p.type === type);
  const carousel = byType('CAROUSEL');
  const carouselSaves = sum(carousel, (p) => p.saves);
  const carouselReach = sum(carousel, (p) => p.reach);

  const totals = summary?.totals || {};
  const saves = sum(posts, (p) => p.saves);
  // 純増は「フォロー − フォロー解除」の合計。日次が無ければフォロワー数の差で代用する
  const netFollowers = num(totals.netChange) ?? num(summary?.followerChange);
  // プロフィールアクセスとフォローは、ソーシャルインサイトの実測値があればそちらを優先する
  const profileVisits = num(si?.totals?.profileVisits) ?? num(totals.profileVisits);
  const follows = num(si?.totals?.follows) ?? num(totals.follows);

  return {
    saves,
    netFollowers,
    interestGain: saves === null && netFollowers === null ? null : (saves ?? 0) + (netFollowers ?? 0),
    carouselSaveRate: ratio(carouselSaves, carouselReach),
    reels: posts.length ? byType('REELS').length : null,
    nonFollowerReach: num(si?.totals?.nonFollowerReach) ?? num(totals.nonFollowerReach),
    followRate: ratio(follows, profileVisits),
    organicSessions: num(traffic?.breakdown?.totals?.organic),
    organicTapRate: num(traffic?.breakdown?.organicTapRate),
    // 月あたりに直すときに使う「その指標の値が入っている日数」。
    // 取り込んでいない日を 0 として薄めてしまわないようにする
    coverage: {
      nonFollowerReach: daysWith(daily, 'nonFollowerReach'),
      netFollowers: daysWith(daily, 'netChange', 'follows'),
      // GA4 は週単位で突き合わせているので、週数×7 を日数とみなす
      organicSessions: traffic?.breakdown?.weeks ? traffic.breakdown.weeks * 7 : null,
    },
  };
}

/** 保存しているベースライン・目標を定義に重ねる（未設定なら既定値） */
export function withGoals(def, goals = {}) {
  const g = goals[def.key] || {};
  return {
    ...def,
    baseline: num(g.baseline) ?? def.baseline,
    target: num(g.target) ?? def.target,
  };
}

/**
 * KPI ごとの進捗。
 * @param {object} values kpiValues の結果
 * @param {number} days 期間の日数（月あたりへの換算に使う）
 * @param {object} goals 画面から変更したベースライン・目標
 */
export function kpiRows(values, days, goals = {}) {
  const rows = KPI_DEFS.map((base) => {
    const def = withGoals(base, goals);
    const raw = values[def.key] ?? null;
    // 月あたりに直す（率はそのまま）。その指標の値が入っている日数が分かればそちらを使う
    const span = values.coverage?.[def.key] ?? days;
    const factor = span > 0 ? DAYS_PER_MONTH / span : null;
    const monthly = def.kind === 'monthly' ? (raw === null || factor === null ? null : raw * factor) : raw;
    const hold = def.target === def.baseline; // 「維持」が目標
    let status = 'none';
    let progress = null;
    if (monthly !== null) {
      if (hold) status = monthly >= def.baseline ? 'reached' : 'behind';
      else {
        progress = ((monthly - def.baseline) / (def.target - def.baseline)) * 100;
        status = monthly >= def.target ? 'reached' : monthly >= def.baseline ? 'onTrack' : 'behind';
      }
    }
    return {
      ...def,
      raw,
      monthly,
      hold,
      status,
      progress,
      // 目標まであといくつか（率はポイント差）
      gap: monthly === null ? null : def.target - monthly,
      perMonth: def.kind === 'monthly',
      days: span,
    };
  });

  // KGI は内訳（保存・純増）の月あたりを足して出す。
  // 2つは値の入っている日数が違うことがあるので、合計してから割ると合わなくなる
  const monthlyOf = (key) => rows.find((r) => r.key === key)?.monthly ?? null;
  const kgi = rows.find((r) => r.key === 'interestGain');
  const saves = monthlyOf('saves');
  const net = monthlyOf('netFollowers');
  if (kgi && (saves !== null || net !== null)) {
    kgi.monthly = (saves ?? 0) + (net ?? 0);
    kgi.status = kgi.monthly >= kgi.target ? 'reached' : kgi.monthly >= kgi.baseline ? 'onTrack' : 'behind';
    kgi.progress = ((kgi.monthly - kgi.baseline) / (kgi.target - kgi.baseline)) * 100;
    kgi.gap = kgi.target - kgi.monthly;
  }
  return rows;
}

/** 段階ごとにまとめる（画面の並びに使う） */
export function kpiByStage(rows) {
  return KPI_STAGES.map((s) => ({ ...s, rows: rows.filter((r) => r.stage === s.key) })).filter((s) => s.rows.length);
}

/**
 * 「見る → 残す → つながる → HPへ」の4段階。
 * 段階ごとに代表の数字と、1つ前の段階からの通過率を出す。
 * リーチは広告の影響が大きいので、オーガニック分が分かるときは併記する。
 */
export function stageFunnel({ summary, posts = [], traffic = null, si = null, reach = null }) {
  const totals = summary?.totals || {};
  const nonFollowerReach = num(si?.totals?.nonFollowerReach) ?? num(totals.nonFollowerReach);
  const reachTotal = num(si?.totals?.reach) ?? num(totals.reach);
  const saves = sum(posts, (p) => p.saves);
  const shares = sum(posts, (p) => p.shares);
  const kept = saves === null && shares === null ? null : (saves ?? 0) + (shares ?? 0);
  const profileVisits = num(si?.totals?.profileVisits) ?? num(totals.profileVisits);
  const follows = num(si?.totals?.follows) ?? num(totals.follows);
  const linkClicks = num(totals.linkClicks);
  const sessions = num(traffic?.breakdown?.totals?.organic);

  // 面別の内訳があれば、広告を除いたリーチ・閲覧も出す
  const surfaces = si?.surfaces || [];
  const organicViews = surfaces.filter((s) => s.key !== 'ads').reduce((s, x) => s + (x.values.views ?? 0), 0) || null;
  const adViews = surfaces.find((s) => s.key === 'ads')?.values.views ?? null;

  // リーチ内訳の書き出しにオーガニック／広告が入っていれば、それを最優先で添える
  const seeNote = reach?.organic !== null && reach?.organic !== undefined
    ? `うちオーガニック ${Math.round(reach.organic).toLocaleString('ja-JP')}・広告 ${Math.round(reach.ads ?? 0).toLocaleString('ja-JP')}` +
      `${reach.adRatio === null || reach.adRatio === undefined ? '' : `（広告比率 ${reach.adRatio.toFixed(1)}%）`}` +
      `　※ 同じ人が両方に数えられるため、合計とは一致しません（${reach.start.replaceAll('-', '/')}〜${reach.end.replaceAll('-', '/')} の書き出し）`
    : adViews
      ? `閲覧のうち広告からが ${Math.round(adViews).toLocaleString('ja-JP')}回、それ以外が ${Math.round(organicViews ?? 0).toLocaleString('ja-JP')}回`
      : '';

  const steps = [
    {
      key: 'see', label: '1. 見る（認知）', value: nonFollowerReach, unit: '',
      metric: 'フォロワー以外へのリーチ（広告込み）',
      from: reachTotal, fromLabel: 'リーチ全体',
      note: seeNote,
    },
    {
      key: 'keep', label: '2. 残す（興味）', value: kept, unit: '件',
      metric: '保存＋シェア',
      from: reachTotal, fromLabel: 'リーチ全体',
      note: saves !== null || shares !== null ? `保存 ${(saves ?? 0).toLocaleString('ja-JP')}件・シェア ${(shares ?? 0).toLocaleString('ja-JP')}件` : '',
    },
    {
      key: 'connect', label: '3. つながる（関係化）', value: follows, unit: '人',
      metric: '新規フォロー',
      from: profileVisits, fromLabel: 'プロフィールアクセス',
      note: profileVisits ? `プロフィールアクセス ${Math.round(profileVisits).toLocaleString('ja-JP')}件` : '',
    },
    // GA4 があれば「リンククリック → 実際に着地したセッション」、無ければ
    // 「プロフィールアクセス → リンククリック」を4段階目として見る（同じ数字どうしを比べない）
    sessions !== null
      ? {
          key: 'bridge', label: '4. HPへ（橋渡し）', value: sessions, unit: '',
          metric: 'オーガニックHP流入（セッション）',
          from: linkClicks, fromLabel: 'リンククリック',
          note: linkClicks === null ? '' : `リンククリック ${Math.round(linkClicks).toLocaleString('ja-JP')}回`,
        }
      : {
          key: 'bridge', label: '4. HPへ（橋渡し）', value: linkClicks, unit: '回',
          metric: 'リンククリック',
          from: profileVisits, fromLabel: 'プロフィールアクセス',
          note: 'GA4 を取り込むと、実際に HP へ着地したセッションまで追えます',
        },
  ];

  return steps.map((s) => ({
    ...s,
    rate: s.value === null || !s.from ? null : (s.value / s.from) * 100,
    // 4段階目は「リンククリックのうち何%が実際に着地したか」なので、同じ数字の比較にならないよう印を付ける
    rateIsLanding: s.key === 'bridge' && sessions !== null,
  }));
}

/** KPI の進捗から、文章のインサイトを作る */
export function kpiInsights(rows, { days = 0 } = {}) {
  const out = [];
  const usable = rows.filter((r) => r.monthly !== null);
  if (!usable.length) return out;

  const fmt = (r, v) =>
    v === null ? '–' : r.unit === '%' ? `${v.toFixed(r.digits ?? 1)}%` : `${Math.round(v).toLocaleString('ja-JP')}${r.unit}`;

  const kgi = usable.find((r) => r.stage === 'kgi');
  if (kgi) {
    out.push({
      level: kgi.status === 'reached' ? 'good' : kgi.status === 'behind' ? 'warn' : 'info',
      title: `KGI「${kgi.label}」は月あたり ${fmt(kgi, kgi.monthly)}`,
      text:
        `ベースライン ${fmt(kgi, kgi.baseline)} / 目標 ${fmt(kgi, kgi.target)}。` +
        (kgi.status === 'reached'
          ? '目標に到達しています。次の期間も同じ水準を保てるか確認しましょう。'
          : kgi.status === 'behind'
            ? `ベースラインを下回っています。内訳（保存・フォロワー純増）のどちらが落ちているかを確認してください。`
            : `目標まであと ${fmt(kgi, kgi.gap)}。達成率は ${kgi.progress === null ? '–' : `${Math.round(kgi.progress)}%`} です。`),
    });
  }

  const behind = usable.filter((r) => r.status === 'behind' && r.stage !== 'kgi');
  if (behind.length) {
    out.push({
      level: 'warn',
      title: `ベースラインを下回っている指標が ${behind.length}件`,
      text: behind.map((r) => `${r.label}（${fmt(r, r.monthly)} / 基準 ${fmt(r, r.baseline)}）`).join('、') + '。段階の前の方から順に手を入れると効果が出やすくなります。',
    });
  }

  const reached = usable.filter((r) => r.status === 'reached' && r.stage !== 'kgi');
  if (reached.length) {
    out.push({
      level: 'good',
      title: `目標に到達している指標が ${reached.length}件`,
      text: reached.map((r) => `${r.label}（${fmt(r, r.monthly)}）`).join('、') + '。',
    });
  }

  if (days && days < 28) {
    out.push({
      level: 'info',
      title: '期間が短いため、月あたりの換算値はぶれます',
      text: `いまの期間は ${days}日間です。月あたりの数値は ${DAYS_PER_MONTH.toFixed(1)}日ぶんに引き伸ばして計算しているため、30日以上の期間で見ることをおすすめします。`,
    });
  }
  return out;
}
