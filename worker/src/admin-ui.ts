// 本地管理后台 UI: 同源调 admin endpoints, 不存在 CORS, ADMIN_TOKEN 是唯一防线

export const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>xhs-license · admin</title>
<style>
  :root {
    --paper: #faf7f0; --paper-2: #f3ede0; --paper-3: #ece4d2;
    --ink: #1a1612; --ink-soft: #4a4239; --ink-mute: #8a8175;
    --rule: #d8cfba; --rule-soft: #e7dfca;
    --accent: #b8412e; --accent-soft: #f4d8d0;
    --green: #1f4d3a; --green-soft: #d8e5dc;
    --gold: #a17829; --gold-soft: #f0e2c0;
    --red-deep: #8b1f15;
    --surface: #ffffff;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif; }
  header {
    display: flex; align-items: center; gap: 16px;
    padding: 14px 28px; background: var(--surface); border-bottom: 1px solid var(--rule);
  }
  header h1 { font: 600 18px Georgia, serif; }
  header h1 em { font-style: italic; color: var(--accent); font-weight: 400; }
  header .spacer { flex: 1; }
  header .token-status {
    font-size: 12px; color: var(--ink-mute);
    padding: 4px 10px; border: 1px solid var(--rule); border-radius: 14px;
    background: var(--paper); cursor: pointer;
  }
  header .token-status.ok { color: var(--green); border-color: var(--green-soft); background: var(--green-soft); }
  header .token-status.bad { color: var(--accent); border-color: var(--accent); }
  nav.tabs { display: flex; gap: 4px; padding: 0 28px; background: var(--surface); border-bottom: 1px solid var(--rule); }
  nav.tabs button {
    background: none; border: none; padding: 10px 16px; font: inherit; font-size: 13px;
    color: var(--ink-mute); cursor: pointer; border-bottom: 2px solid transparent;
  }
  nav.tabs button:hover { color: var(--ink); }
  nav.tabs button.active { color: var(--accent); border-bottom-color: var(--accent); }
  main { padding: 28px; max-width: 1200px; margin: 0 auto; }
  section.pane { display: none; }
  section.pane.active { display: block; }
  h2 { font: 600 16px Georgia, serif; margin-bottom: 12px; }
  .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
  label { font-size: 12px; color: var(--ink-soft); display: flex; flex-direction: column; gap: 4px; }
  input, select, textarea {
    font: inherit; font-size: 13px; padding: 7px 10px;
    border: 1px solid var(--rule); border-radius: 4px;
    background: var(--surface); color: var(--ink);
  }
  input:focus, select:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: var(--accent); }
  button.primary {
    background: var(--accent); color: var(--paper); border: none;
    padding: 8px 18px; border-radius: 4px; cursor: pointer; font: inherit; font-size: 13px; font-weight: 500;
  }
  button.primary:hover:not(:disabled) { background: var(--red-deep); }
  button.primary:disabled { background: var(--ink-mute); cursor: not-allowed; }
  button.secondary {
    background: var(--surface); color: var(--ink-soft); border: 1px solid var(--rule);
    padding: 6px 12px; border-radius: 4px; cursor: pointer; font: inherit; font-size: 12px;
  }
  button.secondary:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  button.danger {
    background: var(--surface); color: var(--red-deep); border: 1px solid var(--rule);
    padding: 4px 10px; border-radius: 3px; cursor: pointer; font: inherit; font-size: 11.5px;
  }
  button.danger:hover { background: var(--accent-soft); border-color: var(--red-deep); }
  .result-box {
    background: var(--surface); border: 1px solid var(--rule-soft); border-radius: 4px;
    padding: 12px 16px; font-family: 'SF Mono', Menlo, monospace; font-size: 12px;
    white-space: pre-wrap; word-break: break-all; max-height: 220px; overflow-y: auto;
  }
  .toast {
    position: fixed; right: 24px; bottom: 24px;
    padding: 10px 16px; border-radius: 4px; font-size: 13px;
    background: var(--ink); color: var(--paper); opacity: 0; transition: opacity .15s;
    pointer-events: none; z-index: 100;
  }
  .toast.show { opacity: 0.95; }
  .toast.err { background: var(--red-deep); }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; background: var(--surface); }
  thead th {
    text-align: left; padding: 8px 10px; background: var(--paper-2);
    font-size: 11px; letter-spacing: 0.04em; color: var(--ink-mute);
    border-bottom: 1px solid var(--rule); position: sticky; top: 0;
  }
  tbody td { padding: 8px 10px; border-bottom: 1px solid var(--rule-soft); vertical-align: middle; }
  tbody tr:hover { background: var(--paper-2); }
  td.mono { font-family: 'SF Mono', monospace; font-size: 11.5px; }
  td.actions { white-space: nowrap; }
  .status-pill {
    display: inline-block; padding: 1px 8px; border-radius: 10px;
    font-size: 10.5px; letter-spacing: 0.04em; text-transform: uppercase; font-weight: 500;
  }
  .status-pill.unused { background: var(--gold-soft); color: var(--gold); }
  .status-pill.active { background: var(--green-soft); color: var(--green); }
  .status-pill.revoked { background: var(--accent-soft); color: var(--red-deep); }
  .meta { font-size: 11px; color: var(--ink-mute); margin-top: 4px; }
  .empty { padding: 40px; text-align: center; color: var(--ink-mute); }
</style>
</head>
<body>
  <header>
    <h1>xhs-license <em>admin</em></h1>
    <span class="spacer"></span>
    <button id="token-status" class="token-status">检测中…</button>
  </header>
  <nav class="tabs">
    <button data-tab="issue" class="active">发码</button>
    <button data-tab="list">列表 / 改</button>
  </nav>
  <main>
    <section class="pane active" id="pane-issue">
      <h2>发码</h2>
      <div class="row">
        <label>数量 <input id="i-count" type="number" min="1" max="100" value="1" style="width:80px"></label>
        <label>过期日 (留空=永久) <input id="i-expire" type="date"></label>
        <label style="flex:1;min-width:200px">备注 <input id="i-notes" type="text" placeholder="例如 首批 / 某客户"></label>
        <button class="primary" id="btn-issue">发码</button>
      </div>
      <pre class="result-box" id="issue-result" style="display:none"></pre>
    </section>

    <section class="pane" id="pane-list">
      <h2>列表 / 吊销 / 换绑</h2>
      <div class="row">
        <label>状态
          <select id="f-status">
            <option value="">全部</option>
            <option value="unused">unused 未使用</option>
            <option value="active">active 已激活</option>
            <option value="revoked">revoked 已吊销</option>
          </select>
        </label>
        <label>machine_id 包含 <input id="f-mid" type="text" placeholder="后缀片段"></label>
        <label>limit <input id="f-limit" type="number" min="10" max="1000" value="500" style="width:90px"></label>
        <button class="primary" id="btn-refresh">刷新</button>
        <span id="list-summary" class="meta"></span>
      </div>
      <div id="list-table"></div>
    </section>
  </main>
  <div id="toast" class="toast"></div>

<script>
const TOKEN_KEY = 'xhs-license-admin-token';
let TOKEN = localStorage.getItem(TOKEN_KEY) || '';

function updateTokenStatus() {
  const el = document.getElementById('token-status');
  if (TOKEN) { el.textContent = '● TOKEN ' + TOKEN.slice(-6); el.className = 'token-status ok'; }
  else { el.textContent = '○ 未设 TOKEN, 点此输入'; el.className = 'token-status bad'; }
}
function promptToken() {
  const t = prompt('粘贴 ADMIN_TOKEN (来自 INFRA.md)', TOKEN);
  if (t !== null) { TOKEN = t.trim(); localStorage.setItem(TOKEN_KEY, TOKEN); updateTokenStatus(); }
}
function toast(msg, isErr) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(window.__toastT);
  window.__toastT = setTimeout(() => el.className = 'toast', 2400);
}
async function api(method, path, body) {
  if (!TOKEN) { promptToken(); if (!TOKEN) throw new Error('no token'); }
  const opts = {
    method,
    headers: { 'Authorization': 'Bearer ' + TOKEN }
  };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(path, opts);
  const data = await r.json();
  if (!data.ok) throw new Error(data.error || data.message || 'API error');
  return data;
}

document.getElementById('token-status').onclick = promptToken;
document.querySelectorAll('nav.tabs button').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('nav.tabs button').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('section.pane').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    document.getElementById('pane-' + b.dataset.tab).classList.add('active');
    if (b.dataset.tab === 'list') refreshList();
  };
});

document.getElementById('btn-issue').onclick = async () => {
  const count = parseInt(document.getElementById('i-count').value, 10);
  const expire = document.getElementById('i-expire').value;
  const notes = document.getElementById('i-notes').value;
  const body = { quantity: count, notes };
  if (expire) body.expire_at = expire + 'T23:59:59Z';
  try {
    const r = await api('POST', '/admin/codes', body);
    const out = '# 发码成功 (' + r.codes.length + ' 个)\\n' + r.codes.join('\\n');
    const box = document.getElementById('issue-result');
    box.textContent = out; box.style.display = 'block';
    toast('发码成功 ' + r.codes.length + ' 个');
  } catch (e) { toast('发码失败: ' + e.message, true); }
};

async function refreshList() {
  const status = document.getElementById('f-status').value;
  const mid = document.getElementById('f-mid').value.trim();
  const limit = document.getElementById('f-limit').value;
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (mid) qs.set('machine_id', mid);
  if (limit) qs.set('limit', limit);
  const summary = document.getElementById('list-summary');
  summary.textContent = '加载中…';
  try {
    const r = await api('GET', '/admin/codes?' + qs);
    summary.textContent = r.count + ' 条' + (r.list_complete === false ? ' (截断, 加大 limit)' : '');
    renderTable(r.codes);
  } catch (e) {
    summary.textContent = '';
    toast('列表加载失败: ' + e.message, true);
  }
}
document.getElementById('btn-refresh').onclick = refreshList;

function renderTable(codes) {
  const container = document.getElementById('list-table');
  if (codes.length === 0) { container.innerHTML = '<div class="empty">空</div>'; return; }
  const rows = codes.map(c => {
    const exp = c.expire_at ? new Date(c.expire_at * 1000).toISOString().slice(0,10) : '<span style="color:var(--ink-mute)">never</span>';
    const mid = c.bound_machine_id ? '<span class="mono" title="' + esc(c.bound_machine_id) + '">…' + esc(c.bound_machine_id.slice(-12)) + '</span>' : '<span style="color:var(--ink-mute)">-</span>';
    const reason = c.revoked_reason ? ' <span style="color:var(--red-deep)">[' + esc(c.revoked_reason) + ']</span>' : '';
    const notes = (c.notes || '') + reason;
    const status = '<span class="status-pill ' + c.status + '">' + c.status + '</span>';
    const actions = c.status === 'revoked'
      ? '<span style="color:var(--ink-mute);font-size:11px">-</span>'
      : '<button class="danger" data-action="revoke" data-code="' + esc(c.code) + '">吊销</button> '
      + '<button class="secondary" data-action="rebind" data-code="' + esc(c.code) + '">换绑</button>';
    return '<tr>'
      + '<td class="mono">' + esc(c.code) + '</td>'
      + '<td>' + status + '</td>'
      + '<td>' + exp + '</td>'
      + '<td style="text-align:center">' + (c.rebind_count || 0) + '</td>'
      + '<td>' + mid + '</td>'
      + '<td>' + esc(notes) + '</td>'
      + '<td class="actions">' + actions + '</td>'
      + '</tr>';
  }).join('');
  container.innerHTML = '<table><thead><tr><th>CODE</th><th>状态</th><th>过期</th><th>换绑次数</th><th>machine_id (尾)</th><th>备注 / 吊销原因</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table>';
  container.querySelectorAll('button[data-action]').forEach(b => {
    b.onclick = () => {
      const code = b.dataset.code;
      if (b.dataset.action === 'revoke') doRevoke(code);
      else doRebind(code);
    };
  });
}

async function doRevoke(code) {
  const reason = prompt('吊销原因 (会记录到 revoked_reason):', '');
  if (reason === null) return;
  try { await api('POST', '/admin/revoke', { code, reason }); toast('已吊销 ' + code); refreshList(); }
  catch (e) { toast('吊销失败: ' + e.message, true); }
}
async function doRebind(code) {
  const mid = prompt('粘贴新设备的 machine_id (在客户端激活页底部能看到):');
  if (!mid) return;
  try { await api('POST', '/admin/rebind', { code, new_machine_id: mid.trim() }); toast('换绑成功 ' + code); refreshList(); }
  catch (e) { toast('换绑失败: ' + e.message, true); }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

updateTokenStatus();
if (!TOKEN) promptToken();
</script>
</body>
</html>`;
