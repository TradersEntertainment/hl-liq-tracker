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
  ALERT_COOLDOWN: 30 * 60 * 1000, // 30 minutes cooldown per position
  DATABASE_URL: process.env.DATABASE_URL,
  DEBUG_MODE: process.env.DEBUG_MODE === 'true',
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

// ============================================
// ALERTS
// ============================================
const sentAlerts = new Map();
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
    console.log('🐦 Twitter: ' + position.coin);
  } catch (error) {
    console.error('Twitter error:', error.response?.status, error.response?.data?.detail || error.message);
  }
}

async function sendAlerts(position) {
  // Only alert for $2M+ positions within 10% of liquidation
  if (position.positionUSD < CONFIG.MIN_POSITION_USD) {
    return;
  }
  
  const distancePercent = parseFloat(position.distancePercent);
  if (distancePercent > 10) {
    return;
  }
  
  // If we reach here: $2M+ AND within 10% of liq = ALWAYS ALERT
  
  // Check for potential HyperVault attack (shitcoin + large position)
  const isPotentialVaultAttack = isShitcoin(position.coin) && position.positionUSD >= 2000000;
  const isLargeShitcoinBet = isShitcoin(position.coin) && position.positionUSD >= 5000000;
  const isMassiveVaultAttack = isShitcoin(position.coin) && position.positionUSD >= 10000000;
  const isBrandNew = position.walletAgeDays !== null && position.walletAgeDays === 0;
  
  // Log with appropriate urgency
  if (isMassiveVaultAttack) {
    console.log('🚨🚨🚨 VAULT ATTACK ALERT: ' + position.coin + ' ' + position.direction + ' | $' + (position.positionUSD/1000000).toFixed(2) + 'M');
  } else if (isLargeShitcoinBet) {
    console.log('🎰 DEGEN WHALE: ' + position.coin + ' ' + position.direction + ' | $' + (position.positionUSD/1000000).toFixed(2) + 'M');
  } else if (isPotentialVaultAttack) {
    console.log('⚠️ SHITCOIN WHALE: ' + position.coin + ' ' + position.direction + ' | $' + (position.positionUSD/1000000).toFixed(2) + 'M');
  } else {
    console.log('🔔 SENDING ALERT: ' + position.coin + ' ' + position.direction + ' | $' + (position.positionUSD/1000000).toFixed(2) + 'M | ' + position.dangerLevel);
  }
  
  // Send Telegram first (more reliable), then Twitter with delay
  await sendTelegramAlert(position);
  
  // Delay Twitter to avoid rate limits
  setTimeout(() => sendTwitterAlert(position), 5000);
}

// ============================================
// HYPERLIQUID API
// ============================================
async function hlPost(body, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.post(CONFIG.HYPERLIQUID_API, body, { timeout: 10000 });
      return response.data;
    } catch (error) {
      if (i === retries - 1) {
        if (CONFIG.DEBUG_MODE) console.error('❌ hlPost failed after ' + retries + ' retries:', body.type, error.message);
        return null;
      }
      // Wait before retry (exponential backoff)
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  return null;
}

async function getAssetMeta() {
  const data = await hlPost({ type: 'meta' });
  return data?.universe?.map(a => a.name) || [];
}

async function getAllMids() {
  const data = await hlPost({ type: 'allMids' });
  if (data && Object.keys(data).length > 0) {
    return data;
  }
  // If allMids fails, try metaAndAssetCtxs as fallback
  try {
    const meta = await hlPost({ type: 'metaAndAssetCtxs' });
    if (meta && Array.isArray(meta) && meta.length >= 2) {
      const mids = {};
      const universe = meta[0]?.universe || [];
      const ctxs = meta[1] || [];
      for (let i = 0; i < universe.length && i < ctxs.length; i++) {
        const coin = universe[i]?.name;
        const midPx = ctxs[i]?.midPx;
        if (coin && midPx) mids[coin] = midPx;
      }
      if (Object.keys(mids).length > 0) {
        console.log('✅ allMids recovered from metaAndAssetCtxs');
        return mids;
      }
    }
  } catch (e) {}
  return {};
}

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
  
  // For shitcoins with $2M+ positions, allow up to 15% distance (potential vault attacks)
  // For top coins, only track up to 10% distance
  const isShitcoinLargePosition = isShitcoin(coin) && positionUSD >= 2000000;
  const maxDistance = isShitcoinLargePosition ? 0.15 : 0.10;
  
  if (distanceToLiq > maxDistance || distanceToLiq < 0) return null;
  
  const dangerLevel = distanceToLiq <= CONFIG.DANGER_THRESHOLD_5 ? 'CRITICAL' : distanceToLiq <= CONFIG.DANGER_THRESHOLD_10 ? 'WARNING' : 'WATCH';
  
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
let lastTradeReceived = 0;
let totalTradesReceived = 0;

// HLP Vault address - receives all liquidations
const HLP_VAULT = '0xdfc24b077bc1425ad1dea75bcb6f8158e10df303';

function connectWebSocket() {
  try {
    ws = new WebSocket(CONFIG.HYPERLIQUID_WS);
    
    ws.on('open', () => {
      console.log('✅ WebSocket connected');
      wsReconnectAttempts = 0;
      // Subscribe to ALL trades
      ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades' } }));
      // Subscribe to HLP vault userEvents - this gives us REAL liquidation data!
      ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'userEvents', user: HLP_VAULT } }));
      // Also subscribe to HLP fills for backup liquidation detection
      ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'userFills', user: HLP_VAULT } }));
    });
    
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.channel === 'subscriptionResponse') {
          console.log('✅ Subscribed:', JSON.stringify(msg.data?.subscription?.type || msg.data));
        }
        
        // Handle trades for whale discovery
        if (msg.channel === 'trades' && msg.data) {
          if (Array.isArray(msg.data) && msg.data.length > 0) {
            lastTradeReceived = Date.now();
            totalTradesReceived += msg.data.length;

            if (CONFIG.DEBUG_MODE && totalTradesReceived <= 5) {
              console.log('🔍 DEBUG - Sample trade:', JSON.stringify(msg.data[0], null, 2));
            }

            processTradesForDiscovery(msg.data);
          }
        }
        
        // Handle HLP userEvents - contains real liquidation events!
        if (msg.channel === 'userEvents' && msg.data) {
          processHlpUserEvents(msg.data);
        }
        
        // Handle HLP fills - backup liquidation detection
        if (msg.channel === 'userFills' && msg.data) {
          if (msg.data.fills && Array.isArray(msg.data.fills)) {
            processHlpFills(msg.data.fills);
          }
        }
      } catch (e) {
        console.error('❌ WebSocket message parse error:', e.message);
      }
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
  if (!trades || !Array.isArray(trades)) {
    console.warn('⚠️ processTradesForDiscovery: Invalid trades data');
    return;
  }

  let processedCount = 0;
  for (const trade of trades) {
    try {
      if (!trade || !trade.coin) continue;

      const sz = parseFloat(trade.sz || 0);
      const px = parseFloat(trade.px || 0);
      if (!sz || !px) continue;

      const tradeValue = Math.abs(sz) * px;
      if (tradeValue < CONFIG.MIN_TRADE_USD) continue;

      const users = trade.users || [];
      if (!Array.isArray(users) || users.length === 0) continue;

      for (const user of users) {
        if (!user || typeof user !== 'string' || user.length < 10) continue;

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
        processedCount++;
      }
    } catch (err) {
      console.error('❌ Error processing trade:', err.message, trade);
    }
  }

  if (processedCount > 0) {
    console.log('📊 Processed ' + processedCount + ' whale trades from ' + trades.length + ' total trades');
  }
}

// Track known positions to detect truly new ones
const knownPositionKeys = new Set();

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
          if (allTimePnl !== null) {
            processed.isProfitableWhale = allTimePnl > 0;
            processed.whaleType = allTimePnl > 0 ? 'PROFITABLE' : 'LOSING';
          }
          
          const key = address + '-' + pos.coin;
          const existingIdx = trackedPositions.findIndex(p => p.user === address && p.coin === pos.coin);
          
          // Check if this is a potential vault attack (shitcoin + large position)
          const isPotentialVaultAttack = isShitcoin(pos.coin) && processed.positionUSD >= 2000000;
          
          if (existingIdx >= 0) {
            // Update existing position - NO alert
            trackedPositions[existingIdx] = processed;
          } else {
            // New position in trackedPositions
            trackedPositions.unshift(processed);
            
            // Alert if:
            // 1. First time seeing AND trade is for same coin, OR
            // 2. Potential vault attack (shitcoin $2M+) - NEVER miss these!
            if (!knownPositionKeys.has(key)) {
              knownPositionKeys.add(key);
              
              if (pos.coin === tradeCoin || isPotentialVaultAttack) {
                console.log('🚨 NEW POSITION: ' + processed.userShort + ' | ' + processed.coin + ' ' + processed.direction + ' | $' + (processed.positionUSD/1000000).toFixed(2) + 'M | ' + processed.distancePercent + '%' + (isPotentialVaultAttack ? ' ⚠️ SHITCOIN' : ''));
                sendAlerts(processed);
              }
            }
          }
        }
      }
      trackedPositions.sort((a, b) => a.distanceToLiq - b.distanceToLiq);
    }
  } catch (err) {
    console.error('❌ checkAddressImmediately error:', err.message);
  }
}

// ============================================
// LIQUIDATIONS
// ============================================
let recentLiquidations = [];
let recentWhaleLiquidations = [];
const MAX_LIQUIDATIONS = 200;

// Fetch recent liquidations via REST API (more reliable than WebSocket detection)
async function fetchRecentLiquidations() {
  try {
    // Get liquidatable positions first
    const liquidatable = await hlPost({ type: 'liquidatable' });
    if (liquidatable && Array.isArray(liquidatable)) {
      console.log(`📊 Found ${liquidatable.length} liquidatable positions`);
    }
    
    // Also try to get recent fills that are liquidations
    // We'll check the HLP vault's recent fills as it handles most liquidations
    const hlpVault = '0xdfc24b077bc1425ad1dea75bcb6f8158e10df303';
    const response = await axios.post(CONFIG.HYPERLIQUID_API, {
      type: 'userFillsByTime',
      user: hlpVault,
      startTime: Date.now() - 300000, // Last 5 minutes
      endTime: Date.now()
    });
    
    if (response.data && Array.isArray(response.data)) {
      let newLiqCount = 0;
      for (const fill of response.data) {
        // HLP fills that are "Close Short" or "Close Long" against liquidated positions
        if (fill.dir && (fill.dir.includes('Liq') || fill.liquidation)) {
          const value = Math.abs(parseFloat(fill.sz)) * parseFloat(fill.px);
          if (value < 10000) continue;
          
          const liq = {
            id: fill.hash || (Date.now() + '-' + Math.random().toString(36).substr(2, 9)),
            coin: fill.coin,
            side: fill.side === 'B' ? 'SHORT' : 'LONG', // If HLP buys, a short was liquidated
            price: parseFloat(fill.px),
            size: Math.abs(parseFloat(fill.sz)),
            value: value,
            timestamp: fill.time || Date.now(),
            hash: fill.hash
          };
          
          // Check duplicate
          const isDuplicate = recentLiquidations.some(l => 
            l.hash === liq.hash || 
            (l.coin === liq.coin && Math.abs(l.timestamp - liq.timestamp) < 1000 && Math.abs(l.value - liq.value) < 100)
          );
          
          if (!isDuplicate) {
            recentLiquidations.unshift(liq);
            newLiqCount++;
            
            if (value >= 500000) {
              recentWhaleLiquidations.unshift(liq);
              console.log('🐋💀 WHALE LIQ: ' + liq.coin + ' ' + liq.side + ' | $' + (value/1000000).toFixed(2) + 'M');
            }
          }
        }
      }
      
      // Trim arrays
      if (recentLiquidations.length > MAX_LIQUIDATIONS) {
        recentLiquidations = recentLiquidations.slice(0, MAX_LIQUIDATIONS);
      }
      if (recentWhaleLiquidations.length > 50) {
        recentWhaleLiquidations = recentWhaleLiquidations.slice(0, 50);
      }
      
      if (newLiqCount > 0) {
        console.log(`💀 Added ${newLiqCount} liquidations from HLP fills`);
      }
    }
  } catch (err) {
    if (CONFIG.DEBUG_MODE) console.error('Liquidation fetch error:', err.message);
  }
}

// Process HLP userEvents - contains REAL liquidation events from the protocol
function processHlpUserEvents(data) {
  try {
    // Handle both single event and array
    const events = Array.isArray(data) ? data : [data];
    
    for (const event of events) {
      // Skip snapshot data
      if (event.isSnapshot) continue;
      
      // Check for liquidation event
      if (event.liquidation) {
        const liq = event.liquidation;
        const value = Math.abs(parseFloat(liq.liquidated_ntl_pos || 0));
        
        if (value < 10000) continue; // Skip tiny liquidations
        
        const liqData = {
          id: liq.lid || Date.now() + '-' + Math.random().toString(36).substr(2, 9),
          coin: 'UNKNOWN', // Will be enriched from fills
          side: parseFloat(liq.liquidated_ntl_pos) > 0 ? 'LONG' : 'SHORT',
          price: 0,
          size: 0,
          value: value,
          timestamp: Date.now(),
          liquidatedUser: liq.liquidated_user,
          accountValue: parseFloat(liq.liquidated_account_value || 0),
          source: 'userEvents'
        };
        
        // Check duplicate
        const isDuplicate = recentLiquidations.some(l => 
          l.id === liqData.id || 
          (l.liquidatedUser === liqData.liquidatedUser && Math.abs(l.timestamp - liqData.timestamp) < 5000)
        );
        
        if (!isDuplicate) {
          recentLiquidations.unshift(liqData);
          if (recentLiquidations.length > MAX_LIQUIDATIONS) {
            recentLiquidations = recentLiquidations.slice(0, MAX_LIQUIDATIONS);
          }
          
          if (value >= 500000) {
            recentWhaleLiquidations.unshift(liqData);
            if (recentWhaleLiquidations.length > 50) {
              recentWhaleLiquidations = recentWhaleLiquidations.slice(0, 50);
            }
            console.log('🐋💀 WHALE LIQ (userEvents): ' + liqData.side + ' | $' + (value/1000000).toFixed(2) + 'M | User: ' + liqData.liquidatedUser?.slice(0,10));
          } else if (value >= 100000) {
            console.log('💀 LIQ (userEvents): ' + liqData.side + ' | $' + (value/1000).toFixed(0) + 'K');
          }
        }
      }
      
      // Also check fills within userEvents for liquidation info
      if (event.fills && Array.isArray(event.fills)) {
        processHlpFills(event.fills);
      }
    }
  } catch (err) {
    console.error('❌ processHlpUserEvents error:', err.message);
  }
}

// Process HLP fills - contains liquidation details with coin info
function processHlpFills(fills) {
  if (!fills || !Array.isArray(fills)) return;
  
  let liqCount = 0;
  for (const fill of fills) {
    try {
      // Skip snapshot data
      if (fill.isSnapshot) continue;
      
      // Check if this fill is a liquidation
      const hasLiquidation = fill.liquidation && fill.liquidation.liquidatedUser;
      const isLiqDir = fill.dir && fill.dir.toLowerCase().includes('liq');
      
      if (!hasLiquidation && !isLiqDir) continue;
      
      const sz = Math.abs(parseFloat(fill.sz || 0));
      const px = parseFloat(fill.px || 0);
      const value = sz * px;
      
      if (value < 10000) continue;
      
      // Determine side: if HLP buys (side=B), a short was liquidated
      // If HLP sells (side=A), a long was liquidated
      const side = fill.side === 'B' ? 'SHORT' : 'LONG';
      
      const liqData = {
        id: fill.hash || Date.now() + '-' + Math.random().toString(36).substr(2, 9),
        coin: fill.coin,
        side: side,
        price: px,
        size: sz,
        value: value,
        timestamp: fill.time || Date.now(),
        hash: fill.hash,
        liquidatedUser: fill.liquidation?.liquidatedUser,
        markPx: fill.liquidation?.markPx,
        method: fill.liquidation?.method,
        source: 'hlpFills'
      };
      
      // Check duplicate by hash or similar params
      const isDuplicate = recentLiquidations.some(l => 
        (l.hash && l.hash === liqData.hash) ||
        (l.coin === liqData.coin && Math.abs(l.value - liqData.value) < 1000 && Math.abs(l.timestamp - liqData.timestamp) < 3000)
      );
      
      if (!isDuplicate) {
        recentLiquidations.unshift(liqData);
        if (recentLiquidations.length > MAX_LIQUIDATIONS) {
          recentLiquidations = recentLiquidations.slice(0, MAX_LIQUIDATIONS);
        }
        
        if (value >= 500000) {
          recentWhaleLiquidations.unshift(liqData);
          if (recentWhaleLiquidations.length > 50) {
            recentWhaleLiquidations = recentWhaleLiquidations.slice(0, 50);
          }
          console.log('🐋💀 WHALE LIQ: ' + liqData.coin + ' ' + side + ' | $' + (value/1000000).toFixed(2) + 'M');
        } else if (value >= 100000) {
          console.log('💀 LIQ: ' + liqData.coin + ' ' + side + ' | $' + (value/1000).toFixed(0) + 'K');
        }
        liqCount++;
      }
    } catch (err) {
      console.error('❌ Error processing HLP fill:', err.message);
    }
  }
  
  if (liqCount > 0) {
    console.log('💀 Detected ' + liqCount + ' liquidations from HLP fills');
  }
}

// DEPRECATED: Old unreliable method - keeping for reference
function processLiquidationsOld(trades) {
  if (!trades || !Array.isArray(trades)) return;

  let liqCount = 0;
  for (const trade of trades) {
    try {
      if (!trade || !trade.coin) continue;

      const sz = parseFloat(trade.sz || 0);
      const px = parseFloat(trade.px || 0);
      if (!sz || !px) continue;

      const tradeValue = Math.abs(sz) * px;

      // Check for liquidation indicators:
      // 1. trade.liquidation field (if available)
      // 2. trade.dir contains "Liq"
      // 3. Large crossed trade (heuristic, less reliable)
      const hasLiqFlag = trade.liquidation === true || trade.isLiquidation === true;
      const hasLiqDir = trade.dir && typeof trade.dir === 'string' && trade.dir.toLowerCase().includes('liq');
      const isLargeCrossed = trade.crossed === true && tradeValue >= 100000;

      if ((hasLiqFlag || hasLiqDir || isLargeCrossed) && tradeValue >= 50000) {
        const liq = {
          id: trade.hash || (Date.now() + '-' + Math.random().toString(36).substr(2, 9)),
          coin: trade.coin,
          side: trade.side === 'B' ? 'SHORT' : 'LONG',
          price: px,
          size: Math.abs(sz),
          value: tradeValue,
          timestamp: trade.time || Date.now(),
          hash: trade.hash || null,
          source: hasLiqFlag ? 'flag' : hasLiqDir ? 'dir' : 'crossed'
        };

        const isDuplicate = recentLiquidations.some(l =>
          (l.hash && l.hash === liq.hash) ||
          (l.coin === liq.coin && Math.abs(l.value - liq.value) < 1000 && Math.abs(l.timestamp - liq.timestamp) < 3000)
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
          liqCount++;
        }
      }
    } catch (err) {
      console.error('❌ Error processing liquidation:', err.message);
    }
  }

  if (liqCount > 0) {
    console.log('💀 Detected ' + liqCount + ' liquidations from WebSocket');
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
  try {
    if (knownWhaleAddresses.size === 0) {
      console.log('⚠️ No whales discovered yet. Waiting for trades...');
      return;
    }
    console.log('🔍 Scanning ' + knownWhaleAddresses.size + ' addresses...');
    const newMids = await getAllMids();
    if (newMids && Object.keys(newMids).length > 0) {
      allMids = newMids;
    } else if (Object.keys(allMids).length > 0) {
      console.log('⚠️ allMids fetch failed - using cached prices (' + Object.keys(allMids).length + ' coins)');
    } else {
      console.error('❌ No price data available - skipping refresh');
      return;
    }
    
    // Just update positions for UI display - NO alerts here
    // Alerts are ONLY sent from checkAddressImmediately when a new trade is detected
    trackedPositions = await scanPositions([...knownWhaleAddresses].slice(0, CONFIG.MAX_ADDRESSES_TO_SCAN));
    
    const longs = trackedPositions.filter(p => p.direction === 'LONG');
    const shorts = trackedPositions.filter(p => p.direction === 'SHORT');
    console.log('✅ Found ' + trackedPositions.length + ' at-risk (' + longs.length + ' longs, ' + shorts.length + ' shorts) - ' + trackedPositions.filter(p => p.dangerLevel === 'CRITICAL').length + ' critical');
  } catch (err) {
    console.error('❌ refreshPositions error:', err.message);
  }
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
  
  // Mark all existing positions as known (so we don't alert for them)
  for (const pos of trackedPositions) {
    knownPositionKeys.add(pos.user + '-' + pos.coin);
  }
  console.log('📝 Marked ' + knownPositionKeys.size + ' existing positions as known (no alerts for these)');
  
  setInterval(refreshPositions, CONFIG.REFRESH_INTERVAL);

  // Refresh leaderboard every 10 minutes
  setInterval(fetchLeaderboardTraders, 10 * 60 * 1000);

  // Background liquidatable scan every 3 minutes
  backgroundLiquidatableScan();
  setInterval(backgroundLiquidatableScan, 3 * 60 * 1000);
  
  // Fetch liquidations from HLP vault every 30 seconds
  fetchRecentLiquidations();
  setInterval(fetchRecentLiquidations, 30000);

  // WebSocket health check every 30 seconds
  setInterval(() => {
    if (!ws || ws.readyState !== 1) {
      console.log('⚠️ WebSocket not connected, attempting reconnect...');
      connectWebSocket();
    } else if (lastTradeReceived > 0 && (Date.now() - lastTradeReceived) > 120000) {
      console.log('⚠️ No trades received in 2+ minutes, reconnecting WebSocket...');
      ws.close();
      connectWebSocket();
    }
  }, 30000);
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
              hypurrscanUrl: getHypurrscanUrl(addr)
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

app.get('/api/diagnostics', (req, res) => {
  const wsState = ws ? (ws.readyState === 1 ? 'OPEN' : ws.readyState === 0 ? 'CONNECTING' : ws.readyState === 2 ? 'CLOSING' : 'CLOSED') : 'NULL';
  const secondsSinceLastTrade = lastTradeReceived > 0 ? Math.floor((Date.now() - lastTradeReceived) / 1000) : null;
  res.json({
    websocket: {
      connected: ws && ws.readyState === 1,
      state: wsState,
      reconnectAttempts: wsReconnectAttempts,
      lastTradeReceived: lastTradeReceived > 0 ? new Date(lastTradeReceived).toISOString() : 'Never',
      secondsSinceLastTrade: secondsSinceLastTrade,
      totalTradesReceived: totalTradesReceived
    },
    positions: {
      total: trackedPositions.length,
      longs: trackedPositions.filter(p => p.direction === 'LONG').length,
      shorts: trackedPositions.filter(p => p.direction === 'SHORT').length,
      critical: trackedPositions.filter(p => p.dangerLevel === 'CRITICAL').length
    },
    liquidations: {
      total: recentLiquidations.length,
      whale: recentWhaleLiquidations.length
    },
    whales: {
      known: knownWhaleAddresses.size,
      maxScanning: CONFIG.MAX_ADDRESSES_TO_SCAN
    },
    cache: {
      allMidsCount: Object.keys(allMids).length,
      pnlCacheSize: allTimePnlCache.size,
      walletAgeCacheSize: walletAgeCache.size,
      liquidatableCacheAge: Date.now() - liquidatableCache.lastUpdate,
      liquidatableLongs: liquidatableCache.longs?.length || 0,
      liquidatableShorts: liquidatableCache.shorts?.length || 0
    },
    config: {
      minPositionUSD: CONFIG.MIN_POSITION_USD,
      minTradeUSD: CONFIG.MIN_TRADE_USD,
      refreshInterval: CONFIG.REFRESH_INTERVAL,
      telegramConfigured: !!(CONFIG.TELEGRAM_BOT_TOKEN && CONFIG.TELEGRAM_CHANNEL_ID),
      twitterConfigured: !!(CONFIG.TWITTER_API_KEY && CONFIG.TWITTER_ACCESS_TOKEN)
    }
  });
});

app.listen(CONFIG.PORT, () => { console.log('🌐 Server on port ' + CONFIG.PORT); initialize(); });
