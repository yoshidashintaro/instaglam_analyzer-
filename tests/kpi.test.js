// KPI ツリー（KGI・段階別 KPI）と、5段階のファネル
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KPI_DEFS, KPI_STAGES, DAYS_PER_MONTH,
  kpiDef, kpiValues, kpiRows, kpiByStage, stageFunnel, kpiInsights, withGoals, periodDays,
} from '../public/js/kpi.js';

const post = (type, { saves = 0, shares = 0, reach = null } = {}) => ({ type, saves, shares, reach });

/** 運用で決めたベースラインどおりの、ちょうど1か月ぶんのデータ */
const baseInput = () => ({
  summary: {
    days: 30,
    followerChange: 75,
    totals: { netChange: 75, profileVisits: 1000, follows: 39, nonFollowerReach: 126000, reach: 150000, linkClicks: 300 },
  },
  posts: [
    ...Array.from({ length: 8 }, () => post('REELS', { saves: 4, shares: 0, reach: 5000 })),
    ...Array.from({ length: 5 }, () => post('CAROUSEL', { saves: 18, shares: 0, reach: 6000 })),
  ],
  // Instagram からの HP 流入 900（うちオーガニック 710・広告 190）
  traffic: { breakdown: { totals: { sessions: 900, organic: 710, paid: 190 }, organicTapRate: 6.7 } },
  si: null,
});

test('KPI の定義が運用の表どおりに入っている', () => {
  assert.equal(KPI_DEFS.length, 10);
  assert.deepEqual(
    KPI_DEFS.map((d) => [d.key, d.stage, d.baseline, d.target]),
    [
      ['interestGain', 'kgi', 200, 400],
      ['hpReferrals', 'kgi', 710, 900],
      ['saves', 'keep', 122, 250],
      ['carouselSaveRate', 'keep', 0.3, 0.6],
      ['reels', 'see', 8, 12],
      ['nonFollowerReach', 'see', 126000, 150000],
      ['followRate', 'connect', 3.9, 5.0],
      ['netFollowers', 'connect', 75, 150],
      ['hpSessions', 'bridge', 710, 900],
      ['organicTapRate', 'bridge', 6.7, 6.7],
    ],
  );
  // すべての KPI がいずれかの段階に属する
  const stages = new Set(KPI_STAGES.map((s) => s.key));
  for (const d of KPI_DEFS) assert.ok(stages.has(d.stage), `${d.key} の段階が不明`);
  assert.equal(kpiDef('saves').label, '保存数');
  assert.equal(kpiDef('nope'), null);
});

test('kpiValues: 定義どおりに期間の実測値を取り出す', () => {
  const v = kpiValues(baseInput());
  assert.equal(v.saves, 8 * 4 + 5 * 18, '全投稿の保存の合計');
  assert.equal(v.netFollowers, 75);
  assert.equal(v.interestGain, 122 + 75, 'KGI は保存＋純増');
  assert.equal(v.reels, 8);
  assert.equal(v.nonFollowerReach, 126000);
  // カルーセルだけで計算する（リールは分母に入れない）
  assert.equal(v.carouselSaveRate, (90 / 30000) * 100);
  assert.equal(v.followRate, 3.9);
  assert.equal(v.hpSessions, 900, '5. HPへは広告を含む Instagram からの誘導数');
  assert.equal(v.hpReferrals, 710, 'KGI は広告を除く');
  assert.equal(v.organicTapRate, 6.7);
});

test('kpiValues: ソーシャルインサイトの実測値があればそちらを優先する', () => {
  const input = baseInput();
  input.si = { totals: { profileVisits: 2000, follows: 100, nonFollowerReach: 200000 } };
  const v = kpiValues(input);
  assert.equal(v.followRate, 5, '実測のプロフィールアクセス・フォローで計算する');
  assert.equal(v.nonFollowerReach, 200000);
});

test('kpiValues: データが無い指標は null（0 と区別する）', () => {
  const v = kpiValues({ summary: { totals: {} }, posts: [], traffic: null, si: null });
  assert.equal(v.saves, null);
  assert.equal(v.reels, null);
  assert.equal(v.interestGain, null);
  assert.equal(v.carouselSaveRate, null);
  assert.equal(v.followRate, null);
  assert.equal(v.hpSessions, null);
});

test('kpiRows: 30日ぶんならベースラインちょうど、状態は「順調」', () => {
  const rows = kpiRows(kpiValues(baseInput()), 30);
  const by = (k) => rows.find((r) => r.key === k);
  // 30日 → 月あたり（30.4日）に引き伸ばす
  assert.ok(Math.abs(by('saves').monthly - 122 * (DAYS_PER_MONTH / 30)) < 1e-9);
  assert.equal(by('saves').status, 'onTrack');
  assert.equal(by('followRate').monthly, 3.9, '率は期間の長さで割らない');
  assert.equal(by('followRate').status, 'onTrack');
  // 「維持」が目標の指標は、基準以上なら到達
  assert.equal(by('organicTapRate').hold, true);
  assert.equal(by('organicTapRate').status, 'reached');
  assert.equal(by('organicTapRate').progress, null);
});

test('kpiRows: 90日ぶんのデータでも月あたりに直して比べる', () => {
  const input = baseInput();
  // 90日で3か月ぶん（保存366・純増225）＝ 月あたりはベースラインと同じ
  input.posts = [...input.posts, ...input.posts, ...input.posts];
  input.summary.totals.netChange = 225;
  const rows = kpiRows(kpiValues(input), 90);
  const saves = rows.find((r) => r.key === 'saves');
  assert.ok(Math.abs(saves.monthly - 122 * (DAYS_PER_MONTH / 30)) < 1e-9, '90日でも月あたりは同じ');
  assert.equal(rows.find((r) => r.key === 'reels').monthly.toFixed(1), (24 * (DAYS_PER_MONTH / 90)).toFixed(1));
});

test('kpiRows: 目標到達・未達・達成率', () => {
  const input = baseInput();
  // 保存を倍にすると目標 250 を超える
  input.posts = input.posts.map((p) => ({ ...p, saves: p.saves * 3 }));
  const rows = kpiRows(kpiValues(input), 30);
  const saves = rows.find((r) => r.key === 'saves');
  assert.equal(saves.status, 'reached');
  assert.ok(saves.progress > 100);
  assert.ok(saves.gap < 0, '目標を超えた分はマイナスの差になる');

  // 半分ならベースライン割れ
  const low = kpiRows(kpiValues({ ...baseInput(), posts: baseInput().posts.map((p) => ({ ...p, saves: 1 })) }), 30);
  const lowSaves = low.find((r) => r.key === 'saves');
  assert.equal(lowSaves.status, 'behind');
  assert.ok(lowSaves.progress < 0);
});

test('kpiRows: データが無ければ status は none', () => {
  const rows = kpiRows({}, 30);
  assert.ok(rows.every((r) => r.status === 'none' && r.monthly === null));
  // 期間が 0 日でも落ちない
  assert.ok(kpiRows(kpiValues(baseInput()), 0).every((r) => r.kind === 'rate' || r.monthly === null));
});

test('withGoals / kpiRows: ベースラインと目標を画面から変えられる', () => {
  const def = withGoals(kpiDef('saves'), { saves: { baseline: 150, target: 300 } });
  assert.equal(def.baseline, 150);
  assert.equal(def.target, 300);
  // 一部だけ変えたときは、変えていない方は既定値のまま
  assert.equal(withGoals(kpiDef('saves'), { saves: { target: 300 } }).baseline, 122);
  assert.equal(withGoals(kpiDef('saves'), {}).target, 250);

  const rows = kpiRows(kpiValues(baseInput()), 30, { saves: { baseline: 150, target: 300 } });
  assert.equal(rows.find((r) => r.key === 'saves').status, 'behind', '基準を上げると未達になる');
});

test('kpiByStage: 段階ごとにまとまり、空の段階は出さない', () => {
  const groups = kpiByStage(kpiRows(kpiValues(baseInput()), 30));
  // 「深める」には KPI が無いので、表には出てこない
  assert.deepEqual(groups.map((g) => g.key), ['kgi', 'see', 'keep', 'connect', 'bridge']);
  assert.deepEqual(groups.find((g) => g.key === 'keep').rows.map((r) => r.key), ['saves', 'carouselSaveRate']);
});

test('stageFunnel: 5段階と、それぞれの通過率', () => {
  const steps = stageFunnel(baseInput());
  assert.deepEqual(steps.map((s) => s.key), ['see', 'keep', 'deepen', 'connect', 'bridge']);
  const by = (k) => steps.find((s) => s.key === k);
  assert.equal(by('see').value, 126000);
  assert.equal(by('see').rate, (126000 / 150000) * 100);
  assert.equal(by('keep').value, 122, '保存＋シェア');
  assert.equal(by('connect').value, 39);
  assert.equal(by('connect').rate, 3.9, 'プロフィールアクセスに対するフォロー率');
  // 3. 深める：プロフィールアクセス ÷ フォロワー以外へのリーチ（広告込み）
  assert.equal(by('deepen').value, 1000);
  assert.equal(by('deepen').from, 126000);
  assert.equal(by('deepen').rate, (1000 / 126000) * 100);
  assert.equal(by('deepen').metric, 'プロフィールアクセス数');
  // 5. HPへ：インスタからHPへの誘導数（広告含む）。週がそろっていなければ率は出さない
  assert.equal(by('bridge').value, 900);
  assert.equal(by('bridge').metric, 'インスタからHPへの誘導数（広告含む・セッション）');
  assert.match(by('bridge').note, /うちオーガニック 710・広告 190/);
  assert.equal(by('bridge').rate, null);
  assert.equal(by('bridge').rateIsLanding, true);
});

test('stageFunnel: GA4 が無ければリンククリックを4段階目にする', () => {
  const input = { ...baseInput(), traffic: null };
  const bridge = stageFunnel(input).find((s) => s.key === 'bridge');
  assert.equal(bridge.value, 300);
  assert.equal(bridge.metric, 'リンククリック');
  assert.equal(bridge.rateIsLanding, false);
});

test('stageFunnel: 面別の内訳があれば広告とそれ以外の閲覧を添える', () => {
  const input = baseInput();
  input.si = { surfaces: [
    { key: 'ads', values: { views: 80000 } },
    { key: 'feed', values: { views: 15000 } },
    { key: 'reels', values: { views: 5000 } },
  ] };
  const see = stageFunnel(input).find((s) => s.key === 'see');
  assert.match(see.note, /広告からが 80,000回/);
  assert.match(see.note, /それ以外が 20,000回/);
});

test('stageFunnel: データが無くても落ちない', () => {
  const steps = stageFunnel({ summary: { totals: {} }, posts: [] });
  assert.equal(steps.length, 5);
  assert.ok(steps.every((s) => s.rate === null));
});

test('kpiInsights: KGI の達成状況と、基準割れの指標をまとめる', () => {
  const rows = kpiRows(kpiValues(baseInput()), 30);
  const ins = kpiInsights(rows, { days: 30 });
  assert.match(ins[0].title, /KGI/);
  // 運用表のベースライン 200 は「保存122＋純増75＝197」を丸めた値なので、
  // 実測が内訳どおりでも 200 にわずかに届かない。丸めで判定が変わることを明示しておく。
  assert.equal(ins[0].level, 'warn', '197 < 200 なので基準割れ');

  // 基準を実際の内訳（197）に直すと「順調」になる
  const fixed = kpiRows(kpiValues(baseInput()), 30, { interestGain: { baseline: 197 } });
  assert.equal(kpiInsights(fixed, { days: 30 })[0].level, 'info');
  // 期間が短いときは注意を出す
  assert.ok(kpiInsights(rows, { days: 7 }).some((i) => i.title.includes('期間が短い')));
  assert.ok(!kpiInsights(rows, { days: 30 }).some((i) => i.title.includes('期間が短い')));
  // データが無ければ何も言わない
  assert.deepEqual(kpiInsights(kpiRows({}, 30), { days: 30 }), []);
});

test('periodDays: 両端を含む日数', () => {
  assert.equal(periodDays('2026-10-01', '2026-10-30'), 30);
  assert.equal(periodDays('2026-10-01', '2026-10-01'), 1);
});

test('stageFunnel: リーチ内訳にオーガニック／広告があれば、1段階目に実数を添える', () => {
  const input = baseInput();
  input.reach = {
    account: 'miselclinic_osaka', start: '2026-04-01', end: '2026-10-19',
    total: 190335, followers: 4734, nonFollowers: 186159, ratio: 97.8,
    organic: 46907, ads: 152582, adRatio: 80.2,
  };
  const see = stageFunnel(input).find((s) => s.key === 'see');
  assert.match(see.metric, /広告込み/, '広告を含む数字であることを明示する');
  assert.match(see.note, /オーガニック 46,907/);
  assert.match(see.note, /広告 152,582/);
  assert.match(see.note, /広告比率 80\.2%/);
  assert.match(see.note, /合計とは一致しません/, '重複カウントの注意を出す');
  assert.match(see.note, /2026\/04\/01〜2026\/10\/19/, 'どの期間の書き出しかを示す');
});

test('kpiRows: 値の入っている日数で月あたりに直す（取り込んでいない日で薄めない）', () => {
  const input = baseInput();
  // 期間は90日だが、日次データは30日分しか無い
  input.daily = Array.from({ length: 30 }, (_, i) => ({
    date: `2026-09-${String(i + 1).padStart(2, '0')}`,
    nonFollowerReach: 4200,
    netChange: 2.5,
  }));
  const rows = kpiRows(kpiValues(input), 90);
  const nf = rows.find((r) => r.key === 'nonFollowerReach');
  // 126,000 は30日ぶんの合計なので、月あたりもほぼ同じ（90で割らない）
  assert.ok(Math.abs(nf.monthly - 126000 * (DAYS_PER_MONTH / 30)) < 1, `薄まっています: ${nf.monthly}`);
  assert.equal(nf.days, 30);
  // 投稿由来の指標は期間全体（投稿が無い日は0件として数える）
  assert.equal(rows.find((r) => r.key === 'saves').days, 90);
});

test('kpiRows: KGI は内訳それぞれの月あたりを足して出す', () => {
  const input = baseInput();
  input.daily = Array.from({ length: 30 }, () => ({ date: '2026-09-01', netChange: 2.5 }));
  const rows = kpiRows(kpiValues(input), 30);
  const by = (k) => rows.find((r) => r.key === k).monthly;
  assert.ok(Math.abs(by('interestGain') - (by('saves') + by('netFollowers'))) < 1e-9);
});

// ---------- 4段階目（HPへ）の期間ズレ対策 ----------

test('stageFunnel: GA4 とリーチの期間が違っても、そろう週だけで通過率を出す', () => {
  const input = baseInput();
  // GA4 は90日分（4,017セッション）、リンククリックは28日分（4,014回）という実際によくある形
  input.summary.totals.linkClicks = 4014;
  input.traffic = {
    breakdown: { totals: { sessions: 4500, organic: 4017, paid: 483 }, organicTapRate: 6.7, weeks: 13 },
    // 両方そろう週だけの集計（広告を含む）
    bridge: { weeks: 2, reach: 60000, sessions: 331, organic: 300, paid: 31, clicks: 2019, rate: (331 / 60000) * 100 },
    properties: ['miselcl'],
  };
  const bridge = stageFunnel(input).find((s) => s.key === 'bridge');
  assert.equal(bridge.value, 331, '期間のそろった週のセッション数を使う');
  assert.equal(bridge.from, 60000, 'フォロワー以外へのリーチ（広告込み）と比べる');
  assert.equal(bridge.fromLabel, 'フォロワー以外へのリーチ（広告込み）');
  assert.match(bridge.note, /2週で比較/);
  assert.match(bridge.note, /うちオーガニック 300・広告 31/);
  assert.match(bridge.note, /同じ期間のリンククリックは 2,019回（オーガニック流入の到達率 14.9%）/);
  assert.match(bridge.note, /期間全体の誘導数は 4,500セッション（うちオーガニック 4,017・広告 483）/);
});

test('stageFunnel: 期間が重なっていなければ通過率を出さない（誤った比率を見せない）', () => {
  const input = baseInput();
  input.summary.totals.linkClicks = 4014;
  input.traffic = { breakdown: { totals: { sessions: 5000, organic: 4683, paid: 317 }, weeks: 13 }, bridge: null, properties: [] };
  const bridge = stageFunnel(input).find((s) => s.key === 'bridge');
  assert.equal(bridge.value, 5000);
  assert.equal(bridge.rate, null, '比べられないので率は出さない');
  assert.match(bridge.note, /期間が重なっていない/);
  assert.match(bridge.note, /同じ期間で書き出し直す/);
});

test('stageFunnel: 到達率（リンククリックに対する割合）も補足として出す', () => {
  const input = baseInput();
  input.traffic = {
    breakdown: { totals: { sessions: 900, organic: 900, paid: 0 }, weeks: 4 },
    bridge: { weeks: 3, reach: 50000, sessions: 130, organic: 130, paid: 0, clicks: 100, rate: (130 / 50000) * 100 },
    properties: [],
  };
  const bridge = stageFunnel(input).find((s) => s.key === 'bridge');
  assert.ok(bridge.rate < 1, '認知に対する割合なので小さくなる');
  assert.match(bridge.note, /到達率 130.0%/, 'リンククリックに対する割合は補足として残す');
});

test('stageFunnel: GA4 プロパティが複数あれば、合計であることを明示する', () => {
  const input = baseInput();
  input.traffic = {
    breakdown: { totals: { sessions: 900, organic: 900, paid: 0 }, weeks: 4 },
    bridge: { weeks: 3, reach: 50000, sessions: 200, organic: 200, paid: 0, clicks: 1000, rate: 0.4 },
    properties: ['miselcl', 'misel', 'tadaoka'],
  };
  const bridge = stageFunnel(input).find((s) => s.key === 'bridge');
  assert.match(bridge.note, /対象プロパティ: miselcl・misel・tadaoka の合計/);
});

test('kpiRows: GA4 のプロパティ名を行に添える（何を合計したか分かるように）', () => {
  const input = baseInput();
  input.traffic = { breakdown: { totals: { sessions: 900, organic: 710, paid: 190 }, organicTapRate: 6.7, weeks: 4 }, properties: ['miselcl', 'misel'] };
  const row = kpiRows(kpiValues(input), 30).find((r) => r.key === 'hpSessions');
  assert.equal(row.dataNote, 'GA4 プロパティ: miselcl・misel の合計');
  // 1つだけなら「の合計」は付けない
  input.traffic.properties = ['miselcl'];
  assert.equal(kpiRows(kpiValues(input), 30).find((r) => r.key === 'hpSessions').dataNote, 'GA4 プロパティ: miselcl');
  // GA4 が無ければ注記なし
  assert.equal(kpiRows(kpiValues({ ...baseInput(), traffic: null }), 30).find((r) => r.key === 'hpSessions').dataNote, null);
});
