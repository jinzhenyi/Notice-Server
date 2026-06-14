# Notice Server
## 功能特点
- **单一管理员账户**：用户名和密码通过环境变量配置（密码 SHA-256 哈希）
- **出站渠道管理**：支持钉钉、Bark、Resend、微信公众号测试号、Server酱、自定义 Webhook，可自定义渠道 ID（数字）
- **入站 Webhook 配置**：动态路径、可选密钥验证，支持关联单个或多个出站渠道（使用逗号分隔的 ID 列表，`-1` 表示所有渠道）
- **接收邮件通知**：预置 moemail 模板，自动解析邮件字段并推送
- **全托管于 Cloudflare**：使用 D1 数据库、KV 存储会话、免费 Workers 部署

========================================
   通知推送系统 - Cloudflare 部署指南
========================================

一、准备工作
------------
- Node.js 18+ 环境
- Cloudflare 账号
- 已安装 Git

二、下载代码
------------
git clone <你的仓库地址>
cd notify-system
npm install

三、创建 D1 数据库
------------------
npx wrangler d1 create notify-db
→ 输出示例：[[d1_databases]] binding = "DB" database_name = "notify-db" database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
→ 记录 database_id

四、创建 KV Namespace
---------------------
npx wrangler kv:namespace create SESSIONS
→ 输出示例：[[kv_namespaces]] binding = "SESSIONS" id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
→ 记录 id

五、配置 wrangler.toml
----------------------
编辑 wrangler.toml，填入上两步获得的 database_id 和 kv id：
----------------------------------------
name = "notify-system"
main = "src/index.ts"
compatibility_date = "2025-01-01"

[[d1_databases]]
binding = "DB"
database_name = "notify-db"
database_id = "你的database_id"

[[kv_namespaces]]
binding = "SESSIONS"
id = "你的kv_id"

[vars]
USERNAME = "admin"
PASSWORD_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
----------------------------------------
注意：PASSWORD_HASH 是密码的 SHA-256 哈希，请按第七步生成并替换。

六、初始化数据库表
------------------
npx wrangler d1 execute notify-db --file=schema.sql

七、生成管理员密码哈希
----------------------
在浏览器控制台或 Node.js 中运行以下代码（将 "你的密码" 替换为真实密码）：
----------------------------------------
async function hash(pwd) {
  const encoder = new TextEncoder();
  const data = encoder.encode(pwd);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2,'0')).join('');
}
hash('你的密码').then(console.log);
----------------------------------------
输出一个 64 位十六进制字符串，复制它替换 wrangler.toml 中的 PASSWORD_HASH。

八、部署到 Cloudflare
---------------------
npx wrangler deploy

部署成功后，会输出一个 Workers 域名，例如 https://notify-system.xxx.workers.dev

九、登录使用
------------
访问该域名，使用 USERNAME 和明文密码登录（不是哈希）。

十、添加通知渠道
----------------
1. 出站渠道：点击「出站渠道配置」-「+添加」，选择类型（钉钉/Bark/Resend 等），填写配置。可自定义ID（数字），留空则自动生成。保存后记住列表中的ID。
2. 接收渠道：点击「接收渠道配置」-「+添加」，填写名称、路径（唯一），密钥可选。在“关联的出站渠道ID”中，输入上一步获取的ID（多个用逗号分隔，如 1,2,3；输入 -1 表示所有渠道）。保存。

十一、测试 Webhook
-----------------
向 https://你的域名/webhook/你的路径 发送 POST 请求，Content-Type: application/json，请求体示例：
{
  "fromAddress": "sender@example.com",
  "subject": "测试",
  "content": "Hello",
  "receivedAt": "2025-01-01T00:00:00Z"
}

所有关联的出站渠道将收到推送。

十二、常用命令
--------------
本地开发：   npx wrangler dev
查看日志：   npx wrangler tail
更新部署：   npx wrangler deploy

十三、故障排除
--------------
- 登录后页面空白：检查 D1 和 KV 绑定是否正确，重新部署。
- 添加渠道失败：检查表单字段是否完整，D1 表结构是否正确。
- Webhook 返回 404：检查路径是否与接收渠道配置的路径一致。
- 推送失败：查看出站渠道配置是否正确（如钉钉 webhook 地址）。

========================================
