// .htpasswd（ベーシック認証）のハッシュ生成。
// 値は Apache / openssl の APR1-MD5 と一致していなければ、サーバーでログインできない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apr1, htpasswdLine, randomSalt } from '../scripts/htpasswd.js';

test('apr1: openssl passwd -apr1 と同じ値になる（既知の値で照合）', () => {
  // $ openssl passwd -apr1 -salt abcdefgh admin1017
  assert.equal(apr1('admin1017', 'abcdefgh'), '$apr1$abcdefgh$U7knuh0.3D46xcXvwdiMp0');
  assert.equal(apr1('admin1017', 'Xy1Z9qRt'), '$apr1$Xy1Z9qRt$G4HRXEBOG0Pmrim5qCTGu/');
  // ソルトに記号が入っても一致する
  assert.equal(apr1('admin1017', './AB12cd'), '$apr1$./AB12cd$OjFS5h3HwacaB7zcTFlHD0');
  // パスワードの長さが 16 の倍数の前後でも崩れない
  assert.equal(apr1('a', 'SALTsalt'), '$apr1$SALTsalt$wkWC54DVCS/Zo9lBKKAZP0');
  assert.equal(apr1('12345678901234567890', 'SALTsalt'), '$apr1$SALTsalt$bKF5dWmGxdjNLCCx5tDjZ/');
});

test('apr1: ソルトは 8 文字に切り詰め、形式は $apr1$<salt>$<22文字>', () => {
  const h = apr1('admin1017', 'abcdefghIGNORED');
  assert.match(h, /^\$apr1\$abcdefgh\$[./0-9A-Za-z]{22}$/);
});

test('apr1: ソルトを省略すると毎回変わるが、同じソルトなら同じ値', () => {
  const a = apr1('admin1017');
  const b = apr1('admin1017');
  assert.notEqual(a, b, 'ソルトが毎回変わる');
  const salt = a.split('$')[2];
  assert.equal(apr1('admin1017', salt), a, '同じソルトなら再現できる');
});

test('randomSalt: Apache が受け付ける文字だけ 8 文字', () => {
  for (let i = 0; i < 20; i++) assert.match(randomSalt(), /^[./0-9A-Za-z]{8}$/);
});

test('apr1: 非 ASCII のパスワードは断る（ブラウザごとに送られ方が変わるため）', () => {
  assert.throws(() => apr1('ひみつ'), /半角/);
  assert.throws(() => apr1('pass word'), /半角/, '空白も不可');
  assert.throws(() => apr1(''), /半角/);
});

test('htpasswdLine: ユーザー名:ハッシュ の1行になる', () => {
  const line = htpasswdLine('admin', 'admin1017', 'abcdefgh');
  assert.equal(line, 'admin:$apr1$abcdefgh$U7knuh0.3D46xcXvwdiMp0');
  assert.equal(line.split(':').length, 2);
  assert.ok(!line.includes('\n'));
});
