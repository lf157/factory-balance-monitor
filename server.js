const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// 配置文件路径
const CONFIG_FILE = path.join(__dirname, 'config.json');
const HISTORY_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(HISTORY_DIR, 'history.json');

// 确保数据目录存在
if (!fs.existsSync(HISTORY_DIR)) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

// 加载配置文件
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      const defaultConfig = {
        apiKeys: [],
        settings: {
          autoRefreshInterval: 300000,
          alertThreshold: 0.8,
          historyRetentionDays: 30
        }
      };
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
      return defaultConfig;
    }
    const data = fs.readFileSync(CONFIG_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('❌ 加载配置文件失败:', error.message);
    return { apiKeys: [], settings: {} };
  }
}

// 保存配置文件
function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log('✅ 配置已保存到文件');
    return true;
  } catch (error) {
    console.error('❌ 保存配置文件失败:', error.message);
    return false;
  }
}

// 加载历史数据
function loadHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) {
      return [];
    }
    const data = fs.readFileSync(HISTORY_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('❌ 加载历史数据失败:', error.message);
    return [];
  }
}

// 保存历史数据
function saveHistory(historyData) {
  try {
    // 清理过期数据
    const config = loadConfig();
    const retentionDays = config.settings.historyRetentionDays || 30;
    const cutoffTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    const filteredData = historyData.filter(item => item.timestamp > cutoffTime);

    fs.writeFileSync(HISTORY_FILE, JSON.stringify(filteredData, null, 2));
    return true;
  } catch (error) {
    console.error('❌ 保存历史数据失败:', error.message);
    return false;
  }
}

// 查询单个 API Key 的使用情况
async function fetchApiKeyData(keyConfig) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'app.factory.ai',
      path: '/api/organization/members/chat-usage',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${keyConfig.key}`,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      timeout: 10000
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            console.error(`❌ Key ${keyConfig.id} 查询失败: HTTP ${res.statusCode}`);
            resolve({
              ...keyConfig,
              error: `HTTP ${res.statusCode}`,
              valid: false
            });
            return;
          }

          const apiData = JSON.parse(data);
          if (!apiData.usage || !apiData.usage.standard) {
            resolve({
              ...keyConfig,
              error: 'Invalid API response',
              valid: false
            });
            return;
          }

          const usageInfo = apiData.usage;
          const standardUsage = usageInfo.standard;

          const formatDate = (timestamp) => {
            if (!timestamp && timestamp !== 0) return 'N/A';
            try {
              return new Date(timestamp).toISOString().split('T')[0];
            } catch (e) {
              return 'Invalid Date';
            }
          };

          resolve({
            ...keyConfig,
            startDate: formatDate(usageInfo.startDate),
            endDate: formatDate(usageInfo.endDate),
            orgTotalTokensUsed: standardUsage.orgTotalTokensUsed,
            totalAllowance: standardUsage.totalAllowance,
            usedRatio: standardUsage.usedRatio,
            remaining: standardUsage.totalAllowance - standardUsage.orgTotalTokensUsed,
            valid: true,
            maskedKey: `${keyConfig.key.substring(0, 8)}...${keyConfig.key.substring(keyConfig.key.length - 4)}`
          });
        } catch (error) {
          console.error(`❌ Key ${keyConfig.id} 处理失败:`, error.message);
          resolve({
            ...keyConfig,
            error: 'Parse error',
            valid: false
          });
        }
      });
    });

    req.on('error', (error) => {
      console.error(`❌ Key ${keyConfig.id} 请求失败:`, error.message);
      resolve({
        ...keyConfig,
        error: error.message,
        valid: false
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        ...keyConfig,
        error: 'Request timeout',
        valid: false
      });
    });

    req.end();
  });
}

// 聚合所有 API Keys 的数据
async function getAggregatedData() {
  const config = loadConfig();
  const enabledKeys = config.apiKeys.filter(k => k.enabled !== false);

  if (enabledKeys.length === 0) {
    return {
      update_time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      total_count: 0,
      totals: {
        total_orgTotalTokensUsed: 0,
        total_totalAllowance: 0,
        total_remaining: 0
      },
      data: [],
      groups: {}
    };
  }

  console.log(`\n🔍 正在查询 ${enabledKeys.length} 个 API Keys...`);

  const results = await Promise.all(enabledKeys.map(keyConfig => fetchApiKeyData(keyConfig)));

  const validResults = results.filter(r => r.valid);

  const totals = validResults.reduce((acc, res) => {
    acc.total_orgTotalTokensUsed += res.orgTotalTokensUsed || 0;
    acc.total_totalAllowance += res.totalAllowance || 0;
    return acc;
  }, {
    total_orgTotalTokensUsed: 0,
    total_totalAllowance: 0
  });

  totals.total_remaining = totals.total_totalAllowance - totals.total_orgTotalTokensUsed;

  // 按分组统计
  const groups = {};
  results.forEach(item => {
    const group = item.group || 'default';
    if (!groups[group]) {
      groups[group] = [];
    }
    groups[group].push(item);
  });

  // 保存到历史记录
  const historyData = loadHistory();
  const historyEntry = {
    timestamp: Date.now(),
    totals: totals,
    keys: validResults.map(r => ({
      id: r.id,
      used: r.orgTotalTokensUsed,
      allowance: r.totalAllowance,
      remaining: r.remaining
    }))
  };
  historyData.push(historyEntry);
  saveHistory(historyData);

  // 输出剩余额度信息
  const keysWithBalance = validResults.filter(r => r.remaining > 0);
  if (keysWithBalance.length > 0) {
    console.log("\n" + "=".repeat(80));
    console.log("📋 剩余额度大于0的 API Keys:");
    console.log("-".repeat(80));
    keysWithBalance.forEach(item => {
      console.log(`${item.id} (${item.alias || 'No Alias'}): 剩余 ${item.remaining.toLocaleString()} tokens`);
    });
    console.log("=".repeat(80) + "\n");
  }

  return {
    update_time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    total_count: enabledKeys.length,
    totals,
    data: results,
    groups
  };
}

// HTTP 路由处理
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS 支持
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // 首页 - 返回 HTML 界面
  if (url.pathname === "/" && req.method === 'GET') {
    try {
      const htmlPath = path.join(__dirname, 'index.html');
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (error) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Error loading page");
    }
    return;
  }

  // API: 获取聚合数据
  if (url.pathname === "/api/data" && req.method === 'GET') {
    try {
      const data = await getAggregatedData();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (error) {
      console.error('❌ API Error:', error.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // API: 获取配置
  if (url.pathname === "/api/config" && req.method === 'GET') {
    try {
      const config = loadConfig();
      // 不返回完整的 key,只返回掩码版本
      const safeConfig = {
        ...config,
        apiKeys: config.apiKeys.map(k => ({
          ...k,
          key: `${k.key.substring(0, 8)}...${k.key.substring(k.key.length - 4)}`
        }))
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(safeConfig));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // API: 更新配置
  if (url.pathname === "/api/config" && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const newConfig = JSON.parse(body);
        const success = saveConfig(newConfig);
        res.writeHead(success ? 200 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success, message: success ? 'Config saved' : 'Failed to save' }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // API: 添加新 Key
  if (url.pathname === "/api/keys" && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const newKey = JSON.parse(body);
        const config = loadConfig();

        // 验证必填字段
        if (!newKey.id || !newKey.key) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: 'Missing required fields: id, key' }));
          return;
        }

        // 检查 ID 是否已存在
        if (config.apiKeys.find(k => k.id === newKey.id)) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: 'Key ID already exists' }));
          return;
        }

        config.apiKeys.push({
          id: newKey.id,
          key: newKey.key,
          alias: newKey.alias || '',
          group: newKey.group || 'default',
          note: newKey.note || '',
          enabled: true
        });

        const success = saveConfig(config);
        res.writeHead(success ? 201 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success,
          message: success ? 'Key added successfully' : 'Failed to add key'
        }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // API: 更新 Key
  if (url.pathname.startsWith("/api/keys/") && req.method === 'PUT') {
    const keyId = decodeURIComponent(url.pathname.split('/api/keys/')[1]);
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const updatedKey = JSON.parse(body);
        const config = loadConfig();
        const keyIndex = config.apiKeys.findIndex(k => k.id === keyId);

        if (keyIndex === -1) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: 'Key not found' }));
          return;
        }

        // 保留原 key 值,除非明确提供新的
        config.apiKeys[keyIndex] = {
          ...config.apiKeys[keyIndex],
          ...updatedKey,
          id: keyId // ID 不允许修改
        };

        const success = saveConfig(config);
        res.writeHead(success ? 200 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success,
          message: success ? 'Key updated successfully' : 'Failed to update key'
        }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // API: 删除 Key
  if (url.pathname.startsWith("/api/keys/") && req.method === 'DELETE') {
    const keyId = decodeURIComponent(url.pathname.split('/api/keys/')[1]);
    const config = loadConfig();
    const originalLength = config.apiKeys.length;
    config.apiKeys = config.apiKeys.filter(k => k.id !== keyId);

    if (config.apiKeys.length === originalLength) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Key not found' }));
      return;
    }

    const success = saveConfig(config);
    res.writeHead(success ? 200 : 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success,
      message: success ? 'Key deleted successfully' : 'Failed to delete key'
    }));
    return;
  }

  // API: 获取历史数据
  if (url.pathname === "/api/history" && req.method === 'GET') {
    try {
      const history = loadHistory();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(history));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // API: 测试单个 Key 的有效性
  if (url.pathname === "/api/test-key" && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', async () => {
      try {
        const { key, id } = JSON.parse(body);
        const result = await fetchApiKeyData({ id: id || 'test', key });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
  console.log("\n" + "=".repeat(80));
  console.log("🚀 Factory.ai API 余额监控系统 v2.0 已启动!");
  console.log("-".repeat(80));
  console.log(`📊 访问地址: http://localhost:${PORT}`);
  console.log(`📁 配置文件: ${CONFIG_FILE}`);
  console.log(`📈 历史数据: ${HISTORY_FILE}`);
  console.log("=".repeat(80) + "\n");
});
