/**
 * 代理池管理模块
 * 功能：管理爬虫代理池，支持代理轮换、健康检查、自动刷新
 * 作者：Seraph
 * 更新：2026-07-06
 */

const axios = require('axios');

const logger = require('./logger');
const { config } = require('./config');

/**
 * 代理池管理器类
 * 负责代理的获取、轮换、标记、刷新
 */
class ProxyManager {
  constructor() {
    this.proxies = [];
    this.currentIndex = 0;
    this.badProxies = new Set();
    this.isInitialized = false;
  }

  /**
   * 初始化代理池
   * 从代理 API 加载代理列表
   * @returns {Promise<void>}
   * @throws {Error} 当代理 API 请求失败时抛出异常
   */
  async initialize() {
    if (!config.proxy.enabled) {
      logger.info('代理池未启用，跳过初始化');
      this.isInitialized = true;
      return;
    }

    try {
      await this.loadProxies();
      this.isInitialized = true;
      logger.info('代理池初始化成功', {
        proxyCount: this.proxies.length,
      });

      // 设置定期刷新
      this.startAutoRefresh();
    } catch (error) {
      logger.error('代理池初始化失败', {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  /**
   * 从代理 API 加载代理列表
   * @returns {Promise<void>}
   * @throws {Error} 当 API 请求失败时抛出异常
   */
  async loadProxies() {
    const { apiUrl, apiKey } = config.proxy;

    if (!apiUrl || !apiKey) {
      throw new Error('代理 API 配置缺失');
    }

    try {
      logger.debug('开始加载代理列表', { apiUrl });

      const response = await axios.get(apiUrl, {
        params: { key: apiKey },
        timeout: 10000,
      });

      // 根据实际代理 API 的响应格式调整解析逻辑
      // 这里假设返回格式为: { data: { proxy_list: ['ip:port', ...] } }
      const proxyList = this.parseProxyResponse(response.data);

      if (!proxyList || proxyList.length === 0) {
        throw new Error('代理 API 返回空列表');
      }

      this.proxies = proxyList;
      this.badProxies.clear();

      logger.info('代理列表加载成功', {
        count: this.proxies.length,
      });
    } catch (error) {
      logger.error('加载代理列表失败', {
        error: error.message,
        apiUrl,
      });
      throw error;
    }
  }

  /**
   * 解析代理 API 响应
   * @param {Object} responseData - API 响应数据
   * @returns {Array<Object>} 代理对象数组
   */
  parseProxyResponse(responseData) {
    // TODO: 根据实际使用的代理服务 API 格式调整
    // 示例格式 1：快代理
    // { code: 0, data: { proxy_list: ['ip:port:user:pass', ...] } }

    // 示例格式 2：简单格式
    // { proxies: ['ip:port', ...] }

    try {
      let proxyList = [];

      // 尝试解析不同的响应格式
      if (responseData.data && Array.isArray(responseData.data.proxy_list)) {
        proxyList = responseData.data.proxy_list;
      } else if (Array.isArray(responseData.proxies)) {
        proxyList = responseData.proxies;
      } else if (Array.isArray(responseData)) {
        proxyList = responseData;
      }

      // 转换为标准格式
      return proxyList.map((proxyStr) => this.parseProxyString(proxyStr));
    } catch (error) {
      logger.error('解析代理响应失败', {
        error: error.message,
        responseData,
      });
      return [];
    }
  }

  /**
   * 解析代理字符串为对象
   * @param {string} proxyStr - 代理字符串（格式：ip:port 或 ip:port:user:pass）
   * @returns {Object} 代理对象
   */
  parseProxyString(proxyStr) {
    const parts = proxyStr.split(':');

    if (parts.length >= 2) {
      const proxy = {
        host: parts[0],
        port: parseInt(parts[1], 10),
      };

      // 如果有认证信息
      if (parts.length >= 4) {
        proxy.auth = {
          username: parts[2],
          password: parts[3],
        };
      }

      return proxy;
    }

    throw new Error(`无效的代理格式: ${proxyStr}`);
  }

  /**
   * 获取下一个可用代理
   * 使用轮询策略，跳过已标记为坏的代理
   * @returns {Object|null} 代理对象，如果无可用代理返回 null
   */
  getNextProxy() {
    if (!config.proxy.enabled || this.proxies.length === 0) {
      return null;
    }

    let attempts = 0;

    // 遍历代理列表，寻找可用代理
    while (attempts < this.proxies.length) {
      const proxy = this.proxies[this.currentIndex];
      this.currentIndex = (this.currentIndex + 1) % this.proxies.length;

      const proxyKey = `${proxy.host}:${proxy.port}`;

      if (!this.badProxies.has(proxyKey)) {
        logger.debug('获取代理', { proxy: proxyKey });
        return proxy;
      }

      attempts++;
    }

    logger.warn('无可用代理', {
      totalProxies: this.proxies.length,
      badProxies: this.badProxies.size,
    });

    return null;
  }

  /**
   * 标记代理为不可用
   * 设置超时后自动恢复
   * @param {Object} proxy - 代理对象
   * @returns {void}
   */
  markProxyAsBad(proxy) {
    if (!proxy) {
      return;
    }

    const proxyKey = `${proxy.host}:${proxy.port}`;
    this.badProxies.add(proxyKey);

    logger.warn('代理被标记为不可用', {
      proxy: proxyKey,
      badProxyCount: this.badProxies.size,
    });

    // 设置超时后自动恢复
    setTimeout(() => {
      this.badProxies.delete(proxyKey);
      logger.info('代理已恢复可用', { proxy: proxyKey });
    }, config.proxy.badProxyTimeout);
  }

  /**
   * 获取代理池状态
   * @returns {Object} 代理池状态信息
   */
  getStatus() {
    return {
      total: this.proxies.length,
      available: this.proxies.length - this.badProxies.size,
      bad: this.badProxies.size,
      currentIndex: this.currentIndex,
      enabled: config.proxy.enabled,
      isInitialized: this.isInitialized,
    };
  }

  /**
   * 启动自动刷新定时任务
   * @returns {void}
   */
  startAutoRefresh() {
    const { refreshInterval } = config.proxy;

    setInterval(async () => {
      try {
        logger.info('开始定时刷新代理池');
        await this.loadProxies();
      } catch (error) {
        logger.error('定时刷新代理池失败', {
          error: error.message,
        });
      }
    }, refreshInterval);

    logger.info('代理池自动刷新已启动', {
      intervalMinutes: refreshInterval / 60000,
    });
  }

  /**
   * 手动刷新代理池
   * @returns {Promise<void>}
   */
  async refresh() {
    logger.info('手动刷新代理池');
    await this.loadProxies();
  }
}

// 创建并导出全局代理管理器实例
const proxyManager = new ProxyManager();

module.exports = proxyManager;
