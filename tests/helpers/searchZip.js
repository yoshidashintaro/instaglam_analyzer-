// Search Console の書き出しと同じ形の ZIP をテスト用に組み立てる（無圧縮）。
// 実際の書き出しはファイル名が UTF-8、中身は BOM 無し UTF-8 の CSV。

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** {ファイル名: 本文} を無圧縮 ZIP にする（xlsx.js の unzip の method 0 の経路を通す） */
export function makeZip(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(text);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x800, true); // ファイル名は UTF-8
    lv.setUint16(8, 0, true); // 無圧縮
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    parts.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x800, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);
    offset += local.length + data.length;
  }

  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const all = [...parts, ...central, eocd];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------- 実際の書き出しと同じ形のサンプル ----------

export const QUERIES = `上位のクエリ,クリック数,表示回数,CTR,掲載順位
ミセルクリニック大阪梅田院,96,3457,2.78%,3.25
ミセルクリニック,49,1776,2.76%,4.1
ほくろ取り放題 1万円 大阪,26,298,8.72%,8.78
うなじ脱毛,2,1200,0.17%,2.1
`;

export const POSTS = `上位の投稿,クリック数,表示回数,CTR,掲載順位
https://www.instagram.com/miselclinic_osaka/,207,10309,2.01%,8.16
https://www.instagram.com/p/C4NXsihS1Ez/,36,696,5.17%,12.5
https://www.instagram.com/reel/DEuYle1y4j5/,20,473,4.23%,6.11
`;

// Google はこの表を「平均読み込み時間のチャート.csv」という名前で書き出す
export const DAILY = `日付,クリック数,表示回数,CTR,掲載順位
2026-08-19,7,461,1.52%,21
2026-08-20,9,481,1.87%,24.9
2026-08-21,10,416,2.4%,18.1
`;

export const DEVICES = `デバイス,クリック数,表示回数,CTR,掲載順位
モバイル,345,15725,2.19%,13.64
PC,34,8785,0.39%,27.49
`;

export const COUNTRIES = `国,クリック数,表示回数,CTR,掲載順位
日本,379,24225,1.56%,18.8
韓国,2,46,4.35%,6.37
`;

export const FILTER = `フィルタ,値
検索タイプ,ウェブ（テキストベース）
日付,過去 12 か月間
`;

export const PAGES = `上位のページ,クリック数,表示回数,CTR,掲載順位
https://miselclinic.com/,16481,428987,3.84%,25.03
https://kishiwada.miselclinic.com/,22305,337608,6.61%,9.39
`;

/** Instagram プロパティの書き出し一式 */
export const makeSearchZip = () =>
  makeZip({
    'クエリ.csv': QUERIES,
    '投稿.csv': POSTS,
    '平均読み込み時間のチャート.csv': DAILY,
    'デバイス.csv': DEVICES,
    '国.csv': COUNTRIES,
    'フィルタ.csv': FILTER,
  });
