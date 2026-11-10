// 自動レポート用の Dropbox リフレッシュトークンを取得する（最初に1回だけ）。
// 1. node scripts/dropboxAuth.js <App key> <App secret>
//    → 表示された URL をブラウザで開き、「許可」を押して表示されたコードをコピーする
// 2. node scripts/dropboxAuth.js <App key> <App secret> <コード>
//    → 表示されたリフレッシュトークンを GitHub の Secrets（DROPBOX_REFRESH_TOKEN）に登録する
const [appKey, appSecret, code] = process.argv.slice(2);

if (!appKey || !appSecret) {
  console.error('使い方: node scripts/dropboxAuth.js <App key> <App secret> [認可コード]');
  process.exit(1);
}

if (!code) {
  const url = new URL('https://www.dropbox.com/oauth2/authorize');
  url.search = new URLSearchParams({ client_id: appKey, response_type: 'code', token_access_type: 'offline' }).toString();
  console.log('次の URL をブラウザで開き、「許可」を押して表示されたコードを控えてください:\n');
  console.log(url.toString());
  console.log('\nその後: node scripts/dropboxAuth.js <App key> <App secret> <コード>');
} else {
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    body: new URLSearchParams({ code, grant_type: 'authorization_code', client_id: appKey, client_secret: appSecret }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.refresh_token) {
    console.error(`取得できませんでした（${res.status}）: ${body.error_description || body.error || ''}`);
    console.error('コードは1回しか使えず、数分で期限が切れます。URL を開き直して新しいコードで試してください。');
    process.exit(1);
  }
  console.log('リフレッシュトークン（GitHub の Secrets「DROPBOX_REFRESH_TOKEN」に登録してください。他人に見せないこと）:\n');
  console.log(body.refresh_token);
}
