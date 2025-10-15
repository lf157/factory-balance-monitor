# 📚 Vercel 部署完整指南

## 🎯 概述

本项目支持两种运行模式：
- **本地模式**：使用文件系统存储，数据保存在本地
- **Vercel 模式**：使用 Vercel KV 存储，数据持久化在云端

## ✨ Vercel 部署的优势

### ✅ 数据持久化
- 使用 Vercel KV (Redis) 存储配置和历史数据
- 添加/删除/修改 Key 会永久保存
- 历史趋势数据不会丢失
- 支持多设备访问同一数据

### ✅ 无需服务器
- 完全 Serverless，按需计费
- 自动扩缩容，无需维护
- 全球 CDN 加速访问

### ✅ 免费额度充足
- Vercel KV：每月 3000 次请求 + 30MB 存储
- 足够个人和小团队使用

## 🚀 部署步骤

### 步骤 1：点击一键部署按钮

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Flf157%2Ffactory-balance-monitor-vercel)

或访问 GitHub 仓库：https://github.com/lf157/factory-balance-monitor-vercel

### 步骤 2：授权并创建项目

1. 使用 GitHub 账号登录 Vercel
2. 选择项目名称（如：`factory-monitor`）
3. 点击 **"Deploy"** 开始部署

### 步骤 3：配置 Vercel Blob 存储

部署完成后，需要添加 Blob 存储以支持数据持久化：

1. **进入项目设置**
   - 在 Vercel Dashboard 中点击你的项目
   - 点击顶部的 **"Storage"** 标签

2. **创建 Blob 存储**
   - 点击 **"Browse Storage"**
   - 选择 **"Blob"** (Fast object storage)
   - 点击 **"Get Started"** 或 **"Create Database"**
   - 输入存储名称（如：`factory-balance-blob`）
   - 选择区域（推荐选择离你最近的区域）
   - 点击 **"Create"**

3. **连接到项目**
   - 创建完成后，点击 **"Connect Project"**
   - 选择你的项目
   - Vercel 会自动添加以下环境变量：
     - `BLOB_READ_WRITE_TOKEN`
     - 其他 Blob 相关的环境变量

### 步骤 4：配置环境变量（可选）

如果你想预设一些 API Keys，可以添加环境变量：

1. 进入 **"Settings"** → **"Environment Variables"**
2. 添加变量 `FACTORY_API_KEYS` 或 `API_KEYS`，值为 JSON 格式：

```json
[
  {
    "id": "key-1",
    "key": "fk-your-actual-key",
    "alias": "主账户",
    "group": "production",
    "note": "生产环境使用",
    "enabled": true
  }
]
```

3. 点击 **"Save"**

### 步骤 5：重新部署

配置完成后需要重新部署：

1. 进入 **"Deployments"** 标签
2. 点击最新部署旁的三个点 **"..."**
3. 选择 **"Redeploy"**
4. 等待部署完成（约 1-2 分钟）

### 步骤 6：访问你的应用

部署成功后，点击 Vercel 提供的 URL 访问你的监控面板：
- 示例：`https://factory-monitor.vercel.app`

## 📊 使用说明

### 界面功能完整性

在 Vercel 部署后，所有功能都可以正常使用：

#### ✅ 支持的功能
- **添加 Key**：通过界面添加新 Key，永久保存在 Vercel KV
- **删除 Key**：删除操作会真正从云端移除
- **编辑 Key**：修改别名、分组、备注等信息
- **批量测试**：测试所有 Keys 的有效性
- **历史记录**：查看使用趋势图表（数据持久化）
- **自动刷新**：定时获取最新余额信息

#### 🔄 数据同步
- 所有操作实时同步到 Vercel KV
- 多设备访问看到相同数据
- 刷新页面不会丢失配置

### 存储限制

Vercel Blob 免费额度：
- **存储空间**：1GB
- **请求数**：10,000 次/月
- **带宽**：1GB/月
- **单文件大小**：最大 4.5MB

对于本项目：
- 配置文件通常小于 10KB
- 历史记录文件通常小于 100KB
- 足够存储 100+ 个 Keys 和数月的历史数据

## 🔧 高级配置

### 自定义域名

1. 在 Vercel 项目设置中进入 **"Domains"**
2. 添加你的自定义域名
3. 按照提示配置 DNS 记录

### 访问控制

如需限制访问，可以：

1. **使用 Vercel Authentication**
   - 在项目设置中启用 **"Password Protection"**
   - 设置访问密码

2. **集成 Vercel Auth**
   - 支持 GitHub、Google 等 OAuth 登录
   - 需要修改代码添加认证中间件

### 监控和日志

1. **查看函数日志**
   - 在 Vercel Dashboard 中点击 **"Functions"** 标签
   - 查看实时日志和错误信息

2. **性能监控**
   - 查看 **"Analytics"** 了解访问情况
   - 监控函数执行时间和错误率

## ❓ 常见问题

### Q: 为什么数据没有保存？

**A:** 检查是否已配置 Vercel Blob：
1. 确认 Storage 中已创建 Blob 存储
2. 检查环境变量中有 `BLOB_READ_WRITE_TOKEN`
3. 确保 Blob 存储已连接到你的项目
4. 重新部署项目

### Q: 如何迁移本地数据到 Vercel？

**A:** 可以通过以下步骤迁移：
1. 在本地导出 `config.json`
2. 在 Vercel 环境变量中设置 `API_KEYS`
3. 历史数据需要手动通过 API 导入

### Q: 超过免费额度怎么办？

**A:** 
- 3000 次请求/月对个人使用绰绰有余
- 如需更多，可升级到 Vercel Pro（$20/月）
- 或考虑自建服务器部署

### Q: 可以同时使用本地和 Vercel 吗？

**A:** 
- 可以，项目会自动检测环境
- 本地运行使用文件存储
- Vercel 部署使用 KV 存储
- 数据相互独立，不会冲突

## 📝 更新和维护

### 更新到最新版本

1. 在 GitHub 上 Fork 最新代码
2. 在 Vercel Dashboard 中触发重新部署
3. 或使用 Vercel CLI：`vercel --prod`

### 备份数据

建议定期备份重要数据：
1. 通过 API 导出配置：`/api/config`
2. 导出历史数据：`/api/history`
3. 保存到本地或云存储

## 💡 提示

1. **首次部署**：记得配置 Vercel KV，否则数据无法保存
2. **环境变量**：修改后需要重新部署才能生效
3. **免费额度**：正常使用不会超过免费额度
4. **数据安全**：API Keys 只存储在你的 Vercel 账户下

## 🆘 获取帮助

如遇到问题：
1. 查看 Vercel Functions 日志
2. 检查浏览器控制台错误
3. 在 GitHub 仓库提交 Issue
4. 参考 [Vercel 官方文档](https://vercel.com/docs)

---

**祝你使用愉快！** 🎉

如有任何问题或建议，欢迎在 GitHub 上提交 Issue 或 PR。
