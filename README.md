# Notice Server

# 项目未经完全测试

> **⚠️ 实验性项目**  
> 本项目未经完整测试，可能存在未知缺陷或安全风险。**请勿在生产环境中使用**。

![Test Coverage](https://img.shields.io/badge/coverage-80%25-brightgreen)

## 功能特点
- **单一管理员账户**：用户名和密码通过环境变量配置（密码 SHA-256 哈希）
- **出站渠道管理**：支持钉钉、Bark、Resend、微信公众号测试号、Server酱、自定义 Webhook，可自定义渠道 ID（数字）
- **入站 Webhook 配置**：动态路径、可选密钥验证，支持关联单个或多个出站渠道（使用逗号分隔的 ID 列表，`-1` 表示所有渠道）
- **接收邮件通知**：预置 moemail 模板，自动解析邮件字段并推送
- **全托管于 Cloudflare**：使用 D1 数据库、KV 存储会话、免费 Workers 部署

## 部署方法
### 配置wrangler.toml文件后即可在cloudflare中部署。