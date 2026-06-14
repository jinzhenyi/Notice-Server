// src/index.ts
export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  USERNAME: string;
  PASSWORD_HASH: string;
}

// ---------- 工具函数 ----------
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function setCookie(name: string, value: string, options: { httpOnly?: boolean; secure?: boolean; maxAge?: number; path?: string }) {
  let cookie = `${name}=${value}`;
  if (options.httpOnly) cookie += '; HttpOnly';
  if (options.secure) cookie += '; Secure';
  if (options.maxAge) cookie += `; Max-Age=${options.maxAge}`;
  if (options.path) cookie += `; Path=${options.path}`;
  return cookie;
}

function deleteCookie(name: string) {
  return `${name}=; Max-Age=0; Path=/`;
}

function parseCookies(request: Request): Record<string, string> {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return {};
  return Object.fromEntries(cookieHeader.split('; ').map(c => c.split('=')).map(([k, v]) => [k, decodeURIComponent(v)]));
}

// ---------- 核心推送逻辑 ----------
async function sendToChannels(env: Env, message: string, channelIds: number[]): Promise<any[]> {
  if (!channelIds.length) return [];
  const placeholders = channelIds.map(() => '?').join(',');
  const query = `SELECT * FROM channels WHERE custom_id IN (${placeholders})`;
  const targetChannels = await env.DB.prepare(query).bind(...channelIds).all();

  const results = [];
  for (const channel of targetChannels.results) {
    const channelConfig = JSON.parse(channel.config);
    try {
      await sendToChannel(channel.type, channelConfig, message);
      results.push({ channelId: channel.custom_id, name: channel.name, success: true });
    } catch (err: any) {
      results.push({ channelId: channel.custom_id, name: channel.name, success: false, error: err.message });
    }
  }
  return results;
}

// ---------- 各渠道发送实现 ----------
async function sendToChannel(type: string, config: any, message: string) {
  switch (type) {
    case 'dingtalk': return sendDingTalk(config, message);
    case 'bark': return sendBark(config, message);
    case 'resend': return sendResend(config, message);
    case 'wxpush': return sendWeChat(config, message);
    case 'serverchan': return sendServerChan(config, message);
    case 'webhook': return sendWebhook(config, message);
    default: throw new Error(`未知渠道类型: ${type}`);
  }
}

async function sendDingTalk(config: any, message: string) {
  let url = config.webhook;
  if (config.secret) {
    const timestamp = Date.now();
    const stringToSign = `${timestamp}\n${config.secret}`;
    const encoder = new TextEncoder();
    const keyData = encoder.encode(config.secret);
    const messageData = encoder.encode(stringToSign);
    const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
    const sign = btoa(String.fromCharCode(...new Uint8Array(signature)));
    url += `&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content: message } }),
  });
  if (!res.ok) throw new Error(`钉钉发送失败: ${res.status}`);
}

async function sendBark(config: any, message: string) {
  const url = `${config.baseUrl || 'https://api.day.app'}/${config.deviceKey}/${encodeURIComponent(message)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: config.title || '通知', sound: 'alarm.caf' }),
  });
  if (!res.ok) throw new Error(`Bark发送失败: ${res.status}`);
}

async function sendResend(config: any, message: string) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: config.from,
      to: config.to,
      subject: config.subject || '新通知',
      html: `<p>${message.replace(/\n/g, '<br>')}</p>`,
    }),
  });
  if (!res.ok) throw new Error(`Resend发送失败: ${res.status}`);
}

async function sendWeChat(config: any, message: string) {
  const tokenUrl = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${config.appId}&secret=${config.appSecret}`;
  const tokenRes = await fetch(tokenUrl);
  const { access_token } = await tokenRes.json();
  if (!access_token) throw new Error('获取微信 access_token 失败');
  const sendUrl = `https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${access_token}`;
  const res = await fetch(sendUrl, {
    method: 'POST',
    body: JSON.stringify({
      touser: config.openId,
      template_id: config.templateId,
      data: {
        content: { value: message },
        time: { value: new Date().toLocaleString() },
      },
    }),
  });
  const result = await res.json();
  if (result.errcode !== 0) throw new Error(`微信发送失败: ${result.errmsg}`);
}

async function sendServerChan(config: any, message: string) {
  const url = `https://sctapi.ftqq.com/${config.sendKey}.send`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: config.title || '通知', desp: message }),
  });
  if (!res.ok) throw new Error(`Server酱发送失败: ${res.status}`);
}

async function sendWebhook(config: any, message: string) {
  let url = config.url;
  if (config.url.includes('{{message}}')) {
    url = config.url.replace(/{{message}}/g, encodeURIComponent(message));
  }
  let body: any = config.bodyTemplate;
  if (body && typeof body === 'string' && body.includes('{{message}}')) {
    body = JSON.parse(body.replace(/{{message}}/g, message));
  } else if (!body) {
    body = { text: message };
  }
  const res = await fetch(url, {
    method: config.method || 'POST',
    headers: config.headers || { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Webhook 请求失败: ${res.status}`);
}

// ---------- 动态 Webhook 处理 ----------
async function handleDynamicWebhook(request: Request, env: Env, path: string): Promise<Response> {
  const match = path.match(/^\/webhook\/(.+)$/);
  if (!match) return new Response('Not Found', { status: 404 });
  const webhookPath = match[1];

  const webhook = await env.DB.prepare(
    'SELECT * FROM incoming_webhooks WHERE path = ?'
  ).bind(webhookPath).first();

  if (!webhook) return new Response('Webhook not found', { status: 404 });

  if (webhook.secret) {
    const authHeader = request.headers.get('X-Webhook-Secret') || request.headers.get('Authorization');
    if (authHeader !== webhook.secret) {
      return new Response('Unauthorized', { status: 401 });
    }
  }

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const { fromAddress, subject, content, html, receivedAt } = payload;
  const messageText = `📧 ${webhook.name}\n发件人: ${fromAddress || '未知'}\n主题: ${subject || '无主题'}\n内容: ${content || html?.replace(/<[^>]*>/g, '') || '无内容'}\n时间: ${receivedAt || new Date().toISOString()}`;

  // 解析 target_channel_ids 字符串，如 "1,2,3" 或 "-1"
  let targetChannelIds: number[] = [];
  const idsStr = webhook.target_channel_ids?.trim();
  if (idsStr && idsStr !== '') {
    if (idsStr === '-1') {
      targetChannelIds = [-1];
    } else {
      targetChannelIds = idsStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    }
  }

  let finalChannelIds: number[] = [];
  if (targetChannelIds.includes(-1)) {
    const allChannels = await env.DB.prepare('SELECT custom_id FROM channels').all();
    finalChannelIds = allChannels.results.map(c => c.custom_id);
  } else {
    finalChannelIds = targetChannelIds;
  }

  if (finalChannelIds.length === 0) {
    return Response.json({ success: false, message: '没有关联任何推送渠道' }, { status: 200 });
  }

  const results = await sendToChannels(env, messageText, finalChannelIds);
  return Response.json({ success: true, results });
}

// ---------- 路由分发 ----------
async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path.startsWith('/webhook/') && path !== '/webhook/' && method === 'POST') {
    return handleDynamicWebhook(request, env, path);
  }

  if (path === '/login' && method === 'GET') {
    return new Response(getLoginHTML(), { headers: { 'Content-Type': 'text/html' } });
  }

  if (path === '/api/login' && method === 'POST') {
    const { username, password } = await request.json();
    if (username !== env.USERNAME) {
      return Response.json({ success: false, message: '用户名或密码错误' });
    }
    const hashedInput = await hashPassword(password);
    if (hashedInput !== env.PASSWORD_HASH) {
      return Response.json({ success: false, message: '用户名或密码错误' });
    }
    const sessionId = crypto.randomUUID();
    await env.SESSIONS.put(sessionId, username, { expirationTtl: 86400 });
    const cookie = setCookie('session_id', sessionId, { httpOnly: true, secure: true, maxAge: 86400, path: '/' });
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie }
    });
  }

  if (path === '/api/logout' && method === 'GET') {
    const cookies = parseCookies(request);
    const sessionId = cookies['session_id'];
    if (sessionId) await env.SESSIONS.delete(sessionId);
    const deleteCookieHeader = deleteCookie('session_id');
    return new Response(null, {
      status: 302,
      headers: { 'Location': '/login', 'Set-Cookie': deleteCookieHeader }
    });
  }

  const needAuth = !(path === '/login' || path === '/api/login' || path === '/api/logout' || path.startsWith('/webhook/'));
  if (needAuth) {
    const cookies = parseCookies(request);
    const sessionId = cookies['session_id'];
    if (!sessionId) return new Response(null, { status: 302, headers: { 'Location': '/login' } });
    const username = await env.SESSIONS.get(sessionId);
    if (!username) return new Response(null, { status: 302, headers: { 'Location': '/login' } });
  }

  if (path === '/' && method === 'GET') {
    const channels = await env.DB.prepare('SELECT * FROM channels ORDER BY custom_id ASC').all();
    const webhooks = await env.DB.prepare('SELECT * FROM incoming_webhooks ORDER BY id DESC').all();
    const html = generateDashboardHTML(channels.results, webhooks.results);
    return new Response(html, { headers: { 'Content-Type': 'text/html' } });
  }

  // 出站渠道 API
  if (path === '/api/channels' && method === 'GET') {
    const channels = await env.DB.prepare('SELECT * FROM channels ORDER BY custom_id ASC').all();
    return Response.json({ success: true, data: channels.results });
  }
  if (path === '/api/channels' && method === 'POST') {
    const { custom_id, name, type, config } = await request.json();
    if (!name || !type || !config) return Response.json({ success: false, message: '缺少必要字段' }, { status: 400 });
    // 如果提供了 custom_id 且不为空，检查唯一性
    let finalCustomId = custom_id ? parseInt(custom_id) : null;
    if (finalCustomId) {
      const existing = await env.DB.prepare('SELECT id FROM channels WHERE custom_id = ?').bind(finalCustomId).first();
      if (existing) return Response.json({ success: false, message: '自定义ID已存在' }, { status: 400 });
    }
    const result = await env.DB.prepare(
      'INSERT INTO channels (name, type, config, custom_id) VALUES (?, ?, ?, ?)'
    ).bind(name, type, JSON.stringify(config), finalCustomId).run();
    // 如果没有提供 custom_id，则设置为自增 id
    const newId = result.meta.last_row_id;
    if (!finalCustomId) {
      await env.DB.prepare('UPDATE channels SET custom_id = ? WHERE id = ?').bind(newId, newId).run();
    }
    return Response.json({ success: true, id: finalCustomId || newId });
  }
  if (path.match(/^\/api\/channels\/\d+$/) && method === 'PUT') {
    const id = path.split('/').pop();
    const { custom_id, name, type, config } = await request.json();
    if (!name || !type || !config) return Response.json({ success: false, message: '缺少必要字段' }, { status: 400 });
    // 如果修改 custom_id，检查唯一性
    let newCustomId = custom_id ? parseInt(custom_id) : null;
    if (newCustomId) {
      const existing = await env.DB.prepare('SELECT id FROM channels WHERE custom_id = ? AND id != ?').bind(newCustomId, id).first();
      if (existing) return Response.json({ success: false, message: '自定义ID已存在' }, { status: 400 });
    }
    // 更新时，如果 newCustomId 为空，保持原 custom_id 不变（或设置为 id，但需要先查当前 id）
    if (!newCustomId) {
      const current = await env.DB.prepare('SELECT id FROM channels WHERE id = ?').bind(id).first();
      newCustomId = current.id;
    }
    await env.DB.prepare(
      'UPDATE channels SET name = ?, type = ?, config = ?, custom_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).bind(name, type, JSON.stringify(config), newCustomId, id).run();
    return Response.json({ success: true });
  }
  if (path.match(/^\/api\/channels\/\d+$/) && method === 'DELETE') {
    const id = path.split('/').pop();
    await env.DB.prepare('DELETE FROM channels WHERE id = ?').bind(id).run();
    return Response.json({ success: true });
  }

  // 入站 Webhook API
  if (path === '/api/webhooks' && method === 'GET') {
    const webhooks = await env.DB.prepare('SELECT * FROM incoming_webhooks ORDER BY id DESC').all();
    return Response.json({ success: true, data: webhooks.results });
  }
  if (path === '/api/webhooks' && method === 'POST') {
    const { name, path: webhookPath, secret, target_channel_ids } = await request.json();
    if (!name || !webhookPath) return Response.json({ success: false, message: '缺少必要字段' }, { status: 400 });
    const existing = await env.DB.prepare('SELECT id FROM incoming_webhooks WHERE path = ?').bind(webhookPath).first();
    if (existing) return Response.json({ success: false, message: '路径已存在' }, { status: 400 });
    const result = await env.DB.prepare(
      'INSERT INTO incoming_webhooks (name, path, secret, target_channel_ids) VALUES (?, ?, ?, ?)'
    ).bind(name, webhookPath, secret || null, target_channel_ids || '').run();
    return Response.json({ success: true, id: result.meta.last_row_id });
  }
  if (path.match(/^\/api\/webhooks\/\d+$/) && method === 'PUT') {
    const id = path.split('/').pop();
    const { name, path: webhookPath, secret, target_channel_ids } = await request.json();
    if (!name || !webhookPath) return Response.json({ success: false, message: '缺少必要字段' }, { status: 400 });
    const existing = await env.DB.prepare('SELECT id FROM incoming_webhooks WHERE path = ? AND id != ?').bind(webhookPath, id).first();
    if (existing) return Response.json({ success: false, message: '路径已存在' }, { status: 400 });
    await env.DB.prepare(
      'UPDATE incoming_webhooks SET name = ?, path = ?, secret = ?, target_channel_ids = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).bind(name, webhookPath, secret || null, target_channel_ids || '', id).run();
    return Response.json({ success: true });
  }
  if (path.match(/^\/api\/webhooks\/\d+$/) && method === 'DELETE') {
    const id = path.split('/').pop();
    await env.DB.prepare('DELETE FROM incoming_webhooks WHERE id = ?').bind(id).run();
    return Response.json({ success: true });
  }

  return new Response('Not Found', { status: 404 });
}

// ---------- HTML 模板 ----------
function getLoginHTML(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>推送系统 - 登录</title><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-gray-100 flex items-center justify-center min-h-screen">
<div class="bg-white p-8 rounded-lg shadow-md w-96">
<h1 class="text-2xl font-bold mb-6 text-center">管理员登录</h1>
<form id="loginForm">
<div class="mb-4"><label class="block text-gray-700 mb-2">用户名</label><input type="text" id="username" class="w-full px-3 py-2 border rounded-lg" required></div>
<div class="mb-6"><label class="block text-gray-700 mb-2">密码</label><input type="password" id="password" class="w-full px-3 py-2 border rounded-lg" required></div>
<button type="submit" class="w-full bg-blue-500 text-white py-2 rounded-lg hover:bg-blue-600">登录</button>
</form>
<div id="error" class="mt-4 text-red-500 text-center hidden"></div>
</div>
<script>
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const data = await res.json();
  if (data.success) { window.location.href = '/'; } else { const errDiv = document.getElementById('error'); errDiv.textContent = data.message; errDiv.classList.remove('hidden'); }
});
</script>
</body></html>`;
}

function generateDashboardHTML(channels: any[], webhooks: any[]): string {
  const channelsJson = JSON.stringify(channels).replace(/</g, '\\u003c');
  const webhooksJson = JSON.stringify(webhooks).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>推送系统 - 仪表板</title><script src="https://cdn.tailwindcss.com"></script>
<style>
.table-container { overflow-x: auto; -webkit-overflow-scrolling: touch; }
@media (max-width: 640px) { .table-container table { min-width: 600px; } .table-container td, .table-container th { white-space: nowrap; } }
</style>
</head>
<body class="bg-gray-100 p-4 md:p-6">
<div class="max-w-6xl mx-auto">
<div class="flex justify-between items-center mb-6"><h1 class="text-2xl md:text-3xl font-bold text-gray-800">📢 通知推送系统</h1><a href="/api/logout" class="bg-red-500 text-white px-3 py-1 md:px-4 md:py-2 rounded text-sm md:text-base">退出登录</a></div>

<!-- 接收渠道配置板块 -->
<div class="bg-white rounded-lg shadow p-4 md:p-6 mb-8">
<div class="flex flex-wrap justify-between items-center mb-4"><h2 class="text-xl font-semibold">📥 接收渠道配置 (Webhook 入站)</h2><button onclick="showAddWebhookModal()" class="bg-green-500 text-white px-3 py-1 rounded text-sm">+ 添加</button></div>
<div class="table-container">
<table class="min-w-full bg-white">
<thead><tr><th class="py-2 px-2 border-b">名称</th><th class="py-2 px-2 border-b">路径</th><th class="py-2 px-2 border-b">密钥</th><th class="py-2 px-2 border-b">关联渠道ID</th><th class="py-2 px-2 border-b">操作</th></tr></thead>
<tbody id="webhookTableBody"></tbody>
</table>
</div>
<div class="mt-4 text-xs text-gray-500">💡 Webhook URL: https://你的域名/webhook/{路径}</div>
</div>

<!-- 出站渠道配置板块 -->
<div class="bg-white rounded-lg shadow p-4 md:p-6">
<div class="flex flex-wrap justify-between items-center mb-4"><h2 class="text-xl font-semibold">📤 出站渠道配置 (推送目标)</h2><button onclick="showAddChannelModal()" class="bg-green-500 text-white px-3 py-1 rounded text-sm">+ 添加</button></div>
<div class="table-container">
<table class="min-w-full bg-white">
<thead><tr><th class="py-2 px-2 border-b">ID</th><th class="py-2 px-2 border-b">名称</th><th class="py-2 px-2 border-b">类型</th><th class="py-2 px-2 border-b">配置摘要</th><th class="py-2 px-2 border-b">操作</th></tr></thead>
<tbody id="channelTableBody"></tbody>
</table>
</div>
<div class="mt-2 text-xs text-gray-500">💡 在接收渠道中，使用上表中的 ID 来关联（多个ID用逗号分隔，如 "1,2,3"；输入 "-1" 表示推送到全部渠道）</div>
</div>
</div>

<!-- 模态框：添加入站 Webhook -->
<div id="webhookModal" class="fixed inset-0 bg-gray-600 bg-opacity-50 hidden items-center justify-center">
  <div class="bg-white rounded-lg p-6 w-96 max-h-[90vh] overflow-y-auto">
    <h3 id="webhookModalTitle" class="text-lg font-bold mb-4">添加入站 Webhook</h3>
    <form id="webhookForm">
      <input type="hidden" id="webhookId">
      <div class="mb-3">
        <label>模板</label>
        <select id="webhookTemplate" class="w-full border rounded p-1">
          <option value="custom">自定义</option>
          <option value="moemail">moemail 邮件</option>
          <option value="default">默认</option>
        </select>
      </div>
      <div class="mb-3">
        <label>名称</label>
        <input type="text" id="webhookName" class="w-full border rounded p-1" required>
      </div>
      <div class="mb-3">
        <label>路径 (唯一)</label>
        <input type="text" id="webhookPath" class="w-full border rounded p-1" required>
      </div>
      <div class="mb-3">
        <label>密钥 (可选)</label>
        <input type="text" id="webhookSecret" class="w-full border rounded p-1" placeholder="用于验证 X-Webhook-Secret 头">
      </div>
      <div class="mb-3">
        <label>关联的出站渠道ID（多个用逗号分隔，如 "1,2,3"；输入 "-1" 表示所有渠道）</label>
        <input type="text" id="webhookTargetIds" class="w-full border rounded p-1" placeholder="例如: 1,2,3 或 -1">
      </div>
      <div class="flex justify-end gap-2">
        <button type="button" onclick="closeWebhookModal()" class="bg-gray-300 px-3 py-1 rounded">取消</button>
        <button type="submit" class="bg-blue-500 text-white px-3 py-1 rounded">保存</button>
      </div>
    </form>
  </div>
</div>

<!-- 模态框：出站渠道（支持自定义ID） -->
<div id="channelModal" class="fixed inset-0 bg-gray-600 bg-opacity-50 hidden items-center justify-center"><div class="bg-white rounded-lg p-6 w-96"><h3 id="modalTitle" class="text-lg font-bold mb-4">添加渠道</h3><form id="channelForm"><input type="hidden" id="channelId"><div class="mb-3"><label>自定义ID (可选，不填则自动生成)</label><input type="number" id="channelCustomId" class="w-full border rounded p-1" placeholder="数字，例如 100"></div><div class="mb-3"><label>渠道名称</label><input type="text" id="channelName" class="w-full border rounded p-1" required></div><div class="mb-3"><label>类型</label><select id="channelType" class="w-full border rounded p-1"><option value="dingtalk">钉钉机器人</option><option value="bark">Bark</option><option value="resend">Resend邮件</option><option value="wxpush">微信公众号测试号</option><option value="serverchan">Server酱</option><option value="webhook">自定义Webhook</option></select></div><div id="dynamicConfigFields" class="mb-3"></div><div class="flex justify-end gap-2"><button type="button" onclick="closeModal()" class="bg-gray-300 px-3 py-1 rounded">取消</button><button type="submit" class="bg-blue-500 text-white px-3 py-1 rounded">保存</button></div></form></div></div>

<script>
let currentChannels = ${channelsJson};
let currentWebhooks = ${webhooksJson};
const typeConfigMap = { dingtalk: ['webhook','secret'], bark: ['deviceKey','baseUrl','title'], resend: ['apiKey','from','to','subject'], wxpush: ['appId','appSecret','openId','templateId'], serverchan: ['sendKey','title'], webhook: ['url','method','headers','bodyTemplate'] };

// ----- 工具函数 -----
function escapeHtml(str) { return str.replace(/[&<>]/g, function(m){ if(m==='&') return '&amp;'; if(m==='<') return '&lt;'; if(m==='>') return '&gt;'; return m; }); }

// ----- 渲染出站渠道表格 -----
function renderChannelTable() {
  const tbody = document.getElementById('channelTableBody');
  if (!currentChannels.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4">暂无出站渠道，请点击上方按钮添加</td></tr>';
    return;
  }
  let html = '';
  for (let ch of currentChannels) {
    let configStr = JSON.stringify(JSON.parse(ch.config));
    if (configStr.length > 40) configStr = configStr.substring(0, 40) + '…';
    configStr = configStr.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    html += '<tr>';
    html += '<td class="py-2 px-2 border-b">' + ch.custom_id + '</td>';
    html += '<td class="py-2 px-2 border-b">' + escapeHtml(ch.name) + '</td>';
    html += '<td class="py-2 px-2 border-b">' + ch.type + '</td>';
    html += '<td class="py-2 px-2 border-b text-sm break-all">' + configStr + '</td>';
    html += '<td class="py-2 px-2 border-b"><button onclick="editChannel(' + ch.id + ')" class="text-blue-500 mr-2">编辑</button><button onclick="deleteChannel(' + ch.id + ')" class="text-red-500">删除</button>NonNullList</td>';
    html += '</table>';
  }
  tbody.innerHTML = html;
}

// ----- 渲染入站 Webhook 表格 -----
function renderWebhookTable() {
  const tbody = document.getElementById('webhookTableBody');
  if (!currentWebhooks.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4">暂无接收渠道，请点击上方按钮添加</td></tr>';
    return;
  }
  let html = '';
  for (let wh of currentWebhooks) {
    html += '<tr>';
    html += '<td class="py-2 px-2 border-b">' + escapeHtml(wh.name) + '</td>';
    html += '<td class="py-2 px-2 border-b">/webhook/' + escapeHtml(wh.path) + '</td>';
    html += '<td class="py-2 px-2 border-b">' + (wh.secret ? '已设置' : '无') + '</td>';
    html += '<td class="py-2 px-2 border-b">' + escapeHtml(wh.target_channel_ids || '') + '</td>';
    html += '<td class="py-2 px-2 border-b"><button onclick="editWebhook(' + wh.id + ')" class="text-blue-500 mr-2">编辑</button><button onclick="deleteWebhook(' + wh.id + ')" class="text-red-500">删除</button>NonNullList</td>';
    html += '</tr>';
  }
  tbody.innerHTML = html;
}

// ----- 模板选择逻辑 -----
document.getElementById('webhookTemplate')?.addEventListener('change', function(e) {
  const template = e.target.value;
  const nameInput = document.getElementById('webhookName');
  const pathInput = document.getElementById('webhookPath');
  const secretInput = document.getElementById('webhookSecret');
  if (template === 'moemail') {
    nameInput.value = 'moemail 邮件';
    pathInput.value = 'moemail';
    secretInput.placeholder = '可选，但建议设置';
  } else if (template === 'default') {
    nameInput.value = '默认 Webhook';
    pathInput.value = 'default';
    secretInput.placeholder = '可选';
  } else {
    nameInput.value = '';
    pathInput.value = '';
    secretInput.placeholder = '用于验证 X-Webhook-Secret 头';
  }
});

// ----- 出站渠道 CRUD -----
function showAddChannelModal() {
  document.getElementById('modalTitle').innerText = '添加渠道';
  document.getElementById('channelId').value = '';
  document.getElementById('channelCustomId').value = '';
  document.getElementById('channelName').value = '';
  document.getElementById('channelType').value = 'dingtalk';
  generateConfigFields('dingtalk', {});
  document.getElementById('channelModal').classList.remove('hidden');
  document.getElementById('channelModal').classList.add('flex');
}
function editChannel(id) {
  const ch = currentChannels.find(c => c.id === id);
  if (!ch) return;
  document.getElementById('modalTitle').innerText = '编辑渠道';
  document.getElementById('channelId').value = ch.id;
  document.getElementById('channelCustomId').value = ch.custom_id;
  document.getElementById('channelName').value = ch.name;
  document.getElementById('channelType').value = ch.type;
  generateConfigFields(ch.type, JSON.parse(ch.config));
  document.getElementById('channelModal').classList.remove('hidden');
  document.getElementById('channelModal').classList.add('flex');
}
function generateConfigFields(type, existing) {
  const container = document.getElementById('dynamicConfigFields');
  const fields = typeConfigMap[type] || [];
  container.innerHTML = '';
  for (let field of fields) {
    const div = document.createElement('div');
    div.className = 'mb-2';
    div.innerHTML = '<label>' + field + '</label><input type="text" id="cfg_' + field + '" class="w-full border rounded p-1" value="' + (existing[field] || '') + '" placeholder="输入' + field + '">';
    container.appendChild(div);
  }
}
document.getElementById('channelType').addEventListener('change', (e) => generateConfigFields(e.target.value, {}));
document.getElementById('channelForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('channelId').value;
  const custom_id = document.getElementById('channelCustomId').value;
  const name = document.getElementById('channelName').value;
  const type = document.getElementById('channelType').value;
  const config = {};
  for (let field of (typeConfigMap[type] || [])) {
    const val = document.getElementById('cfg_' + field).value;
    if (val) config[field] = val;
  }
  const url = id ? '/api/channels/' + id : '/api/channels';
  const method = id ? 'PUT' : 'POST';
  const body = { name, type, config };
  if (custom_id) body.custom_id = parseInt(custom_id);
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.ok) { location.reload(); } else { const err = await res.json(); alert('保存失败: ' + err.message); }
});
async function deleteChannel(id) {
  if (!confirm('确定删除该渠道吗？')) return;
  await fetch('/api/channels/' + id, { method: 'DELETE' });
  location.reload();
}

// ----- 入站 Webhook CRUD -----
function showAddWebhookModal() {
  document.getElementById('webhookModalTitle').innerText = '添加入站 Webhook';
  document.getElementById('webhookId').value = '';
  document.getElementById('webhookName').value = '';
  document.getElementById('webhookPath').value = '';
  document.getElementById('webhookSecret').value = '';
  document.getElementById('webhookTargetIds').value = '';
  document.getElementById('webhookTemplate').value = 'custom';
  document.getElementById('webhookModal').classList.remove('hidden');
  document.getElementById('webhookModal').classList.add('flex');
}
function editWebhook(id) {
  const wh = currentWebhooks.find(w => w.id === id);
  if (!wh) return;
  document.getElementById('webhookModalTitle').innerText = '编辑入站 Webhook';
  document.getElementById('webhookId').value = wh.id;
  document.getElementById('webhookName').value = wh.name;
  document.getElementById('webhookPath').value = wh.path;
  document.getElementById('webhookSecret').value = wh.secret || '';
  document.getElementById('webhookTargetIds').value = wh.target_channel_ids || '';
  document.getElementById('webhookTemplate').value = 'custom';
  document.getElementById('webhookModal').classList.remove('hidden');
  document.getElementById('webhookModal').classList.add('flex');
}
document.getElementById('webhookForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('webhookId').value;
  const name = document.getElementById('webhookName').value;
  const path = document.getElementById('webhookPath').value;
  const secret = document.getElementById('webhookSecret').value;
  const target_channel_ids = document.getElementById('webhookTargetIds').value.trim();
  const url = id ? '/api/webhooks/' + id : '/api/webhooks';
  const method = id ? 'PUT' : 'POST';
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, path, secret, target_channel_ids }) });
  if (res.ok) { location.reload(); } else { const err = await res.json(); alert('保存失败: ' + err.message); }
});
async function deleteWebhook(id) {
  if (!confirm('确定删除该接收渠道吗？')) return;
  await fetch('/api/webhooks/' + id, { method: 'DELETE' });
  location.reload();
}
function closeWebhookModal() { document.getElementById('webhookModal').classList.add('hidden'); document.getElementById('webhookModal').classList.remove('flex'); }
function closeModal() { document.getElementById('channelModal').classList.add('hidden'); document.getElementById('channelModal').classList.remove('flex'); }

// 初始化
renderChannelTable();
renderWebhookTable();
</script>
</body></html>`;
}

// ---------- Worker 入口 ----------
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx);
    } catch (err: any) {
      console.error(err);
      return new Response(`Internal Error: ${err.message}`, { status: 500 });
    }
  }
};