// 毎週の自動レポート。CSV を取り込み、画面の「レポート出力」と同じ MD・Word を作って保存する。
// アプリをヘッドレスの Chrome（または Edge）で開き、ファイル選択から取り込むので、
// 集計もレポートの中身も画面とまったく同じになる。
//
// 実行（Dropbox から読み、Dropbox へ保存）: node scripts/weeklyReport.js
// 実行（ローカルで試す）: node scripts/weeklyReport.js --in <CSVのフォルダ> --out <出力先フォルダ>
// 設定は環境変数で渡す（README「毎週の自動レポート」）。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INPUT_EXT, accessToken, client } from './dropbox.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true;
  return out;
}

/** 画面の設定（期間など）。期間は既定で直近7日（前の7日と比べる） */
export function reportSettings(e = env) {
  const days = e.REPORT_DAYS === undefined || e.REPORT_DAYS === '' ? 7 : Number(e.REPORT_DAYS);
  if (!Number.isInteger(days) || days < 0) throw new Error('REPORT_DAYS は 0 以上の整数で指定してください（0 は全期間）');
  let extra = {};
  if (e.REPORT_SETTINGS) {
    try {
      extra = JSON.parse(e.REPORT_SETTINGS);
    } catch {
      throw new Error('REPORT_SETTINGS が JSON として読めません');
    }
  }
  return { ...extra, days };
}

/**
 * レポートを保存する時刻まで待つミリ秒（REPORT_PUBLISH_AT="06:15" のように指定。時刻は TZ の現地時刻）。
 * 取り込みが早く終わっても、決まった時刻に出力する。時刻を過ぎていれば待たない（0）
 */
export function publishDelay(at, now = new Date()) {
  if (!at) return 0;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at).trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error('REPORT_PUBLISH_AT は 06:15 のように「時:分」で指定してください');
  const target = new Date(now);
  target.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return Math.max(0, target - now);
}

/** 取り込み画面の表示から、取り込めた件数と読めなかった件数を数える（ログにファイル名は出さない） */
export function importCounts(status) {
  const failed = (String(status).match(/読めませんでした →/g) || []).length;
  const m = String(status).match(/(\d+)件を取り込み/);
  return { failed, done: m ? Number(m[1]) : null };
}

function findBrowser() {
  const candidates = [
    env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('Chrome / Edge が見つかりません。CHROME_PATH にブラウザの実行ファイルを指定してください');
  return found;
}

const freePort = () =>
  new Promise((ok, ng) => {
    const s = createServer();
    s.once('error', ng);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

async function until(fn, { timeout = 20000, every = 200, what = '待機' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* まだ準備ができていない */
    }
    if (Date.now() > end) throw new Error(`${what}がタイムアウトしました`);
    await wait(every);
  }
}

/** Chrome DevTools Protocol の最小クライアント */
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, ng) => {
    ws.onopen = ok;
    ws.onerror = () => ng(new Error('ブラウザに接続できませんでした'));
  });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    d.error ? p.ng(new Error(d.error.message)) : p.ok(d.result);
  };
  const send = (method, params = {}) =>
    new Promise((ok, ng) => {
      pending.set(++id, { ok, ng });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, evaluate, errors, close: () => ws.close() };
}

/** 入力ファイルを作業フォルダにそろえる（Dropbox ならダウンロード） */
async function collectInputs(opts, work) {
  if (opts.in) {
    const dir = resolve(opts.in);
    const files = [];
    const walk = async (d) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const full = join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else if (INPUT_EXT.test(e.name)) files.push(full);
      }
    };
    await walk(dir);
    return { files, dropbox: null };
  }

  const token = await accessToken({ appKey: env.DROPBOX_APP_KEY, appSecret: env.DROPBOX_APP_SECRET, refreshToken: env.DROPBOX_REFRESH_TOKEN });
  const dbx = client(token);
  const outPath = env.DROPBOX_REPORT_PATH || '';
  if (!outPath) {
    throw new Error('レポートの保存先が分かりません。DROPBOX_REPORT_PATH（例: /export）を設定してください');
  }
  const inPath = env.DROPBOX_INPUT_PATH;
  if (!inPath) throw new Error('取り込み用フォルダが分かりません。DROPBOX_INPUT_PATH（例: /import）を設定してください');
  const entries = (await dbx.listFiles(inPath)).filter((e) => INPUT_EXT.test(e.name));
  const files = [];
  for (const e of entries) {
    // サブフォルダが違う同名ファイルがぶつからないよう、フォルダ構成ごと置く
    const rel = e.path_lower.startsWith(`${inPath.toLowerCase().replace(/\/+$/, '')}/`) ? e.path_display.slice(inPath.replace(/\/+$/, '').length + 1) : e.name;
    const local = join(work, 'in', ...rel.split('/'));
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, await dbx.download(e.path_lower));
    files.push(local);
  }
  return { files, dropbox: { dbx, outPath } };
}

async function run() {
  const opts = args(process.argv.slice(2));
  const settings = reportSettings();
  const work = await mkdtemp(join(tmpdir(), 'iia-weekly-'));
  const children = [];
  let page = null;
  try {
    const { files, dropbox } = await collectInputs(opts, work);
    if (!files.length) throw new Error('取り込むファイル（CSV・Excel・ZIP）がありません');
    console.log(`取り込むファイル: ${files.length}件`);

    // アプリを配信する（server.js と同じもの）
    const port = await freePort();
    const server = spawn(process.execPath, [join(ROOT, 'server.js')], { env: { ...env, PORT: String(port) }, stdio: 'ignore' });
    children.push(server);
    const base = `http://127.0.0.1:${port}`;
    await until(async () => (await fetch(`${base}/index.html`)).ok, { what: 'アプリの起動' });

    // 専用のプロファイルで起動する（普段使いのブラウザのデータには触れない）
    const profile = join(work, 'profile');
    const browser = spawn(
      findBrowser(),
      ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', ...(env.CI ? ['--no-sandbox'] : []), 'about:blank'],
      { stdio: 'ignore' },
    );
    children.push(browser);
    const debugPort = await until(async () => (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0].trim(), { what: 'ブラウザの起動' });
    const target = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === 'page'), { what: 'ブラウザの起動' });
    page = await cdp(target.webSocketDebuggerUrl);
    await page.send('Runtime.enable');
    await page.send('Page.enable');

    // 期間などの設定を入れてから開き直す
    await page.send('Page.navigate', { url: `${base}/index.html` });
    await until(() => page.evaluate('document.readyState === "complete" && !!window.iiaAuto'), { what: 'アプリの読み込み' });
    await page.evaluate(`localStorage.clear(); localStorage.setItem('iia.settings.v1', ${JSON.stringify(JSON.stringify(settings))}); location.reload()`);
    await wait(500);
    await until(() => page.evaluate('document.readyState === "complete" && !!window.iiaAuto'), { what: 'アプリの読み込み' });

    // 画面の「ファイルを選択」と同じ経路で取り込む
    const doc = await page.send('DOM.getDocument', {});
    const input = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#csv-input' });
    await page.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files });
    await until(() => page.evaluate('!!window.iiaAuto.ready()'), { what: '取り込みの開始' });
    await page.evaluate('window.iiaAuto.ready().then(() => true)');
    const status = await page.evaluate('window.iiaAuto.status()');
    const counts = importCounts(status);
    // ファイル名や件数の詳細は --verbose のときだけ出す（GitHub Actions のログは公開されることがあるため）
    if (opts.verbose) console.log(status);
    console.log(`取り込み: ${counts.done ?? files.length - counts.failed}件${counts.failed ? `（読めなかったファイル ${counts.failed}件）` : ''}`);

    const md = await page.evaluate('(() => { const r = window.iiaAuto.report("md"); return r && { name: r.name, text: r.content }; })()');
    const docx = await page.evaluate(`(() => {
      const r = window.iiaAuto.report('docx');
      if (!r) return null;
      let s = '';
      for (let i = 0; i < r.content.length; i += 0x8000) s += String.fromCharCode(...r.content.subarray(i, i + 0x8000));
      return { name: r.name, base64: btoa(s) };
    })()`);
    if (!md || !docx) throw new Error('レポートを作れませんでした（取り込めたデータがありません）');
    if (page.errors.length) console.warn(`画面でエラーが出ました: ${page.errors.join(' / ').slice(0, 500)}`);

    // 保存の時刻が決まっていれば、それまで待ってから出力する
    const delay = publishDelay(env.REPORT_PUBLISH_AT);
    if (delay) {
      console.log(`${env.REPORT_PUBLISH_AT} まで待ってから保存します（約${Math.ceil(delay / 60000)}分）`);
      await wait(delay);
    }

    const outputs = [
      [md.name, Buffer.from(md.text, 'utf8')],
      [docx.name, Buffer.from(docx.base64, 'base64')],
    ];
    if (dropbox) {
      for (const [name, data] of outputs) await dropbox.dbx.upload(posix.join(dropbox.outPath, name), data);
      console.log(`Dropbox に保存しました: ${outputs.map(([n]) => n).join('・')}`);
    } else {
      const out = resolve(opts.out || '.');
      await mkdir(out, { recursive: true });
      for (const [name, data] of outputs) await writeFile(join(out, name), data);
      console.log(`保存しました: ${outputs.map(([n]) => relative(process.cwd(), join(out, n))).join('・')}`);
    }
  } finally {
    page?.close();
    for (const c of children) c.kill();
    await wait(500);
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((e) => {
    console.error(`自動レポートに失敗しました: ${e.message}`);
    process.exit(1);
  });
}
