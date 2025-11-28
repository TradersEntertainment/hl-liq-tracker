const express = require('express');
const cors = require('cors');
const axios = require('axios');
const WebSocket = require('ws');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
  PORT: process.env.PORT || 3000,
  HYPERLIQUID_API: 'https://api.hyperliquid.xyz/info',
  HYPERLIQUID_WS: 'wss://api.hyperliquid.xyz/ws',
  MIN_POSITION_USD: parseInt(process.env.MIN_POSITION_USD) || 2000000,
  MIN_TRADE_USD: parseInt(process.env.MIN_TRADE_USD) || 100000,
  DANGER_THRESHOLD_5: 0.05,
  DANGER_THRESHOLD_10: 0.10,
  REFRESH_INTERVAL: parseInt(process.env.REFRESH_INTERVAL) || 60000,
  MAX_ADDRESSES_TO_SCAN: 500,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHANNEL_ID: process.env.TELEGRAM_CHANNEL_ID,
  TWITTER_API_KEY: process.env.TWITTER_API_KEY,
  TWITTER_API_SECRET: process.env.TWITTER_API_SECRET,
  TWITTER_ACCESS_TOKEN: process.env.TWITTER_ACCESS_TOKEN,
  TWITTER_ACCESS_SECRET: process.env.TWITTER_ACCESS_SECRET,
  ALERT_COOLDOWN: 5 * 60 * 1000,
  DATABASE_URL: process.env.DATABASE_URL,
};

// ============================================
// DATABASE - PostgreSQL (Optional)
// ============================================
let pool = null;

async function initDatabase() {
  if (!CONFIG.DATABASE_URL) {
    console.log('⚠️ No DATABASE_URL - running without persistence (data resets on restart)');
    return;
  }
  
  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: CONFIG.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    
    await pool.query('SELECT NOW()');
    console.log('✅ PostgreSQL connected');
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS whales (
        address TEXT PRIMARY KEY,
        first_seen BIGINT,
        last_seen BIGINT,
        total_volume NUMERIC DEFAULT 0,
        trade_count INTEGER DEFAULT 0
      )
    `);
    
    console.log('✅ Database tables ready');
    await loadWhalesFromDb();
  } catch (err) {
    console.error('⚠️ Database error (continuing without persistence):', err.message);
    pool = null;
  }
}

async function loadWhalesFromDb() {
  if (!pool) return;
  try {
    const result = await pool.query('SELECT address, total_volume FROM whales ORDER BY total_volume DESC LIMIT 500');
    for (const row of result.rows) {
      knownWhaleAddresses.add(row.address.toLowerCase());
      addressTradeVolume.set(row.address.toLowerCase(), parseFloat(row.total_volume));
    }
    console.log(`✅ Loaded ${result.rows.length} whales from database`);
  } catch (err) {
    console.error('Load whales error:', err.message);
  }
}

async function saveWhaleToDb(address, volume) {
  if (!pool) return;
  try {
    await pool.query(`
      INSERT INTO whales (address, first_seen, last_seen, total_volume, trade_count)
      VALUES ($1, $2, $2, $3, 1)
      ON CONFLICT (address) DO UPDATE SET
        last_seen = $2,
        total_volume = whales.total_volume + $3,
        trade_count = whales.trade_count + 1
    `, [address.toLowerCase(), Date.now(), volume]);
  } catch (err) {}
}

// ============================================
// HELPERS
// ============================================
const TOP_COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'DOT', 'MATIC', 'LINK', 'NEAR'];
function isShitcoin(coin) { return !TOP_COINS.includes(coin.toUpperCase()); }

function formatPriceCompact(price) {
  if (!price) return '?';
  if (price >= 10000) return price.toFixed(0);
  if (price >= 100) return price.toFixed(1);
  if (price >= 1) return price.toFixed(2);
  if (price >= 0.01) return price.toFixed(4);
  return price.toFixed(6);
}

function formatWalletAge(days) {
  if (days === null || days === undefined) return 'Unknown';
  if (days === 0) return 'Brand New (<1 day)';
  if (days < 7) return days + ' days old';
  if (days < 30) return Math.floor(days / 7) + ' weeks old';
  if (days < 365) return Math.floor(days / 30) + ' months old';
  return (days / 365).toFixed(1) + ' years old';
}

function getHypurrscanUrl(address) {
  return 'https://hypurrscan.io/address/' + address;
}

function getHyperliquidUrl(address) {
  return 'https://app.hyperliquid.xyz/explorer/address/' + address;
}

// ============================================
// WALLET AGE DETECTION
// ============================================
const walletAgeDays = new Map();
const walletAgeCache = new Map();
const positionOpenTimeCache = new Map(); // Cache for position open times

async function getWalletAge(address) {
  const addrLower = address.toLowerCase();

  const cached = walletAgeCache.get(addrLower);
  if (cached && (Date.now() - cached.timestamp) < 3600000) return cached.ageDays;
  if (walletAgeDays.has(addrLower)) return walletAgeDays.get(addrLower);

  try {
    const response = await axios.post(CONFIG.HYPERLIQUID_API, {
      type: 'userFillsByTime',
      user: address,
      startTime: 0,
      endTime: Date.now()
    });

    if (response.data && Array.isArray(response.data) && response.data.length > 0) {
      let earliestTime = Date.now();
      for (const fill of response.data) {
        if (fill.time && fill.time < earliestTime) earliestTime = fill.time;
      }

      const ageDays = Math.floor((Date.now() - earliestTime) / (1000 * 60 * 60 * 24));
      walletAgeDays.set(addrLower, ageDays);
      walletAgeCache.set(addrLower, { ageDays, timestamp: Date.now() });
      return ageDays;
    }

    walletAgeDays.set(addrLower, 0);
    walletAgeCache.set(addrLower, { ageDays: 0, timestamp: Date.now() });
    return 0;
  } catch (err) { return null; }
}

async function getPositionOpenTime(address, coin, entryPrice) {
  const cacheKey = address.toLowerCase() + '-' + coin;

  // Check cache first
  const cached = positionOpenTimeCache.get(cacheKey);
  if (cached) return cached;

  try {
    // Get recent fills for this user
    const response = await axios.post(CONFIG.HYPERLIQUID_API, {
      type: 'userFillsByTime',
      user: address,
      startTime: Date.now() - (30 * 24 * 60 * 60 * 1000), // Last 30 days
      endTime: Date.now()
    });

    if (response.data && Array.isArray(response.data)) {
      // Find fills for this coin near entry price (within 5%)
      const relevantFills = response.data
        .filter(fill => fill.coin === coin)
        .filter(fill => {
          const fillPx = parseFloat(fill.px);
          const priceDiff = Math.abs(fillPx - entryPrice) / entryPrice;
          return priceDiff < 0.05; // Within 5% of entry price
        })
        .sort((a, b) => a.time - b.time); // Oldest first

      if (relevantFills.length > 0) {
        const openTime = relevantFills[0].time;
        positionOpenTimeCache.set(cacheKey, openTime);
        return openTime;
      }
    }
  } catch (err) {
    console.error('Position open time fetch error:', err.message);
  }

  // Fallback: use current time
  const fallbackTime = Date.now();
  positionOpenTimeCache.set(cacheKey, fallbackTime);
  return fallbackTime;
}

// ============================================
// ALERTS
// ============================================
const sentAlerts = new Map();
const sentNotifications = []; // Track sent notifications history
const crypto = require('crypto');
let oauthLib = null;
try { oauthLib = require('oauth-1.0a'); } catch (e) { console.log('⚠️ oauth-1.0a not installed - Twitter disabled'); }

async function sendTelegramAlert(position) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHANNEL_ID) return;

  const alertKey = position.user + '-' + position.coin;
  const lastAlert = sentAlerts.get(alertKey);
  if (lastAlert && (Date.now() - lastAlert) < CONFIG.ALERT_COOLDOWN) return;

  const isLong = position.direction === 'LONG';
  const isCritical = position.dangerLevel === 'CRITICAL';
  const ageDays = position.walletAgeDays;
  const isBrandNew = ageDays !== null && ageDays === 0;
  const isNewWallet = ageDays !== null && ageDays < 7;
  const isShitcoinBet = isShitcoin(position.coin) && position.positionUSD >= 2000000;
  const isPotentialVaultAttack = isShitcoin(position.coin) && position.positionUSD >= 10000000;

  // Build message parts
  let lines = [];

  // Header based on situation
  if (isPotentialVaultAttack) {
    lines.push('🚨🚨🚨 *HYPERVAULT ATTACK ALERT* 🚨🚨🚨');
    lines.push('');
  } else if (isShitcoinBet) {
    lines.push('🎰 *DEGEN WHALE SPOTTED* 🎰');
    lines.push('');
  } else if (isBrandNew) {
    lines.push('👶🔥 *FRESH WALLET ALERT* 🔥👶');
    lines.push('⚠️ _Possible insider or exploit activity_');
    lines.push('');
  }

  // Main position info with visual box
  const dirIcon = isLong ? '🟢' : '🔴';
  const dangerIcon = isCritical ? '💀' : '⚠️';

  lines.push(dangerIcon + ' *' + position.coin + ' ' + position.direction + '* ' + dangerIcon);
  lines.push('━━━━━━━━━━━━━━━━');

  // Whale history status
  if (position.allTimePnl !== null) {
    const pnlValue = position.allTimePnl;
    const pnlAbs = Math.abs(pnlValue);
    let pnlStr = pnlAbs >= 1000000 ? '$' + (pnlAbs / 1000000).toFixed(2) + 'M' : '$' + (pnlAbs / 1000).toFixed(0) + 'K';

    if (position.isProfitableWhale) {
      lines.push('👑 *HISTORICALLY WINNER WHALE*');
      lines.push('📈 All-Time: *+' + pnlStr + '*');
    } else {
      lines.push('🎲 *HISTORICALLY LOSER WHALE*');
      lines.push('📉 All-Time: *-' + pnlStr + '*');
    }
    lines.push('');
  }

  // Position details
  lines.push('💎 Size: *$' + (position.positionUSD / 1000000).toFixed(2) + 'M*');
  lines.push('⚡ Leverage: *' + position.leverage + 'x*');
  lines.push('🎯 Distance to Liq: *' + position.distancePercent + '%*');
  lines.push('');

  // Price info
  lines.push('📊 Entry: `$' + formatPriceCompact(position.entryPrice) + '`');
  lines.push('💀 Liquidation: `$' + formatPriceCompact(position.liqPrice) + '`');
  lines.push('');

  // Wallet age
  if (isBrandNew) {
    lines.push('🆕 Wallet Age: *BRAND NEW* (<1 day)');
  } else if (isNewWallet) {
    lines.push('👶 Wallet Age: *' + ageDays + ' days*');
  } else if (ageDays !== null) {
    lines.push('🕐 Wallet Age: ' + formatWalletAge(ageDays));
  }

  lines.push('');
  lines.push('🔗 [View Position on Hypurrscan](' + position.hypurrscanUrl + ')');
  lines.push('');
  lines.push('#Hyperliquid #' + position.coin + ' #WhaleAlert');

  const message = lines.join('\n');

  try {
    await axios.post('https://api.telegram.org/bot' + CONFIG.TELEGRAM_BOT_TOKEN + '/sendMessage', {
      chat_id: CONFIG.TELEGRAM_CHANNEL_ID,
      text: message,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
    sentAlerts.set(alertKey, Date.now());
    sentNotifications.unshift({
      id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
      platform: 'Telegram',
      coin: position.coin,
      direction: position.direction,
      size: position.positionUSD,
      distance: position.distancePercent,
      address: position.userShort,
      timestamp: Date.now()
    });
    if (sentNotifications.length > 50) sentNotifications.pop();
    console.log('📨 Telegram: ' + position.coin + ' | Age: ' + formatWalletAge(ageDays));
  } catch (error) {
    console.error('Telegram error:', error.response?.data?.description || error.message);
  }
}

async function sendTwitterAlert(position) {
  if (!CONFIG.TWITTER_API_KEY || !CONFIG.TWITTER_ACCESS_TOKEN || !oauthLib) return;

  const alertKey = 'twitter-' + position.user + '-' + position.coin;
  const lastAlert = sentAlerts.get(alertKey);
  if (lastAlert && (Date.now() - lastAlert) < CONFIG.ALERT_COOLDOWN) return;

  const isLong = position.direction === 'LONG';
  const isCritical = position.dangerLevel === 'CRITICAL';
  const ageDays = position.walletAgeDays;
  const isBrandNew = ageDays !== null && ageDays === 0;
  const isShitcoinBet = isShitcoin(position.coin) && position.positionUSD >= 2000000;
  const isPotentialVaultAttack = isShitcoin(position.coin) && position.positionUSD >= 10000000;

  let lines = [];

  // Header
  if (isPotentialVaultAttack) {
    lines.push('🚨 VAULT ATTACK ALERT 🚨');
  } else if (isShitcoinBet) {
    lines.push('🎰 DEGEN WHALE 🎰');
  } else if (isBrandNew) {
    lines.push('👶🔥 FRESH WALLET');
  }

  // Main info
  const dangerIcon = isCritical ? '💀' : '⚠️';
  const dirIcon = isLong ? '🟢' : '🔴';
  lines.push(dangerIcon + ' ' + position.coin + ' ' + position.direction);
  lines.push('');

  // Whale status
  if (position.allTimePnl !== null) {
    const pnlAbs = Math.abs(position.allTimePnl);
    let pnlStr = pnlAbs >= 1000000 ? '$' + (pnlAbs / 1000000).toFixed(1) + 'M' : '$' + (pnlAbs / 1000).toFixed(0) + 'K';
    if (position.isProfitableWhale) {
      lines.push('👑 Winner Whale (+' + pnlStr + ')');
    } else {
      lines.push('🎲 Loser Whale (-' + pnlStr + ')');
    }
  }

  // Position details
  lines.push(dirIcon + ' $' + (position.positionUSD / 1000000).toFixed(1) + 'M @ ' + position.leverage + 'x');
  lines.push('📊 Entry: $' + formatPriceCompact(position.entryPrice));
  lines.push('💀 Liq: $' + formatPriceCompact(position.liqPrice));
  lines.push('🎯 ' + position.distancePercent + '% away');
  lines.push('');
  lines.push(position.hypurrscanUrl);
  lines.push('');
  lines.push('#Hyperliquid #' + position.coin);

  const tweet = lines.join('\n').slice(0, 280);

  try {
    const oauth = oauthLib({
      consumer: { key: CONFIG.TWITTER_API_KEY, secret: CONFIG.TWITTER_API_SECRET },
      signature_method: 'HMAC-SHA1',
      hash_function(baseString, key) { return crypto.createHmac('sha1', key).update(baseString).digest('base64'); }
    });
    const token = { key: CONFIG.TWITTER_ACCESS_TOKEN, secret: CONFIG.TWITTER_ACCESS_SECRET };
    const url = 'https://api.twitter.com/2/tweets';
    const authHeader = oauth.toHeader(oauth.authorize({ url, method: 'POST' }, token));

    await axios.post(url, { text: tweet }, { headers: { 'Authorization': authHeader['Authorization'], 'Content-Type': 'application/json' } });
    sentAlerts.set(alertKey, Date.now());
    sentNotifications.unshift({
      id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
      platform: 'Twitter',
      coin: position.coin,
      direction: position.direction,
      size: position.positionUSD,
      distance: position.distancePercent,
      address: position.userShort,
      timestamp: Date.now()
    });
    if (sentNotifications.length > 50) sentNotifications.pop();
    console.log('🐦 Twitter: ' + position.coin);
  } catch (error) {
    console.error('Twitter error:', error.response?.status, error.response?.data?.detail || error.message);
  }
}

async function sendAlerts(position) {
  // Bildirim koşulları: Likidasyona %10'dan yakın VE pozisyon ≥ $2M
  if (position.distanceToLiq >= CONFIG.DANGER_THRESHOLD_10) return;
  if (position.positionUSD < 2000000) return;
  await Promise.all([sendTelegramAlert(position), sendTwitterAlert(position)]);
}

// ============================================
// HYPERLIQUID API
// ============================================
async function hlPost(body) {
  try { return (await axios.post(CONFIG.HYPERLIQUID_API, body)).data; }
  catch (error) { return null; }
}

async function getAssetMeta() {
  const data = await hlPost({ type: 'meta' });
  return data?.universe?.map(a => a.name) || [];
}

async function getAllMids() { return (await hlPost({ type: 'allMids' })) || {}; }
async function getUserState(address) { return await hlPost({ type: 'clearinghouseState', user: address }); }

const allTimePnlCache = new Map();
async function getCachedAllTimePnl(address) {
  const addrLower = address.toLowerCase();
  const cached = allTimePnlCache.get(addrLower);
  if (cached && (Date.now() - cached.timestamp) < 300000) return cached.pnl;
  
  try {
    const response = await axios.post(CONFIG.HYPERLIQUID_API, { type: 'portfolio', user: address });
    if (response.data && Array.isArray(response.data)) {
      for (const [period, data] of response.data) {
        if ((period === 'allTime' || period === 'perpAllTime') && data.pnlHistory?.length > 0) {
          const pnl = parseFloat(data.pnlHistory[data.pnlHistory.length - 1][1] || 0);
          allTimePnlCache.set(addrLower, { pnl, timestamp: Date.now() });
          return pnl;
        }
      }
    }
  } catch (err) {}
  return null;
}

// ============================================
// POSITION PROCESSING
// ============================================
let allMids = {};
let assetMeta = [];
let trackedPositions = [];
let knownWhaleAddresses = new Set();
let addressLastSeen = new Map();
let addressTradeVolume = new Map();

function processPosition(userAddress, position, currentPrice, accountData = null) {
  const coin = position.coin;
  const szi = parseFloat(position.szi);
  const leverage = position.leverage?.value || 1;
  const marginUsed = parseFloat(position.marginUsed);
  const unrealizedPnl = parseFloat(position.unrealizedPnl);
  const liqPx = parseFloat(position.liquidationPx);
  const entryPx = parseFloat(position.entryPx);
  const markPrice = currentPrice || allMids[coin];
  
  if (!markPrice || !liqPx) return null;
  
  const positionUSD = Math.abs(szi) * markPrice;
  if (positionUSD < CONFIG.MIN_POSITION_USD) return null;
  
  const isLong = szi > 0;
  const distanceToLiq = isLong ? (markPrice - liqPx) / markPrice : (liqPx - markPrice) / markPrice;
  
  if (distanceToLiq > CONFIG.DANGER_THRESHOLD_10 || distanceToLiq < 0) return null;
  
  const dangerLevel = distanceToLiq <= CONFIG.DANGER_THRESHOLD_5 ? 'CRITICAL' : 'WARNING';
  
  let walletBalance = null, otherPositions = [], totalUnrealizedPnl = 0;
  if (accountData) {
    walletBalance = parseFloat(accountData.marginSummary?.accountValue || 0);
    if (accountData.assetPositions) {
      accountData.assetPositions.forEach(ap => {
        const p = ap.position;
        const pSzi = parseFloat(p.szi);
        if (pSzi !== 0) {
          const pPnl = parseFloat(p.unrealizedPnl) || 0;
          totalUnrealizedPnl += pPnl;
          if (p.coin !== coin) {
            otherPositions.push({
              coin: p.coin, direction: pSzi > 0 ? 'LONG' : 'SHORT',
              positionUSD: Math.abs(pSzi) * (allMids[p.coin] || 0),
              unrealizedPnl: pPnl, leverage: p.leverage?.value || 1
            });
          }
        }
      });
    }
  }
  
  return {
    user: userAddress, userShort: userAddress.slice(0, 6) + '...' + userAddress.slice(-4),
    coin, direction: isLong ? 'LONG' : 'SHORT', positionSize: szi, positionUSD,
    entryPrice: entryPx, markPrice, liqPrice: liqPx, distanceToLiq,
    distancePercent: (distanceToLiq * 100).toFixed(2), leverage, marginUsed,
    unrealizedPnl, dangerLevel, timestamp: Date.now(), walletBalance, otherPositions,
    totalPositionCount: otherPositions.length + 1, totalUnrealizedPnl,
    allTimePnl: null, isProfitableWhale: false, whaleType: 'UNKNOWN', walletAgeDays: null,
    hypurrscanUrl: getHypurrscanUrl(userAddress),
    hyperliquidUrl: getHyperliquidUrl(userAddress)
  };
}

// ============================================
// WEBSOCKET - TRADE MONITORING
// ============================================
let ws = null;
let wsReconnectAttempts = 0;

function connectWebSocket() {
  try {
    ws = new WebSocket(CONFIG.HYPERLIQUID_WS);
    
    ws.on('open', () => {
      console.log('✅ WebSocket connected');
      wsReconnectAttempts = 0;
      // Subscribe to ALL trades (coin: null means all coins)
      ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades' } }));
    });
    
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.channel === 'subscriptionResponse') {
          console.log('✅ Subscribed to trades stream');
        }
        if (msg.channel === 'trades' && msg.data) {
          processTradesForDiscovery(msg.data);
          processLiquidations(msg.data);
        }
      } catch (e) {}
    });
    
    ws.on('close', () => {
      console.log('⚠️ WebSocket closed, reconnecting in 5s...');
      wsReconnectAttempts++;
      setTimeout(connectWebSocket, Math.min(5000 * wsReconnectAttempts, 30000));
    });
    
    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
    });
  } catch (error) {
    console.error('WebSocket connection error:', error.message);
    setTimeout(connectWebSocket, 5000);
  }
}

function processTradesForDiscovery(trades) {
  if (!trades || !Array.isArray(trades)) return;
  
  for (const trade of trades) {
    const sz = parseFloat(trade.sz || 0);
    const px = parseFloat(trade.px || 0);
    if (!sz || !px) continue;
    
    const tradeValue = Math.abs(sz) * px;
    if (tradeValue < CONFIG.MIN_TRADE_USD) continue;
    
    const users = trade.users || [];
    for (const user of users) {
      if (!user || user.length < 10) continue;
      
      const addrLower = user.toLowerCase();
      const isNewWhale = !knownWhaleAddresses.has(addrLower);
      
      knownWhaleAddresses.add(addrLower);
      addressLastSeen.set(addrLower, Date.now());
      addressTradeVolume.set(addrLower, (addressTradeVolume.get(addrLower) || 0) + tradeValue);
      
      saveWhaleToDb(addrLower, tradeValue);
      
      if (tradeValue >= 500000) {
        console.log('🐋 ' + (isNewWhale ? 'NEW ' : '') + 'WHALE: ' + addrLower.slice(0,10) + '... | ' + trade.coin + ' | $' + (tradeValue/1000000).toFixed(2) + 'M');
        checkAddressImmediately(addrLower, trade.coin, tradeValue);
      }
    }
  }
}

async function checkAddressImmediately(address, tradeCoin, tradeValue) {
  try {
    const state = await getUserState(address);
    if (state && state.assetPositions && state.assetPositions.length > 0) {
      const [allTimePnl, walletAgeDays] = await Promise.all([getCachedAllTimePnl(address), getWalletAge(address)]);
      for (const assetPos of state.assetPositions) {
        const pos = assetPos.position;
        const processed = processPosition(address, pos, allMids[pos.coin], state);
        if (processed) {
          processed.allTimePnl = allTimePnl;
          processed.walletAgeDays = walletAgeDays;
          // Get position open time
          const openTime = await getPositionOpenTime(address, pos.coin, processed.entryPrice);
          processed.timestamp = openTime;

          if (allTimePnl !== null) {
            processed.isProfitableWhale = allTimePnl > 0;
            processed.whaleType = allTimePnl > 0 ? 'PROFITABLE' : 'LOSING';
          }
          const existingIdx = trackedPositions.findIndex(p => p.user === address && p.coin === pos.coin);
          if (existingIdx >= 0) trackedPositions[existingIdx] = processed;
          else trackedPositions.unshift(processed);
          console.log('🚨 DETECT: ' + processed.userShort + ' | ' + processed.coin + ' ' + processed.direction + ' | Age: ' + formatWalletAge(walletAgeDays));
          if (existingIdx < 0) sendAlerts(processed);
        }
      }
      trackedPositions.sort((a, b) => a.distanceToLiq - b.distanceToLiq);
    }
  } catch (err) {}
}

// ============================================
// LIQUIDATIONS
// ============================================
let recentLiquidations = [];
let recentWhaleLiquidations = [];
const MAX_LIQUIDATIONS = 200;

function processLiquidations(trades) {
  if (!trades || !Array.isArray(trades)) return;
  
  for (const trade of trades) {
    const sz = parseFloat(trade.sz || 0);
    const px = parseFloat(trade.px || 0);
    if (!sz || !px) continue;
    
    const tradeValue = Math.abs(sz) * px;
    
    // crossed=true means taker order (market order) - liquidations are always market orders
    const isCrossed = trade.crossed === true;
    
    if (isCrossed && tradeValue >= 50000) {
      const liq = {
        id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
        coin: trade.coin,
        side: trade.side === 'B' ? 'SHORT' : 'LONG',
        price: px,
        size: Math.abs(sz),
        value: tradeValue,
        timestamp: trade.time || Date.now(),
        hash: trade.hash || null
      };
      
      const isDuplicate = recentLiquidations.some(l => 
        l.coin === liq.coin && 
        Math.abs(l.value - liq.value) < 1000 && 
        Math.abs(l.timestamp - liq.timestamp) < 3000
      );
      
      if (!isDuplicate) {
        recentLiquidations.unshift(liq);
        if (recentLiquidations.length > MAX_LIQUIDATIONS) {
          recentLiquidations = recentLiquidations.slice(0, MAX_LIQUIDATIONS);
        }
        
        if (tradeValue >= 500000) {
          recentWhaleLiquidations.unshift(liq);
          if (recentWhaleLiquidations.length > 50) {
            recentWhaleLiquidations = recentWhaleLiquidations.slice(0, 50);
          }
          console.log('🐋💀 WHALE LIQ: ' + liq.coin + ' ' + liq.side + ' | $' + (tradeValue/1000000).toFixed(2) + 'M');
        } else if (tradeValue >= 100000) {
          console.log('💀 LIQ: ' + liq.coin + ' ' + liq.side + ' | $' + (tradeValue/1000).toFixed(0) + 'k');
        }
      }
    }
  }
}

// ============================================
// SCANNING
// ============================================
async function scanPositions(addresses) {
  const results = [];
  for (let i = 0; i < addresses.length; i += 10) {
    const batch = addresses.slice(i, i + 10);
    const batchResults = await Promise.all(batch.map(async (address) => {
      try {
        const state = await getUserState(address);
        if (state && state.assetPositions) {
          const positions = [];
          const [allTimePnl, walletAgeDays] = await Promise.all([getCachedAllTimePnl(address), getWalletAge(address)]);
          for (const assetPos of state.assetPositions) {
            const processed = processPosition(address, assetPos.position, allMids[assetPos.position.coin], state);
            if (processed) {
              processed.allTimePnl = allTimePnl;
              processed.walletAgeDays = walletAgeDays;
              // Get position open time
              const openTime = await getPositionOpenTime(address, assetPos.position.coin, processed.entryPrice);
              processed.timestamp = openTime;

              if (allTimePnl !== null) {
                processed.isProfitableWhale = allTimePnl > 0;
                processed.whaleType = allTimePnl > 0 ? 'PROFITABLE' : 'LOSING';
              }
              positions.push(processed);
            }
          }
          return positions;
        }
      } catch (err) {}
      return [];
    }));
    batchResults.forEach(posArray => results.push(...posArray));
    if (i + 10 < addresses.length) await new Promise(r => setTimeout(r, 500));
  }
  return results.sort((a, b) => a.distanceToLiq - b.distanceToLiq);
}

async function refreshPositions() {
  if (knownWhaleAddresses.size === 0) { 
    console.log('⚠️ No whales discovered yet. Waiting for trades...'); 
    return; 
  }
  console.log('🔍 Scanning ' + knownWhaleAddresses.size + ' addresses...');
  allMids = await getAllMids();
  trackedPositions = await scanPositions([...knownWhaleAddresses].slice(0, CONFIG.MAX_ADDRESSES_TO_SCAN));
  console.log('✅ Found ' + trackedPositions.length + ' at-risk (' + trackedPositions.filter(p => p.dangerLevel === 'CRITICAL').length + ' critical)');
}

async function initialize() {
  console.log('🚀 Starting HL Liquidation Hunter...');
  await initDatabase();
  assetMeta = await getAssetMeta();
  console.log('✅ Loaded ' + assetMeta.length + ' assets');
  allMids = await getAllMids();
  
  // Fetch top traders from leaderboard
  await fetchLeaderboardTraders();
  
  connectWebSocket();
  console.log('⏳ Waiting 5s for whale discovery...');
  await new Promise(r => setTimeout(r, 5000));
  await refreshPositions();
  setInterval(refreshPositions, CONFIG.REFRESH_INTERVAL);
  
  // Refresh leaderboard every 10 minutes
  setInterval(fetchLeaderboardTraders, 10 * 60 * 1000);
  
  // Background liquidatable scan every 3 minutes
  backgroundLiquidatableScan();
  setInterval(backgroundLiquidatableScan, 3 * 60 * 1000);
}

// Background scan for liquidatable positions
async function backgroundLiquidatableScan() {
  if (isScanning) {
    console.log('⏳ Scan already in progress, skipping...');
    return;
  }
  
  isScanning = true;
  try {
    console.log(`🔍 Background scan: ${knownWhaleAddresses.size} addresses...`);
    const results = { longs: [], shorts: [] };
    const addresses = [...knownWhaleAddresses].slice(0, 1000); // Scan up to 1000
    const currentMids = await getAllMids();
    
    for (let i = 0; i < addresses.length; i += 20) {
      const batch = addresses.slice(i, i + 20);
      
      await Promise.all(batch.map(async (addr) => {
        try {
          const state = await getUserState(addr);
          if (!state || !state.assetPositions) return;
          
          for (const ap of state.assetPositions) {
            const pos = ap.position;
            const szi = parseFloat(pos.szi);
            if (szi === 0) continue;
            
            const coin = pos.coin;
            const markPx = parseFloat(currentMids[coin] || 0);
            const liqPx = parseFloat(pos.liquidationPx);
            const entryPx = parseFloat(pos.entryPx);
            
            if (!markPx || !liqPx) continue;
            
            const positionUSD = Math.abs(szi) * markPx;
            if (positionUSD < 50000) continue;
            
            const isLong = szi > 0;
            const distanceToLiq = isLong 
              ? (markPx - liqPx) / markPx 
              : (liqPx - markPx) / markPx;
            
            if (distanceToLiq > 0.15 || distanceToLiq < 0) continue;
            
            const dangerLevel = distanceToLiq <= 0.05 ? 'CRITICAL' : distanceToLiq <= 0.10 ? 'WARNING' : 'WATCH';
            
            const posData = {
              user: addr,
              userShort: addr.slice(0, 6) + '...' + addr.slice(-4),
              coin,
              direction: isLong ? 'LONG' : 'SHORT',
              positionUSD,
              entryPrice: entryPx,
              markPrice: markPx,
              liqPrice: liqPx,
              distancePercent: (distanceToLiq * 100).toFixed(2),
              leverage: pos.leverage?.value || 1,
              unrealizedPnl: parseFloat(pos.unrealizedPnl) || 0,
              dangerLevel,
              hypurrscanUrl: getHypurrscanUrl(addr),
              timestamp: Date.now()
            };
            
            if (isLong) results.longs.push(posData);
            else results.shorts.push(posData);
          }
        } catch (e) {}
      }));
      
      if (i + 20 < addresses.length) await new Promise(r => setTimeout(r, 100));
    }
    
    results.longs.sort((a, b) => parseFloat(a.distancePercent) - parseFloat(b.distancePercent));
    results.shorts.sort((a, b) => parseFloat(a.distancePercent) - parseFloat(b.distancePercent));
    
    // Only update cache if we got results
    if (results.longs.length > 0 || results.shorts.length > 0) {
      liquidatableCache = { longs: results.longs, shorts: results.shorts, lastUpdate: Date.now() };
      console.log(`📊 Background scan: ${results.longs.length} longs, ${results.shorts.length} shorts at risk`);
    } else {
      console.log(`⚠️ Background scan: No positions found (keeping old cache)`);
    }
  } catch (err) {
    console.error('Background scan error:', err.message);
  } finally {
    isScanning = false;
  }
}

// Fetch top traders from Hyperliquid leaderboard
async function fetchLeaderboardTraders() {
  try {
    console.log('📊 Fetching leaderboard traders...');
    const response = await axios.get('https://stats-data.hyperliquid.xyz/Mainnet/leaderboard', {
      timeout: 30000
    });
    
    if (response.data && Array.isArray(response.data.leaderboardRows)) {
      let addedCount = 0;
      for (const row of response.data.leaderboardRows) {
        if (row.ethAddress) {
          const addr = row.ethAddress.toLowerCase();
          if (!knownWhaleAddresses.has(addr)) {
            knownWhaleAddresses.add(addr);
            addedCount++;
          }
        }
      }
      console.log(`✅ Leaderboard: Added ${addedCount} new traders (total: ${knownWhaleAddresses.size})`);
    }
  } catch (err) {
    console.log('⚠️ Leaderboard fetch failed:', err.message);
    // Try alternative approach - fetch from Hypurrscan or similar
    await fetchTopTradersAlternative();
  }
}

// Alternative: Fetch from known whale lists or other sources
async function fetchTopTradersAlternative() {
  // Known large Hyperliquid traders (manually curated list as fallback)
  const knownWhales = [
    '0x7b7b908c076b9784487180de92e7161c2982734e',
    '0x2e3f42c178ee5a23a3e1e853e8de02e0a6e5c6c1', // HLP Liquidator
    '0x5815d1b07f8f7cb01f6cb98e6a49d8f96de1b8ef',
    '0x816ac2c03f7c295393f33de3c21f0dcda4ed6aa5',
    '0xdfc24b077bc1425ad1dea75bcb6f8158e10df303', // HLP Vault
    '0x6e9f683ad7f8b7d4c91fa3227af772e1e8c6d7e4',
    '0x1234567890abcdef1234567890abcdef12345678',
  ];
  
  let addedCount = 0;
  for (const addr of knownWhales) {
    const addrLower = addr.toLowerCase();
    if (!knownWhaleAddresses.has(addrLower)) {
      knownWhaleAddresses.add(addrLower);
      addedCount++;
    }
  }
  console.log(`✅ Added ${addedCount} known whales as fallback`);
}

// ============================================
// API ENDPOINTS
// ============================================
app.get('/api/positions', (req, res) => {
  const { minSize, maxDistance, dangerLevel, coin } = req.query;
  let filtered = [...trackedPositions];
  if (minSize) filtered = filtered.filter(p => p.positionUSD >= parseFloat(minSize));
  if (maxDistance) filtered = filtered.filter(p => parseFloat(p.distancePercent) <= parseFloat(maxDistance));
  if (dangerLevel) filtered = filtered.filter(p => p.dangerLevel === dangerLevel);
  if (coin) filtered = filtered.filter(p => p.coin === coin.toUpperCase());
  
  const longs = filtered.filter(p => p.direction === 'LONG');
  const shorts = filtered.filter(p => p.direction === 'SHORT');
  
  // Calculate average liq prices by coin
  const longsByCoin = {};
  const shortsByCoin = {};
  
  for (const p of longs) {
    if (!longsByCoin[p.coin]) {
      longsByCoin[p.coin] = { positions: [], totalSize: 0, weightedLiqSum: 0, avgDistance: 0 };
    }
    longsByCoin[p.coin].positions.push(p);
    longsByCoin[p.coin].totalSize += p.positionUSD;
    longsByCoin[p.coin].weightedLiqSum += p.liqPrice * p.positionUSD;
  }
  
  for (const p of shorts) {
    if (!shortsByCoin[p.coin]) {
      shortsByCoin[p.coin] = { positions: [], totalSize: 0, weightedLiqSum: 0, avgDistance: 0 };
    }
    shortsByCoin[p.coin].positions.push(p);
    shortsByCoin[p.coin].totalSize += p.positionUSD;
    shortsByCoin[p.coin].weightedLiqSum += p.liqPrice * p.positionUSD;
  }
  
  // Calculate averages
  const longCoinStats = {};
  for (const [coin, data] of Object.entries(longsByCoin)) {
    const avgLiqPrice = data.weightedLiqSum / data.totalSize;
    const avgDistance = data.positions.reduce((s, p) => s + parseFloat(p.distancePercent), 0) / data.positions.length;
    longCoinStats[coin] = {
      count: data.positions.length,
      totalSize: data.totalSize,
      avgLiqPrice: avgLiqPrice,
      avgDistance: avgDistance.toFixed(2),
      markPrice: allMids[coin] || 0
    };
  }
  
  const shortCoinStats = {};
  for (const [coin, data] of Object.entries(shortsByCoin)) {
    const avgLiqPrice = data.weightedLiqSum / data.totalSize;
    const avgDistance = data.positions.reduce((s, p) => s + parseFloat(p.distancePercent), 0) / data.positions.length;
    shortCoinStats[coin] = {
      count: data.positions.length,
      totalSize: data.totalSize,
      avgLiqPrice: avgLiqPrice,
      avgDistance: avgDistance.toFixed(2),
      markPrice: allMids[coin] || 0
    };
  }
  
  res.json({ 
    count: filtered.length, 
    longs, 
    shorts, 
    longsAtRisk: longs.reduce((sum, p) => sum + p.positionUSD, 0), 
    shortsAtRisk: shorts.reduce((sum, p) => sum + p.positionUSD, 0),
    longCoinStats,
    shortCoinStats
  });
});

app.get('/api/liquidations', (req, res) => {
  const { minValue, limit } = req.query;
  let filtered = [...recentLiquidations];
  if (minValue) filtered = filtered.filter(l => l.value >= parseFloat(minValue));
  filtered = filtered.slice(0, parseInt(limit) || 50);
  res.json({ count: filtered.length, longValue: filtered.filter(l => l.side === 'LONG').reduce((sum, l) => sum + l.value, 0), shortValue: filtered.filter(l => l.side === 'SHORT').reduce((sum, l) => sum + l.value, 0), liquidations: filtered });
});

app.get('/api/whale-liquidations', (req, res) => {
  res.json({ count: recentWhaleLiquidations.length, liquidations: recentWhaleLiquidations.slice(0, parseInt(req.query.limit) || 20) });
});

// All positions near liquidation (uses background scan cache)
let liquidatableCache = { longs: [], shorts: [], lastUpdate: 0 };
let isScanning = false;

app.get('/api/liquidatable', async (req, res) => {
  const { minSize = 50000, maxDistance = 15 } = req.query;
  
  // Always return from cache - background scan keeps it fresh
  let longs = (liquidatableCache.longs || []).filter(p => p.positionUSD >= parseFloat(minSize) && parseFloat(p.distancePercent) <= parseFloat(maxDistance));
  let shorts = (liquidatableCache.shorts || []).filter(p => p.positionUSD >= parseFloat(minSize) && parseFloat(p.distancePercent) <= parseFloat(maxDistance));
  
  // Calculate coin stats for filtered results
  const longCoinStats = {};
  const shortCoinStats = {};
  
  for (const p of longs) {
    if (!longCoinStats[p.coin]) longCoinStats[p.coin] = { count: 0, totalSize: 0, weightedLiqSum: 0, distanceSum: 0, markPrice: p.markPrice };
    longCoinStats[p.coin].count++;
    longCoinStats[p.coin].totalSize += p.positionUSD;
    longCoinStats[p.coin].weightedLiqSum += p.liqPrice * p.positionUSD;
    longCoinStats[p.coin].distanceSum += parseFloat(p.distancePercent);
  }
  
  for (const p of shorts) {
    if (!shortCoinStats[p.coin]) shortCoinStats[p.coin] = { count: 0, totalSize: 0, weightedLiqSum: 0, distanceSum: 0, markPrice: p.markPrice };
    shortCoinStats[p.coin].count++;
    shortCoinStats[p.coin].totalSize += p.positionUSD;
    shortCoinStats[p.coin].weightedLiqSum += p.liqPrice * p.positionUSD;
    shortCoinStats[p.coin].distanceSum += parseFloat(p.distancePercent);
  }
  
  for (const coin of Object.keys(longCoinStats)) {
    const s = longCoinStats[coin];
    s.avgLiqPrice = s.weightedLiqSum / s.totalSize;
    s.avgDistance = (s.distanceSum / s.count).toFixed(2);
    delete s.weightedLiqSum; delete s.distanceSum;
  }
  for (const coin of Object.keys(shortCoinStats)) {
    const s = shortCoinStats[coin];
    s.avgLiqPrice = s.weightedLiqSum / s.totalSize;
    s.avgDistance = (s.distanceSum / s.count).toFixed(2);
    delete s.weightedLiqSum; delete s.distanceSum;
  }
  
  res.json({
    longs, shorts,
    longsCount: longs.length, shortsCount: shorts.length,
    longsValue: longs.reduce((s, p) => s + p.positionUSD, 0),
    shortsValue: shorts.reduce((s, p) => s + p.positionUSD, 0),
    longCoinStats, shortCoinStats,
    lastUpdate: liquidatableCache.lastUpdate,
    isScanning,
    totalAddresses: knownWhaleAddresses.size
  });
});

app.post('/api/liquidatable/refresh', async (req, res) => {
  // Trigger immediate background scan
  if (!isScanning) {
    backgroundLiquidatableScan();
  }
  res.json({ success: true, message: 'Scan triggered' });
});

app.get('/api/stats', (req, res) => {
  const byCoin = {};
  trackedPositions.forEach(p => { if (!byCoin[p.coin]) byCoin[p.coin] = { count: 0, value: 0 }; byCoin[p.coin].count++; byCoin[p.coin].value += p.positionUSD; });
  res.json({ 
    totalPositions: trackedPositions.length, 
    criticalCount: trackedPositions.filter(p => p.dangerLevel === 'CRITICAL').length, 
    warningCount: trackedPositions.filter(p => p.dangerLevel === 'WARNING').length, 
    totalValueAtRisk: trackedPositions.reduce((sum, p) => sum + p.positionUSD, 0), 
    addressesTracked: knownWhaleAddresses.size, 
    byCoin, 
    databaseConnected: !!pool, 
    telegramConfigured: !!(CONFIG.TELEGRAM_BOT_TOKEN && CONFIG.TELEGRAM_CHANNEL_ID), 
    twitterConfigured: !!(CONFIG.TWITTER_API_KEY && CONFIG.TWITTER_ACCESS_TOKEN) 
  });
});

app.post('/api/add-address', async (req, res) => {
  const { address } = req.body;
  if (!address || !address.startsWith('0x')) return res.status(400).json({ error: 'Invalid address' });
  knownWhaleAddresses.add(address.toLowerCase());
  await checkAddressImmediately(address.toLowerCase(), null, 0);
  res.json({ success: true });
});

app.get('/api/sent-notifications', (req, res) => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  const recentCount = sentNotifications.filter(n => n.timestamp >= oneHourAgo).length;
  res.json({
    total: sentNotifications.length,
    recent: recentCount,
    notifications: sentNotifications.slice(0, 30)
  });
});

app.post('/api/test-telegram', async (req, res) => {
  if (!CONFIG.TELEGRAM_BOT_TOKEN) return res.status(400).json({ error: 'Not configured' });
  const testPos = { user: '0x0000000000000000000000000000000000000000', userShort: '0x0000...0000', coin: 'TEST', direction: 'LONG', positionUSD: 5000000, leverage: 25, distancePercent: '3.50', entryPrice: 100, liqPrice: 95, dangerLevel: 'CRITICAL', allTimePnl: 1500000, isProfitableWhale: true, walletAgeDays: 3, hypurrscanUrl: 'https://hypurrscan.io/address/0x0000000000000000000000000000000000000000' };
  sentAlerts.delete(testPos.user + '-' + testPos.coin);
  await sendTelegramAlert(testPos);
  res.json({ success: true });
});

app.post('/api/test-twitter', async (req, res) => {
  if (!CONFIG.TWITTER_API_KEY) return res.status(400).json({ error: 'Not configured' });
  const testPos = { user: '0x0000000000000000000000000000000000000000', userShort: '0x0000...0000', coin: 'TEST', direction: 'LONG', positionUSD: 5000000, leverage: 25, distancePercent: '3.50', entryPrice: 100, liqPrice: 95, dangerLevel: 'CRITICAL', allTimePnl: 1500000, isProfitableWhale: true, walletAgeDays: 0, hypurrscanUrl: 'https://hypurrscan.io/address/0x0000000000000000000000000000000000000000' };
  sentAlerts.delete('twitter-' + testPos.user + '-' + testPos.coin);
  await sendTwitterAlert(testPos);
  res.json({ success: true });
});

app.get('/api/db-stats', async (req, res) => {
  if (!pool) return res.json({ connected: false, message: 'No database configured' });
  try {
    const result = await pool.query('SELECT COUNT(*) FROM whales');
    res.json({ connected: true, whales: parseInt(result.rows[0].count) });
  } catch (err) { res.json({ connected: false, error: err.message }); }
});

app.listen(CONFIG.PORT, () => { console.log('🌐 Server on port ' + CONFIG.PORT); initialize(); });
