// Dropbox API の最小実装（依存なし）。自動レポート（weeklyReport.js）が、
// 取り込む CSV のダウンロードと、できたレポートのアップロードに使う。
// 認証はリフレッシュトークン（scripts/dropboxAuth.js で取得）から、実行のたびに短期トークンを発行する。

const API = 'https://api.dropboxapi.com';
const CONTENT = 'https://content.dropboxapi.com';

/** アプリで取り込めるファイル（画面の「ファイルを選択」と同じ拡張子） */
export const INPUT_EXT = /\.(csv|tsv|txt|xlsx|xls|zip)$/i;

/**
 * Dropbox-API-Arg ヘッダーの値。HTTP ヘッダーには ASCII しか入れられないので、
 * 日本語のパスは \uXXXX にエスケープする（Dropbox の仕様）
 */
export const apiArg = (obj) => JSON.stringify(obj).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

async function check(res, what) {
  if (res.ok) return res;
  const body = await res.text().catch(() => '');
  throw new Error(`Dropbox ${what} に失敗しました（${res.status}）: ${body.slice(0, 300)}`);
}

export async function accessToken({ appKey, appSecret, refreshToken }) {
  if (!appKey || !appSecret || !refreshToken) {
    throw new Error('DROPBOX_APP_KEY・DROPBOX_APP_SECRET・DROPBOX_REFRESH_TOKEN を設定してください（README「毎週の自動レポート」）');
  }
  const res = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: appKey, client_secret: appSecret }),
  });
  await check(res, 'の認証');
  return (await res.json()).access_token;
}

export function client(token) {
  const rpc = async (path, body, what) => {
    const res = await fetch(`${API}/2/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await check(res, what);
    return res.json();
  };

  return {
    /** フォルダ以下のファイルをすべて（サブフォルダも）列挙する */
    async listFiles(path) {
      let page = await rpc('files/list_folder', { path, recursive: true }, `のフォルダ一覧（${path}）`);
      const entries = [...page.entries];
      while (page.has_more) {
        page = await rpc('files/list_folder/continue', { cursor: page.cursor }, 'のフォルダ一覧');
        entries.push(...page.entries);
      }
      return entries.filter((e) => e['.tag'] === 'file');
    },

    async download(path) {
      const res = await fetch(`${CONTENT}/2/files/download`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': apiArg({ path }) },
      });
      await check(res, `のダウンロード（${path}）`);
      return Buffer.from(await res.arrayBuffer());
    },

    /** 同じ名前のファイルがあれば上書きする */
    async upload(path, data) {
      const res = await fetch(`${CONTENT}/2/files/upload`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Arg': apiArg({ path, mode: 'overwrite', autorename: false, mute: true }),
        },
        body: data,
      });
      await check(res, `のアップロード（${path}）`);
      return res.json();
    },
  };
}
