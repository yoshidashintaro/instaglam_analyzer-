// .htpasswd（Apache のベーシック認証用パスワードファイル）を作る。
// 依存ライブラリなし。Apache 標準の APR1-MD5 形式（$apr1$…）で出力する。
//
//   node scripts/htpasswd.js admin ひみつ            → 標準出力に1行
//   node scripts/htpasswd.js admin ひみつ > .htpasswd
//
// APR1 は Apache 2.2 / 2.4 のどちらでも、レンタルサーバーでもそのまま使える形式。
import { createHash } from 'node:crypto';
import { randomInt } from 'node:crypto';

const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const md5 = (...parts) => createHash('md5').update(Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'binary'))))).digest();

/** 24bit ずつ 4 文字（または 12bit を 2 文字）に変換する、crypt 由来の独自 Base64 */
function to64(value, chars) {
  let out = '';
  let v = value;
  for (let i = 0; i < chars; i++) {
    out += ITOA64[v & 0x3f];
    v >>= 6;
  }
  return out;
}

/** ランダムな 8 文字のソルト */
export const randomSalt = (len = 8) => Array.from({ length: len }, () => ITOA64[randomInt(ITOA64.length)]).join('');

/**
 * APR1-MD5 のハッシュを作る。
 * @param {string} password 平文のパスワード
 * @param {string} salt 8文字以内のソルト（省略時はランダム）
 * @returns {string} $apr1$<salt>$<hash>
 */
export function apr1(password, salt = randomSalt()) {
  // ベーシック認証はブラウザによって非 ASCII の送り方が違うため、記号を含む半角英数字だけにする
  if (!/^[\x21-\x7e]+$/.test(String(password))) {
    throw new Error('パスワードは半角の英数字・記号だけにしてください（日本語や空白はブラウザによって送られ方が変わります）');
  }
  const pw = Buffer.from(password, 'utf8');
  const sa = Buffer.from(String(salt).slice(0, 8), 'utf8');
  const magic = Buffer.from('$apr1$', 'utf8');

  // 1回目：パスワード＋マジック＋ソルト に、パスワードから作った中間値を長さぶん混ぜる
  let final = md5(pw, sa, pw);
  const parts = [pw, magic, sa];
  for (let i = pw.length; i > 0; i -= 16) parts.push(final.subarray(0, Math.min(i, 16)));
  // パスワード長のビットが 1 なら NUL、0 ならパスワードの先頭1バイト
  for (let i = pw.length; i > 0; i >>= 1) parts.push(i & 1 ? Buffer.from([0]) : pw.subarray(0, 1));
  final = md5(...parts);

  // 1000回の繰り返しで総当たりを遅くする
  for (let i = 0; i < 1000; i++) {
    const round = [];
    round.push(i & 1 ? pw : final);
    if (i % 3) round.push(sa);
    if (i % 7) round.push(pw);
    round.push(i & 1 ? final : pw);
    final = md5(...round);
  }

  const b = final;
  const hash =
    to64((b[0] << 16) | (b[6] << 8) | b[12], 4) +
    to64((b[1] << 16) | (b[7] << 8) | b[13], 4) +
    to64((b[2] << 16) | (b[8] << 8) | b[14], 4) +
    to64((b[3] << 16) | (b[9] << 8) | b[15], 4) +
    to64((b[4] << 16) | (b[10] << 8) | b[5], 4) +
    to64(b[11], 2);
  return `$apr1$${sa.toString('utf8')}$${hash}`;
}

/** .htpasswd の1行（ユーザー名:ハッシュ） */
export const htpasswdLine = (user, password, salt) => `${user}:${apr1(password, salt)}`;

// コマンドラインから呼ばれたときだけ実行する
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const [user, password] = process.argv.slice(2);
  if (!user || !password) {
    console.error('使い方: node scripts/htpasswd.js <ユーザー名> <パスワード>');
    process.exit(1);
  }
  console.log(htpasswdLine(user, password));
}
