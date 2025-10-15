/**
 * 存储适配器 - 自动检测环境并使用合适的存储方式
 * - 本地环境：使用文件系统
 * - Vercel 环境：使用 Vercel KV
 */

const fs = require('fs');
const path = require('path');

// 检测是否在 Vercel 环境中运行
const IS_VERCEL = process.env.VERCEL || process.env.KV_REST_API_URL;

// 配置文件路径（本地环境）
const CONFIG_FILE = path.join(process.cwd(), 'config.json');
const HISTORY_DIR = path.join(process.cwd(), 'data');
const HISTORY_FILE = path.join(HISTORY_DIR, 'history.json');

// Vercel KV 客户端（简单实现）
class VercelKVClient {
  constructor() {
    this.apiUrl = process.env.KV_REST_API_URL;
    this.token = process.env.KV_REST_API_TOKEN;
  }

  async request(command, ...args) {
    if (!this.apiUrl || !this.token) {
      throw new Error('Vercel KV 未配置，请在 Vercel 项目设置中添加 KV 存储');
    }

    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([command, ...args])
    });

    if (!response.ok) {
      throw new Error(`KV 请求失败: ${response.statusText}`);
    }

    const data = await response.json();
    return data.result;
  }

  async get(key) {
    try {
      const result = await this.request('GET', key);
      return result ? JSON.parse(result) : null;
    } catch (error) {
      console.error(`获取 KV 数据失败 [${key}]:`, error.message);
      return null;
    }
  }

  async set(key, value, ttl = null) {
    try {
      const serialized = JSON.stringify(value);
      if (ttl) {
        await this.request('SETEX', key, ttl, serialized);
      } else {
        await this.request('SET', key, serialized);
      }
      return true;
    } catch (error) {
      console.error(`设置 KV 数据失败 [${key}]:`, error.message);
      return false;
    }
  }

  async delete(key) {
    try {
      await this.request('DEL', key);
      return true;
    } catch (error) {
      console.error(`删除 KV 数据失败 [${key}]:`, error.message);
      return false;
    }
  }
}

// 存储适配器
class StorageAdapter {
  constructor() {
    this.isVercel = IS_VERCEL;
    if (this.isVercel) {
      this.kv = new VercelKVClient();
      console.log('🌐 使用 Vercel KV 存储模式');
    } else {
      // 确保本地数据目录存在
      if (!fs.existsSync(HISTORY_DIR)) {
        fs.mkdirSync(HISTORY_DIR, { recursive: true });
      }
      console.log('💾 使用本地文件存储模式');
    }
  }

  // 加载配置
  async loadConfig() {
    try {
      if (this.isVercel) {
        // 从 Vercel KV 加载
        const config = await this.kv.get('config');
        if (config) return config;
        
        // 如果 KV 中没有，尝试从环境变量加载
        const apiKeysEnv = process.env.FACTORY_API_KEYS || process.env.API_KEYS;
        if (apiKeysEnv) {
          const keys = JSON.parse(apiKeysEnv);
          return {
            apiKeys: keys,
            settings: {
              autoRefreshInterval: 300000,
              alertThreshold: 0.8,
              historyRetentionDays: 30
            }
          };
        }
        
        return this.getDefaultConfig();
      } else {
        // 从本地文件加载
        if (!fs.existsSync(CONFIG_FILE)) {
          const defaultConfig = this.getDefaultConfig();
          fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
          return defaultConfig;
        }
        const data = fs.readFileSync(CONFIG_FILE, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error('❌ 加载配置失败:', error.message);
      return this.getDefaultConfig();
    }
  }

  // 保存配置
  async saveConfig(config) {
    try {
      if (this.isVercel) {
        // 保存到 Vercel KV
        return await this.kv.set('config', config);
      } else {
        // 保存到本地文件
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        console.log('✅ 配置已保存到文件');
        return true;
      }
    } catch (error) {
      console.error('❌ 保存配置失败:', error.message);
      return false;
    }
  }

  // 加载历史数据
  async loadHistory() {
    try {
      if (this.isVercel) {
        // 从 Vercel KV 加载
        const history = await this.kv.get('history');
        return history || [];
      } else {
        // 从本地文件加载
        if (!fs.existsSync(HISTORY_FILE)) {
          return [];
        }
        const data = fs.readFileSync(HISTORY_FILE, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error('❌ 加载历史数据失败:', error.message);
      return [];
    }
  }

  // 保存历史数据
  async saveHistory(historyData) {
    try {
      // 清理过期数据
      const config = await this.loadConfig();
      const retentionDays = config.settings.historyRetentionDays || 30;
      const cutoffTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
      const filteredData = historyData.filter(item => item.timestamp > cutoffTime);

      if (this.isVercel) {
        // 保存到 Vercel KV（设置 TTL 为 30 天）
        const ttl = retentionDays * 24 * 60 * 60; // 转换为秒
        return await this.kv.set('history', filteredData, ttl);
      } else {
        // 保存到本地文件
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(filteredData, null, 2));
        return true;
      }
    } catch (error) {
      console.error('❌ 保存历史数据失败:', error.message);
      return false;
    }
  }

  // 获取默认配置
  getDefaultConfig() {
    return {
      apiKeys: [],
      settings: {
        autoRefreshInterval: 300000,
        alertThreshold: 0.8,
        historyRetentionDays: 30
      }
    };
  }

  // 获取存储模式信息
  getStorageInfo() {
    return {
      mode: this.isVercel ? 'vercel-kv' : 'local-file',
      description: this.isVercel ? 'Vercel KV (云端持久化)' : '本地文件系统',
      persistent: true,
      features: {
        config: true,
        history: true,
        addKey: true,
        deleteKey: true,
        updateKey: true
      }
    };
  }
}

// 导出单例
module.exports = new StorageAdapter();
