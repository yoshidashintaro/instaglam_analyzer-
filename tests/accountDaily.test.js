// 複数アカウントのソーシャルインサイトを取り込んでも、日次データ（フォロワー数など）が混ざらない
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDaily } from '../public/js/storage.js';
import { accountResolver, pickAccountDaily } from '../public/js/account.js';
import { normalizeDaily } from '../public/js/analytics.js';

const day = (date, followers, extra = {}) => ({ date, followers, ...extra });

// 実際に起きた形：本アカウント（約9,280人）と院長アカウント（約1,550人）を同じ期間で取り込む
const clinic = [day('2026-10-09', 9276), day('2026-10-10', 9279), day('2026-10-11', 9282)].map((r) => ({ ...r, account: 'ミセルクリニック大阪' }));
const doctor = [day('2026-10-10', 1554), day('2026-10-11', 1560)].map((r) => ({ ...r, account: '【脂肪吸引_豊胸専門' }));
const posts = [
  { id: '1', account: 'miselclinic_osaka', accountName: 'ミセルクリニック大阪梅田院｜美容皮膚科•外科' },
  { id: '2', account: 'miselclinic_osaka', accountName: 'ミセルクリニック大阪梅田院｜美容皮膚科•外科' },
  { id: '3', account: 'dr.okudate_miselclinic', accountName: '【脂肪吸引/豊胸専門】奥立大樹 | ミセルクリニック大阪梅田院　院長' },
];
const accountDaily = [
  { date: '2026-10-10', account: 'ミセルクリニック大阪', accountName: 'ミセルクリニック大阪梅田院｜美容皮膚科•外科' },
  { date: '2026-10-10', account: '【脂肪吸引_豊胸専門', accountName: '【脂肪吸引/豊胸専門】奥立大樹 | ミセルクリニック大阪梅田院　院長' },
];

test('mergeDaily: アカウントのラベルが違えば、同じ日付でも上書きしない', () => {
  const merged = mergeDaily(mergeDaily([], clinic), doctor);
  assert.equal(merged.length, 5);
  assert.equal(merged.find((r) => r.date === '2026-10-10' && r.account === 'ミセルクリニック大阪').followers, 9279);
  assert.equal(merged.find((r) => r.date === '2026-10-10' && r.account === '【脂肪吸引_豊胸専門').followers, 1554);
  // ラベルの無い行（Meta の書き出し）は今までどおり日付で重ねる
  const meta = mergeDaily([{ date: '2026-10-10', reach: 100 }], [{ date: '2026-10-10', profileVisits: 5 }]);
  assert.equal(meta.length, 1);
  assert.deepEqual([meta[0].reach, meta[0].profileVisits], [100, 5]);
});

test('accountResolver: ファイル名のラベル → アカウント名 → ユーザーネーム と突き合わせる', () => {
  const resolve = accountResolver({ posts, accountDaily });
  assert.equal(resolve('ミセルクリニック大阪'), 'miselclinic_osaka');
  assert.equal(resolve('【脂肪吸引_豊胸専門'), 'dr.okudate_miselclinic');
  assert.equal(resolve('miselclinic_osaka'), 'miselclinic_osaka');
  assert.equal(resolve('不明なラベル'), null);
});

test('pickAccountDaily: 選んだアカウントの日次だけを使い、フォロワー数が別アカウントの数字にならない', () => {
  const rows = mergeDaily(mergeDaily([{ date: '2026-10-10', reach: 4000 }], clinic), doctor);
  const resolve = accountResolver({ posts, accountDaily });

  const own = pickAccountDaily(rows, { resolve, account: 'miselclinic_osaka' });
  assert.equal(own.label, 'ミセルクリニック大阪');
  assert.deepEqual(own.others, ['【脂肪吸引_豊胸専門']);
  const daily = normalizeDaily(own.rows);
  assert.deepEqual(daily.map((d) => d.followers), [9276, 9279, 9282], '10/9 以降も本アカウントの数字のまま');
  assert.equal(daily.find((d) => d.date === '2026-10-10').reach, 4000, 'ラベルの無い行（Meta）は土台として残る');

  const dr = pickAccountDaily(rows, { resolve, account: 'dr.okudate_miselclinic' });
  assert.deepEqual(normalizeDaily(dr.rows).map((d) => d.followers), [1554, 1560]);
});

test('pickAccountDaily: 1アカウントぶんだけなら、ユーザーネームが分からなくても使う（従来どおり）', () => {
  const only = pickAccountDaily(clinic, { resolve: () => null, account: 'miselclinic_osaka' });
  assert.equal(only.label, 'ミセルクリニック大阪');
  assert.equal(only.rows.length, 3);
});

test('pickAccountDaily: 複数アカウントでどれか判別できなければ、混ぜずに使わない', () => {
  const both = pickAccountDaily([...clinic, ...doctor], { resolve: () => null, account: 'miselclinic_osaka' });
  assert.equal(both.label, null);
  assert.deepEqual(both.rows, []);
  assert.deepEqual(both.unresolved.sort(), ['【脂肪吸引_豊胸専門', 'ミセルクリニック大阪'].sort());
});
