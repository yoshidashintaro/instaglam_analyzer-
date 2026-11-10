// Google Search Console の書き出し（ZIP / CSV）の取り込みテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV } from '../public/js/data/csv.js';
import {
  readSCTable,
  shortcodeOfUrl,
  propertyFromName,
  readSearchConsoleZip,
  readSearchConsoleCSV,
  mergeSearchConsole,
  describeSearchConsole,
  weightedPosition,
  postIndex,
  searchSummary,
  queryRows,
  underperformingQueries,
  sliceSearchDaily,
  instagramProperties,
  siteProperties,
  buildProperty,
  defaultBrandTerms,
  guessBrandTerms,
  brandedQueries,
} from '../public/js/data/searchConsole.js';

// ZIP の組み立てとサンプル CSV は report.test.js と共用する
import { makeZip, makeSearchZip, QUERIES, POSTS, DAILY, DEVICES, COUNTRIES, FILTER, PAGES } from './helpers/searchZip.js';

const igZip = makeSearchZip;

// ---------- 1ファイルの読み取り ----------

test('readSCTable: 切り口を見出しから判別し、指標を数値にする', () => {
  const t = readSCTable(parseCSV(QUERIES));
  assert.equal(t.kind, 'table');
  assert.equal(t.dimension, 'queries');
  assert.deepEqual(t.rows[0], { query: 'ミセルクリニック大阪梅田院', clicks: 96, impressions: 3457, ctr: 2.78, position: 3.25 });
});

test('readSCTable: 投稿一覧は shortcode も取り出す（投稿との突き合わせに使う）', () => {
  const t = readSCTable(parseCSV(POSTS));
  assert.equal(t.dimension, 'posts');
  assert.deepEqual(t.rows.map((r) => r.shortcode), [null, 'C4NXsihS1Ez', 'DEuYle1y4j5']);
});

test('readSCTable: 日付はキー形式にそろえる', () => {
  const t = readSCTable(parseCSV(DAILY));
  assert.equal(t.dimension, 'daily');
  assert.deepEqual(t.rows.map((r) => r.date), ['2026-08-19', '2026-08-20', '2026-08-21']);
});

test('readSCTable: フィルタ.csv は条件として読む', () => {
  const t = readSCTable(parseCSV(FILTER));
  assert.equal(t.kind, 'filter');
  assert.equal(t.filter['検索タイプ'], 'ウェブ（テキストベース）');
});

test('readSCTable: 桁区切りと英語の見出しも読める', () => {
  const t = readSCTable(parseCSV('Top queries,Clicks,Impressions,CTR,Position\nclinic,"1,234","56,789",2.17%,4.5\n'));
  assert.deepEqual(t.rows[0], { query: 'clinic', clicks: 1234, impressions: 56789, ctr: 2.17, position: 4.5 });
});

test('readSCTable: Search Console 以外の表は null（取り込みの誤判別を防ぐ）', () => {
  assert.equal(readSCTable(parseCSV('日付,フォロワー数\n2026-10-01,100\n')), null);
  assert.equal(readSCTable(parseCSV('国,割合\n日本,92.4\n')), null, 'Meta のオーディエンス（国）は claim しない');
  assert.equal(readSCTable(parseCSV('')), null);
});

test('shortcodeOfUrl: 投稿・リール・プロフィールを見分ける', () => {
  assert.equal(shortcodeOfUrl('https://www.instagram.com/p/C4NXsihS1Ez/'), 'C4NXsihS1Ez');
  assert.equal(shortcodeOfUrl('https://www.instagram.com/reel/DEuYle1y4j5/'), 'DEuYle1y4j5');
  assert.equal(shortcodeOfUrl('https://www.instagram.com/miselclinic_osaka/'), null);
});

// ---------- プロパティの判別 ----------

test('propertyFromName: ZIP 名からプロパティと書き出し日を読む', () => {
  assert.deepEqual(propertyFromName('instagram.com_miselclinic_osaka-Performance-on-Search-2026-10-19.zip'), {
    id: 'instagram.com/miselclinic_osaka', kind: 'instagram', account: 'miselclinic_osaka', label: '@miselclinic_osaka', exportedAt: '2026-10-19',
  });
  // アカウント名に「_」が入っていても、区切りはホスト名の直後だけ
  assert.equal(propertyFromName('instagram.com_dr.okudate_miselclinic-Performance-on-Search-2026-10-19').account, 'dr.okudate_miselclinic');
  assert.deepEqual(propertyFromName('miselclinic.com-Performance-on-Search-2026-10-19.zip'), {
    id: 'miselclinic.com', kind: 'site', account: '', label: 'miselclinic.com', exportedAt: '2026-10-19',
  });
});

// ---------- ZIP の取り込み ----------

test('readSearchConsoleZip: 1つの ZIP を 1 プロパティとして読む', async () => {
  const res = await readSearchConsoleZip(igZip(), 'instagram.com_miselclinic_osaka-Performance-on-Search-2026-10-19.zip');
  const p = res.property;
  assert.equal(p.kind, 'instagram');
  assert.equal(p.account, 'miselclinic_osaka');
  assert.equal(p.queries.length, 4);
  assert.equal(p.posts.length, 3);
  assert.equal(p.daily.length, 3);
  assert.equal(p.devices.length, 2);
  assert.equal(p.countries.length, 2);
  assert.equal(p.filter['検索タイプ'], 'ウェブ（テキストベース）');
  assert.match(describeSearchConsole(p, res.read), /@miselclinic_osaka/);
});

test('readSearchConsoleZip: アカウント名は投稿一覧のプロフィール URL で確かめる', async () => {
  // ZIP 名が曖昧でも、中身の URL から正しいアカウント名になる
  const res = await readSearchConsoleZip(igZip(), 'instagram.com_miselclinic_osaka_old-Performance-on-Search-2026-10-19.zip');
  assert.equal(res.property.account, 'miselclinic_osaka');
  assert.equal(res.property.id, 'instagram.com/miselclinic_osaka');
});

test('readSearchConsoleZip: Search Console でない ZIP は null', async () => {
  const z = makeZip({ 'sheet.xml': '<x/>' });
  assert.equal(await readSearchConsoleZip(z, 'book.xlsx'), null);
});

test('readSearchConsoleCSV: 1ファイルでも読め、中身からプロパティを推測する', () => {
  const res = readSearchConsoleCSV(parseCSV(POSTS), { fileName: '投稿.csv' });
  assert.equal(res.table.dimension, 'posts');
  assert.equal(res.property.account, 'miselclinic_osaka');
  // クエリ単体ではプロパティが分からない
  assert.equal(readSearchConsoleCSV(parseCSV(QUERIES), { fileName: 'クエリ.csv' }).property, null);
  // フォルダ名が取れればそこから分かる
  assert.equal(
    readSearchConsoleCSV(parseCSV(QUERIES), { folder: 'miselclinic.com-Performance-on-Search-2026-10-19' }).property.id,
    'miselclinic.com',
  );
});

// ---------- マージ ----------

test('mergeSearchConsole: 同じプロパティは置き換え、日次だけ足していく', async () => {
  const first = (await readSearchConsoleZip(igZip(), 'instagram.com_miselclinic_osaka-Performance-on-Search-2026-10-19.zip')).property;
  const later = (
    await readSearchConsoleZip(
      makeZip({
        'クエリ.csv': '上位のクエリ,クリック数,表示回数,CTR,掲載順位\nミセルクリニック,60,2000,3%,3.9\n',
        '平均読み込み時間のチャート.csv': '日付,クリック数,表示回数,CTR,掲載順位\n2026-08-21,12,420,2.86%,17\n2026-08-22,11,430,2.56%,16\n',
        '投稿.csv': POSTS,
      }),
      'instagram.com_miselclinic_osaka-Performance-on-Search-2026-10-20.zip',
    )
  ).property;

  const merged = mergeSearchConsole([first], [later]);
  assert.equal(merged.length, 1, 'プロパティは増えない');
  assert.equal(merged[0].queries.length, 1, '期間集計の表は置き換える（足すと二重計上になる）');
  assert.deepEqual(merged[0].daily.map((r) => [r.date, r.clicks]), [
    ['2026-08-19', 7], ['2026-08-20', 9], ['2026-08-21', 12], ['2026-08-22', 11],
  ], '日次は日付でマージし、同じ日は新しい方');
  assert.equal(merged[0].devices.length, 2, '新しい書き出しに無い表は前のものを残す');
});

test('mergeSearchConsole: 別プロパティは別々に持つ', async () => {
  const ig = (await readSearchConsoleZip(igZip(), 'instagram.com_miselclinic_osaka-Performance-on-Search-2026-10-19.zip')).property;
  const site = (await readSearchConsoleZip(makeZip({ 'ページ.csv': PAGES, 'クエリ.csv': QUERIES }), 'miselclinic.com-Performance-on-Search-2026-10-19.zip')).property;
  const merged = mergeSearchConsole([ig], [site]);
  assert.equal(merged.length, 2);
  assert.deepEqual(instagramProperties(merged).map((p) => p.id), ['instagram.com/miselclinic_osaka']);
  assert.deepEqual(siteProperties(merged).map((p) => p.id), ['miselclinic.com']);
  assert.deepEqual(instagramProperties(merged, 'miselclinic_osaka').length, 1);
  assert.deepEqual(instagramProperties(merged, 'ほかのアカウント').length, 0);
});

// ---------- 集計 ----------

test('weightedPosition: 掲載順位は表示回数で重み付けする', () => {
  // 1位(表示1000) と 50位(表示10) の単純平均は 25.5 だが、実際はほぼ 1 位
  const pos = weightedPosition([
    { position: 1, impressions: 1000 },
    { position: 50, impressions: 10 },
  ]);
  assert.ok(pos < 1.6 && pos > 1, `加重平均が想定外です: ${pos}`);
  assert.equal(weightedPosition([]), null);
  assert.equal(weightedPosition([{ position: null, impressions: 100 }]), null);
});

test('postIndex: shortcode で投稿と突き合わせられる形にする', async () => {
  const p = (await readSearchConsoleZip(igZip(), 'instagram.com_miselclinic_osaka-Performance-on-Search-2026-10-19.zip')).property;
  const idx = postIndex([p]);
  assert.equal(idx.size, 2, 'プロフィール URL の行は投稿ではないので入れない');
  assert.deepEqual(idx.get('C4NXsihS1Ez'), { clicks: 36, impressions: 696, position: 12.5, ctr: (36 / 696) * 100 });
});

test('postIndex: 同じ投稿が複数プロパティにあれば足す', () => {
  const mk = (clicks, impressions, position) => ({
    kind: 'instagram',
    posts: [{ url: 'https://www.instagram.com/p/AAA/', shortcode: 'AAA', clicks, impressions, position, ctr: null }],
  });
  const idx = postIndex([mk(10, 100, 5), mk(20, 300, 9)]);
  assert.equal(idx.get('AAA').clicks, 30);
  assert.equal(idx.get('AAA').impressions, 400);
  // 順位は表示回数で重み付け：(5*100 + 9*300) / 400 = 8
  assert.equal(idx.get('AAA').position, 8);
});

test('queryRows: 並べ替えと絞り込み（掲載順位だけ小さい順）', async () => {
  const p = (await readSearchConsoleZip(igZip(), 'instagram.com_miselclinic_osaka-Performance-on-Search-2026-10-19.zip')).property;
  assert.deepEqual(queryRows([p], { sort: 'clicks', limit: 2 }).map((r) => r.query), ['ミセルクリニック大阪梅田院', 'ミセルクリニック']);
  assert.equal(queryRows([p], { sort: 'position' })[0].query, 'うなじ脱毛', '掲載順位は小さいほうが上');
  assert.equal(queryRows([p], { minImpressions: 1500 }).length, 2);
});

test('queryRows: 同じ検索語は複数プロパティ分を足す', () => {
  const mk = (clicks, impressions) => ({ queries: [{ query: 'ミセル', clicks, impressions, ctr: null, position: 2 }] });
  const rows = queryRows([mk(10, 100), mk(5, 100)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].clicks, 15);
  assert.equal(rows[0].ctr, 7.5);
});

test('underperformingQueries: 順位は高いのにクリックされていない語を拾う', async () => {
  const p = (await readSearchConsoleZip(igZip(), 'instagram.com_miselclinic_osaka-Performance-on-Search-2026-10-19.zip')).property;
  const rows = underperformingQueries([p], { minImpressions: 100 });
  assert.equal(rows[0].query, 'うなじ脱毛', '2.1位で CTR 0.17% は取りこぼし');
  assert.ok(rows[0].lostClicks > 0);
  // 8.78位・CTR 8.72% の語は平均より上なので入らない
  assert.ok(!rows.some((r) => r.query === 'ほくろ取り放題 1万円 大阪'));
});

test('searchSummary / sliceSearchDaily: 期間と合計', async () => {
  const p = (await readSearchConsoleZip(igZip(), 'instagram.com_miselclinic_osaka-Performance-on-Search-2026-10-19.zip')).property;
  const s = searchSummary([p]);
  assert.equal(s.clicks, 26);
  assert.equal(s.impressions, 1358);
  assert.equal(s.from, '2026-08-19');
  assert.equal(s.to, '2026-08-21');
  assert.equal(sliceSearchDaily([p], '2026-08-20', '2026-08-21').length, 2);
  assert.equal(sliceSearchDaily([p], '2026-08-20').length, 2);
  assert.deepEqual(sliceSearchDaily([], '2026-08-20'), []);
});

// ---------- 取り込みの判別順（誤読の防止） ----------

test('国.csv は Search Console として読み、Meta のオーディエンスとして誤読しない', async () => {
  const { importCSV } = await import('../public/js/data/csv.js');
  const rows = parseCSV(COUNTRIES);

  // app.js と同じ順番：Search Console を先に見る
  const sc = readSearchConsoleCSV(rows, { fileName: '国.csv' });
  assert.ok(sc, 'Search Console として判別できていません');
  assert.equal(sc.table.dimension, 'countries');

  // 先に判別しないと、Meta の「オーディエンス（国別）」として取り込まれてしまう
  const wrong = importCSV(COUNTRIES, { fileName: '国.csv' });
  assert.ok(wrong.audience?.countries?.length, '前提が変わりました（importCSV が国別として読まなくなった）');
  assert.equal(wrong.audience.countries[0].value, 379, 'フォロワーの構成比(%)ではなく検索クリック数が入ってしまう');
});

test('Meta のオーディエンス（国別）は Search Console として読まない', () => {
  const meta = '国,割合\n日本,92.4\n台湾,3.1\n';
  assert.equal(readSearchConsoleCSV(parseCSV(meta), { fileName: 'Audience.csv' }), null);
});

test('buildProperty: 1枚ずつ読んだ表をまとめて 1 プロパティにする', () => {
  const tables = [QUERIES, POSTS, DAILY, FILTER].map((t) => readSCTable(parseCSV(t)));
  const prop = buildProperty({ id: 'instagram.com/x', kind: 'instagram', account: 'x', label: '@x', exportedAt: null }, tables);
  assert.equal(prop.queries.length, 4);
  assert.equal(prop.posts.length, 3);
  assert.equal(prop.daily.length, 3);
  assert.ok(prop.filter);
  // プロパティが分からなくても落ちない
  const unknown = buildProperty(null, tables);
  assert.equal(unknown.kind, 'unknown');
  assert.equal(unknown.queries.length, 4);
});

// ---------- 指名キーワード ----------

const BRAND_QUERIES = `上位のクエリ,クリック数,表示回数,CTR,掲載順位
ミセルクリニック大阪梅田院,10595,25638,41.33%,1.08
忠岡メディカルクリニック,9956,34397,28.94%,1.28
ミセルクリニック,6973,21262,32.8%,1.73
ミセルクリニック 梅田,500,1500,33.3%,2.1
ほくろ除去 大阪,300,9000,3.3%,8.2
`;

test('guessBrandTerms: アカウント名を短くして、実際の検索語に当たる形を見つける', () => {
  const props = [buildProperty({ id: 'miselclinic.com', kind: 'site', account: '', label: 'miselclinic.com' }, [readSCTable(parseCSV(BRAND_QUERIES))])];
  // 「ミセルクリニック大阪」では検索語に当たらないが、「ミセルクリニック」なら当たる
  assert.deepEqual(guessBrandTerms(props, ['ミセルクリニック大阪']), ['ミセルクリニック']);
  // 短くしすぎない（当たり具合がほぼ変わらない範囲でいちばん長い語を選ぶ）
  assert.ok(!guessBrandTerms(props, ['ミセルクリニック大阪'])[0].startsWith('ミセ|'));
  // 当たらない語は返さない
  assert.deepEqual(guessBrandTerms(props, ['zzz']), []);
  assert.deepEqual(guessBrandTerms([], ['ミセルクリニック']), []);
});

test('brandedQueries: 指名の検索語だけを集計し、全体に対する割合を出す', () => {
  const props = [buildProperty({ id: 'miselclinic.com', kind: 'site', account: '', label: 'miselclinic.com' }, [readSCTable(parseCSV(BRAND_QUERIES))])];
  const b = brandedQueries(props, ['ミセルクリニック']);
  assert.equal(b.matched, 3);
  assert.equal(b.clicks, 10595 + 6973 + 500);
  assert.equal(b.total, 10595 + 9956 + 6973 + 500 + 300);
  assert.ok(Math.abs(b.share - b.clicks / b.total) < 1e-12);
  // 他院の名前（忠岡メディカルクリニック）は拾わない
  assert.ok(!b.examples.some((q) => q.includes('忠岡')));
  // 語を指定しなければ null
  assert.equal(brandedQueries(props, []), null);
});

test('defaultBrandTerms: アカウント表示名・ユーザー名・ドメインから候補を作る', () => {
  const props = [
    { kind: 'instagram', account: 'miselclinic_osaka', id: 'instagram.com/miselclinic_osaka' },
    { kind: 'site', id: 'miselclinic.com' },
  ];
  assert.deepEqual(defaultBrandTerms(props, ['ミセルクリニック大阪']), ['ミセルクリニック大阪', 'miselclinic']);
  // 表示名が無くても落ちない
  assert.deepEqual(defaultBrandTerms(props), ['miselclinic']);
});
