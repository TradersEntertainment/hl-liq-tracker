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
  
  const emoji = position.dangerLevel === 'CRITICAL' ? '🚨' : '⚠️';
  const dirEmoji = position.direction === 'LONG' ? '🟢' : '🔴';
  
  const ageDays = position.walletAgeDays;
  const isBrandNew = ageDays !== null && ageDays === 0;
  const isNewWallet = ageDays !== null && ageDays < 7;
  
  let walletAgeAlert = '';
  if (isBrandNew) {
    walletAgeAlert = '👶🚨 *BRAND NEW WALLET* (< 1 day)\n⚠️ *POSSIBLE INSIDER/EXPLOIT*\n\n';
  } else if (isNewWallet) {
    walletAgeAlert = '👶 *NEW WALLET* (' + ageDays + ' days old)\n';
  }
  
  const isShitcoinBet = isShitcoin(position.coin) && position.positionUSD >= 2000000;
  const isPotentialVaultAttack = isShitcoin(position.coin) && position.positionUSD >= 10000000;
  
  let alertHeader = '';
  if (isPotentialVaultAttack) {
    alertHeader = '🚨🚨🚨🚨🚨 *POTENTIAL HYPERVAULT ATTACK* 🚨🚨🚨🚨🚨\n';
  } else if (isShitcoinBet) {
    alertHeader = '🎰🎰🎰 *SHITCOIN WHALE BET* 🎰🎰🎰\n';
  }
  
  let whaleStatus = '';
  if (position.allTimePnl !== null) {
    const pnlValue = position.allTimePnl;
    const pnlFormatted = pnlValue >= 0 ? '+$' + (Math.abs(pnlValue) / 1000000).toFixed(2) + 'M' : '-$' + (Math.abs(pnlValue) / 1000000).toFixed(2) + 'M';
    whaleStatus = position.isProfitableWhale ? '💰 *HISTORICALLY PROFITABLE* (' + pnlFormatted + ')\n' : '🎰 *HISTORICALLY LOSER* (' + pnlFormatted + ')\n';
  }
  
  const message = alertHeader + walletAgeAlert + emoji + ' *HIGH-RISK POSITION* ' + emoji + '\n\n' + whaleStatus + dirEmoji + ' *' + position.coin + ' ' + position.direction + '*\n💰 Size: *$' + (position.positionUSD / 1000000).toFixed(2) + 'M*\n⚡ Leverage: *' + position.leverage + 'x*\n📍 Distance: *' + position.distancePercent + '%*\n\n📊 Entry: *$' + formatPriceCompact(position.entryPrice) + '*\n💀 Liq: *$' + formatPriceCompact(position.liqPrice) + '*\n\n🕐 Wallet: ' + formatWalletAge(ageDays) + '\n\n🔗 [View on Hypurrscan](' + position.hypurrscanUrl + ')\n\n#Hyperliquid #' + position.coin;

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
  
  const emoji = position.dangerLevel === 'CRITICAL' ? '🚨' : '⚠️';
  const dirEmoji = position.direction === 'LONG' ? '🟢' : '🔴';
  const ageDays = position.walletAgeDays;
  const isBrandNew = ageDays !== null && ageDays === 0;
  const isShitcoinBet = isShitcoin(position.coin) && position.positionUSD >= 2000000;
  const isPotentialVaultAttack = isShitcoin(position.coin) && position.positionUSD >= 10000000;
  
  let alertHeader = '';
  if (isPotentialVaultAttack) alertHeader = '🚨🚨🚨 VAULT ATTACK? 🚨🚨🚨\n';
  else if (isBrandNew) alertHeader = '👶🚨 BRAND NEW WALLET\n';
  else if (isShitcoinBet) alertHeader = '🎰 DEGEN BET\n';
  
  let whaleTag = '';
  if (position.allTimePnl !== null) {
    const pnlAbs = Math.abs(position.allTimePnl);
    let pnlStr = pnlAbs >= 1000000 ? '$' + (pnlAbs / 1000000).toFixed(1) + 'M' : '$' + (pnlAbs / 1000).toFixed(0) + 'K';
    whaleTag = position.isProfitableWhale ? '💰 Historically Profitable +' + pnlStr + '\n' : '🎰 Historically Loser -' + pnlStr + '\n';
  }
  
  const tweet = (alertHeader + emoji + ' ' + position.coin + ' ' + position.direction + '\n\n' + whaleTag + dirEmoji + ' $' + (position.positionUSD / 1000000).toFixed(1) + 'M @ ' + position.leverage + 'x\n📊 Entry: $' + formatPriceCompact(position.entryPrice) + '\n💀 Liq: $' + formatPriceCompact(position.liqPrice) + '\n🕐 ' + formatWalletAge(ageDays) + '\n\n' + position.hypurrscanUrl + '\n\n#Hyperliquid #' + position.coin).slice(0, 280);

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
  if (position.dangerLevel !== 'CRITICAL' && (position.walletAgeDays === null || position.walletAgeDays > 7)) return;
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
  connectWebSocket();
  console.log('⏳ Waiting 5s for whale discovery...');
  await new Promise(r => setTimeout(r, 5000));
  await refreshPositions();
  setInterval(refreshPositions, CONFIG.REFRESH_INTERVAL);
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
  res.json({ count: filtered.length, longs, shorts, longsAtRisk: longs.reduce((sum, p) => sum + p.positionUSD, 0), shortsAtRisk: shorts.reduce((sum, p) => sum + p.positionUSD, 0) });
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

app.listen(CONFIG.PORT, () => { console.log('🌐 Server on port ' + CONFIG.PORT); initialize(); });
