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
// TELEGRAM BOT
// ============================================
async function sendTelegramAlert(position) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHANNEL_ID) {
    return;
  }
  
  // Check cooldown
  const alertKey = `${position.user}-${position.coin}`;
  const lastAlert = sentAlerts.get(alertKey);
  if (lastAlert && (Date.now() - lastAlert) < CONFIG.ALERT_COOLDOWN) {
    return; // Skip - recently alerted
  }
  
  const emoji = position.dangerLevel === 'CRITICAL' ? '🚨' : '⚠️';
  const dirEmoji = position.direction === 'LONG' ? '🟢' : '🔴';
  const newBadge = position.isNewAddress ? '🆕 NEW WALLET\n' : '';
  
  const message = `
${emoji} *HIGH-RISK POSITION DETECTED* ${emoji}

${newBadge}${dirEmoji} *${position.coin} ${position.direction}*
💰 Size: *$${(position.positionUSD / 1000000).toFixed(2)}M*
⚡ Leverage: *${position.leverage}x*
📍 Distance to Liq: *${position.distancePercent}%*

📊 Entry: $${position.entryPrice.toFixed(2)}
📈 Mark: $${position.markPrice.toFixed(2)}
💀 Liq: $${position.liqPrice.toFixed(2)}

💼 Wallet: $${position.walletBalance ? (position.walletBalance / 1000).toFixed(0) + 'K' : 'N/A'}
📂 Total Positions: ${position.totalPositionCount || 1}

🔗 [View on Hyperliquid](${position.hyperliquidUrl})

#Hyperliquid #Liquidation #${position.coin} #Whale
`.trim();

  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: CONFIG.TELEGRAM_CHANNEL_ID,
      text: message,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
    
    sentAlerts.set(alertKey, Date.now());
    console.log(`📨 Telegram alert sent: ${position.coin} ${position.direction}`);
  } catch (error) {
    console.error('Telegram error:', error.response?.data?.description || error.message);
  }
}

// ============================================
// TWITTER/X API
// ============================================
async function sendTwitterAlert(position) {
  if (!CONFIG.TWITTER_API_KEY || !CONFIG.TWITTER_ACCESS_TOKEN) {
    return;
  }
  
  // Check cooldown
  const alertKey = `twitter-${position.user}-${position.coin}`;
  const lastAlert = sentAlerts.get(alertKey);
  if (lastAlert && (Date.now() - lastAlert) < CONFIG.ALERT_COOLDOWN) {
    return;
  }
  
  const emoji = position.dangerLevel === 'CRITICAL' ? '🚨' : '⚠️';
  const dirEmoji = position.direction === 'LONG' ? '🟢' : '🔴';
  const newBadge = position.isNewAddress ? '🆕 NEW WALLET ' : '';
  
  // Twitter has 280 char limit
  const tweet = `${emoji} HIGH-RISK ${position.coin} ${position.direction} DETECTED

${newBadge}${dirEmoji} $${(position.positionUSD / 1000000).toFixed(1)}M @ ${position.leverage}x
📍 ${position.distancePercent}% to liquidation
💀 Liq: $${position.liqPrice.toFixed(0)}

${position.hyperliquidUrl}

#Hyperliquid #${position.coin} #Crypto`.slice(0, 280);

  try {
    // OAuth 1.0a signature
    const crypto = require('crypto');
    const oauth = require('oauth-1.0a');
    
    const oauthClient = oauth({
      consumer: {
        key: CONFIG.TWITTER_API_KEY,
        secret: CONFIG.TWITTER_API_SECRET
      },
      signature_method: 'HMAC-SHA1',
      hash_function(baseString, key) {
        return crypto.createHmac('sha1', key).update(baseString).digest('base64');
      }
    });
    
    const token = {
      key: CONFIG.TWITTER_ACCESS_TOKEN,
      secret: CONFIG.TWITTER_ACCESS_SECRET
    };
    
    const url = 'https://api.twitter.com/2/tweets';
    const authHeader = oauthClient.toHeader(oauthClient.authorize({ url, method: 'POST' }, token));
    
    await axios.post(url, { text: tweet }, {
      headers: {
        ...authHeader,
        'Content-Type': 'application/json'
      }
    });
    
    sentAlerts.set(alertKey, Date.now());
    console.log(`🐦 Twitter alert sent: ${position.coin} ${position.direction}`);
  } catch (error) {
    console.error('Twitter error:', error.response?.data || error.message);
  }
}

// Combined alert function
async function sendAlerts(position) {
  // Only alert for significant positions
  if (position.dangerLevel !== 'CRITICAL' && !position.isNewAddress) {
    return; // Only alert CRITICAL or NEW addresses
  }
  
  // Send to both platforms in parallel
  await Promise.all([
    sendTelegramAlert(position),
    sendTwitterAlert(position)
  ]);
}

// Configuration
const CONFIG = {
  HYPERLIQUID_API: 'https://api.hyperliquid.xyz/info',
  HYPERLIQUID_WS: 'wss://api.hyperliquid.xyz/ws',
  MIN_POSITION_USD: 2000000,    // $2M minimum position to track
  MIN_TRADE_USD: 100000,        // $100k trade = potential whale, add to scan list
  DANGER_THRESHOLD_5: 0.05,     // 5% from liquidation
  DANGER_THRESHOLD_10: 0.10,    // 10% from liquidation
  REFRESH_INTERVAL: 15000,      // 15 seconds - daha hızlı tarama
  MAX_ADDRESSES_TO_SCAN: 500,   // Maximum addresses to keep in memory
  
  // Coinglass API (opsiyonel - eğer API key varsa)
  COINGLASS_API_KEY: process.env.COINGLASS_API_KEY || '',
  COINGLASS_API: 'https://open-api-v3.coinglass.com',
  
  // Telegram Bot Config
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHANNEL_ID: process.env.TELEGRAM_CHANNEL_ID || '', // @channel_name veya -100xxxxx
  
  // Twitter/X API Config (API v2)
  TWITTER_API_KEY: process.env.TWITTER_API_KEY || '',
  TWITTER_API_SECRET: process.env.TWITTER_API_SECRET || '',
  TWITTER_ACCESS_TOKEN: process.env.TWITTER_ACCESS_TOKEN || '',
  TWITTER_ACCESS_SECRET: process.env.TWITTER_ACCESS_SECRET || '',
  
  // Alert settings
  ALERT_COOLDOWN: 300000, // 5 dakika - aynı pozisyon için tekrar alert atma
};

// Track sent alerts to avoid spam
const sentAlerts = new Map(); // key: `${user}-${coin}`, value: timestamp

// Recent liquidations storage
let recentLiquidations = [];
let recentWhaleLiquidations = []; // Whale liq'leri ayrı
const MAX_LIQUIDATIONS = 100;

// Store for tracked positions
let trackedPositions = [];
let allMids = {}; // Current prices
let assetMeta = []; // Asset metadata

// Hyperliquid API helper
async function hlPost(payload) {
  try {
    const response = await axios.post(CONFIG.HYPERLIQUID_API, payload, {
      headers: { 'Content-Type': 'application/json' }
    });
    return response.data;
  } catch (error) {
    console.error('Hyperliquid API Error:', error.message);
    return null;
  }
}

// Get all asset metadata
async function getAssetMeta() {
  const data = await hlPost({ type: 'metaAndAssetCtxs' });
  if (data && data[0] && data[0].universe) {
    assetMeta = data[0].universe;
    // Extract mids from asset contexts
    if (data[1]) {
      data[1].forEach((ctx, idx) => {
        if (assetMeta[idx]) {
          allMids[assetMeta[idx].name] = parseFloat(ctx.markPx);
        }
      });
    }
  }
  return assetMeta;
}

// Get user's clearinghouse state (positions)
async function getUserState(address) {
  return await hlPost({ 
    type: 'clearinghouseState', 
    user: address 
  });
}

// Calculate distance to liquidation
function calculateLiqDistance(position, currentPrice) {
  const liqPrice = parseFloat(position.liquidationPx);
  const entryPrice = parseFloat(position.entryPx);
  const markPrice = currentPrice || parseFloat(position.positionValue) / Math.abs(parseFloat(position.szi));
  
  if (!liqPrice || liqPrice === 0 || !markPrice) return null;
  
  // Distance as percentage
  const distance = Math.abs(liqPrice - markPrice) / markPrice;
  
  // Determine direction (long or short)
  const isLong = parseFloat(position.szi) > 0;
  
  return {
    distance: distance,
    distancePercent: distance * 100,
    isLong,
    liqPrice,
    markPrice,
    entryPrice,
    // For longs, liquidation is below current price
    // For shorts, liquidation is above current price
    direction: isLong ? 'LONG' : 'SHORT',
    inDanger: isLong ? (markPrice <= liqPrice * 1.1) : (markPrice >= liqPrice * 0.9)
  };
}

// Process a position and check if it meets our criteria
function processPosition(userAddress, position, currentPrice, accountData = null) {
  const coin = position.coin;
  const positionValue = Math.abs(parseFloat(position.positionValue));
  const szi = parseFloat(position.szi);
  const leverage = position.leverage?.value || 1;
  const marginUsed = parseFloat(position.marginUsed);
  const unrealizedPnl = parseFloat(position.unrealizedPnl);
  const liqPx = parseFloat(position.liquidationPx);
  const entryPx = parseFloat(position.entryPx);
  
  // Get current mark price
  const markPrice = currentPrice || allMids[coin];
  
  if (!markPrice || !liqPx) return null;
  
  // Calculate position value in USD using mark price
  const positionUSD = Math.abs(szi) * markPrice;
  
  // Skip if position is too small
  if (positionUSD < CONFIG.MIN_POSITION_USD) return null;
  
  // Calculate distance to liquidation
  const isLong = szi > 0;
  let distanceToLiq;
  
  if (isLong) {
    // For longs, liq price is below current price
    distanceToLiq = (markPrice - liqPx) / markPrice;
  } else {
    // For shorts, liq price is above current price  
    distanceToLiq = (liqPx - markPrice) / markPrice;
  }
  
  // Only track positions within 10% of liquidation
  if (distanceToLiq > CONFIG.DANGER_THRESHOLD_10 || distanceToLiq < 0) return null;
  
  // Determine danger level
  let dangerLevel = 'WARNING'; // 5-10%
  if (distanceToLiq <= CONFIG.DANGER_THRESHOLD_5) {
    dangerLevel = 'CRITICAL'; // <5%
  }
  
  // Extract wallet balance and calculate total PnL from account data
  let walletBalance = null;
  let totalPositionValue = 0;
  let otherPositions = [];
  let totalUnrealizedPnl = 0; // Tüm pozisyonların toplam PnL'i
  let isProfitableWhale = false;
  
  if (accountData) {
    walletBalance = parseFloat(accountData.marginSummary?.accountValue || 0);
    
    // Get all other positions and calculate total PnL
    if (accountData.assetPositions) {
      accountData.assetPositions.forEach(ap => {
        const p = ap.position;
        const pSzi = parseFloat(p.szi);
        if (pSzi !== 0) {
          const pMarkPrice = allMids[p.coin] || 0;
          const pValue = Math.abs(pSzi) * pMarkPrice;
          const pPnl = parseFloat(p.unrealizedPnl) || 0;
          
          totalPositionValue += pValue;
          totalUnrealizedPnl += pPnl;
          
          // Add to other positions if not the main one
          if (p.coin !== coin) {
            otherPositions.push({
              coin: p.coin,
              direction: pSzi > 0 ? 'LONG' : 'SHORT',
              size: pSzi,
              positionUSD: pValue,
              entryPrice: parseFloat(p.entryPx),
              markPrice: pMarkPrice,
              liqPrice: parseFloat(p.liquidationPx),
              leverage: p.leverage?.value || 1,
              unrealizedPnl: pPnl,
              marginUsed: parseFloat(p.marginUsed)
            });
          }
        }
      });
    }
    
    // Determine if profitable whale
    isProfitableWhale = totalUnrealizedPnl > 0;
  }
  
  return {
    user: userAddress,
    userShort: `${userAddress.slice(0, 6)}...${userAddress.slice(-4)}`,
    coin,
    direction: isLong ? 'LONG' : 'SHORT',
    positionSize: szi,
    positionUSD: positionUSD,
    entryPrice: entryPx,
    markPrice: markPrice,
    liqPrice: liqPx,
    distanceToLiq: distanceToLiq,
    distancePercent: (distanceToLiq * 100).toFixed(2),
    leverage: leverage,
    marginUsed: marginUsed,
    unrealizedPnl: unrealizedPnl,
    pnlPercent: ((unrealizedPnl / marginUsed) * 100).toFixed(2),
    dangerLevel: dangerLevel,
    timestamp: Date.now(),
    // Wallet info
    walletBalance: walletBalance,
    totalPositionValue: totalPositionValue,
    otherPositions: otherPositions,
    totalPositionCount: otherPositions.length + 1,
    // Total PnL across all positions
    totalUnrealizedPnl: totalUnrealizedPnl,
    isProfitableWhale: isProfitableWhale,
    whaleType: isProfitableWhale ? 'PROFITABLE' : 'LOSING',
    // Yeni adres mi kontrolü - son 5 dakika içinde eklendiyse "yeni"
    isNewAddress: (Date.now() - (addressLastSeen.get(userAddress.toLowerCase()) || 0)) < 300000,
    firstSeenAgo: addressLastSeen.get(userAddress.toLowerCase()) 
      ? Math.floor((Date.now() - addressLastSeen.get(userAddress.toLowerCase())) / 1000 / 60)
      : null,
    hyperliquidUrl: `https://app.hyperliquid.xyz/explorer/address/${userAddress}`
  };
}

// Known whale addresses to monitor - discovered automatically from trades
let knownWhaleAddresses = new Set();
let addressLastSeen = new Map(); // Track when we last saw activity from an address
let addressTradeVolume = new Map(); // Track cumulative trade volume per address

// ============================================
// COINGLASS API INTEGRATION (Opsiyonel)
// ============================================
async function fetchCoinglassWhales() {
  if (!CONFIG.COINGLASS_API_KEY) {
    console.log('Coinglass API key not set, skipping whale fetch');
    return [];
  }
  
  try {
    const response = await axios.get(`${CONFIG.COINGLASS_API}/api/hyperliquid/whale-position`, {
      headers: {
        'coinglassSecret': CONFIG.COINGLASS_API_KEY
      }
    });
    
    if (response.data && response.data.data) {
      const whales = response.data.data;
      console.log(`Fetched ${whales.length} whale positions from Coinglass`);
      
      // Add all whale addresses to tracking
      whales.forEach(w => {
        if (w.user) {
          knownWhaleAddresses.add(w.user.toLowerCase());
        }
      });
      
      return whales;
    }
  } catch (error) {
    console.error('Coinglass API Error:', error.message);
  }
  return [];
}

// ============================================
// TRADE MONITORING - TÜM İŞLEMLERİ DİNLE
// ============================================
let ws = null;
let wsReconnectTimeout = null;
let allCoins = []; // Tüm coinler

function connectWebSocket() {
  if (ws) {
    try { ws.close(); } catch(e) {}
  }
  
  ws = new WebSocket(CONFIG.HYPERLIQUID_WS);
  
  ws.on('open', () => {
    console.log('🔌 WebSocket connected - subscribing to ALL trades...');
    
    // Subscribe to all mids for price updates
    ws.send(JSON.stringify({
      method: 'subscribe',
      subscription: { type: 'allMids' }
    }));
    
    // Subscribe to liquidations - TÜM LİKİDASYONLARI DİNLE
    ws.send(JSON.stringify({
      method: 'subscribe',
      subscription: { type: 'activeAssetCtx', coin: 'BTC' } // For liquidation data
    }));
    
    // Subscribe to trades for ALL coins
    if (allCoins.length > 0) {
      allCoins.forEach(coin => {
        ws.send(JSON.stringify({
          method: 'subscribe',
          subscription: { type: 'trades', coin: coin.name }
        }));
      });
      console.log(`📡 Subscribed to ${allCoins.length} coin trade streams`);
    } else {
      // Fallback - major coins
      const majorCoins = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP', 'HYPE', 'SUI', 'AVAX', 'LINK', 'ARB', 'OP', 'MATIC', 'APT', 'INJ', 'TIA', 'SEI', 'JUP', 'WIF', 'PEPE', 'BONK'];
      majorCoins.forEach(coin => {
        ws.send(JSON.stringify({
          method: 'subscribe',
          subscription: { type: 'trades', coin }
        }));
      });
      console.log(`📡 Subscribed to ${majorCoins.length} major coin trade streams`);
    }
  });
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      
      // Price updates
      if (msg.channel === 'allMids' && msg.data?.mids) {
        for (const [coin, price] of Object.entries(msg.data.mids)) {
          allMids[coin] = parseFloat(price);
        }
      }
      
      // TRADE MONITORING - Ana özellik!
      if (msg.channel === 'trades' && msg.data) {
<<<<<<< HEAD
=======
        // Debug: İlk birkaç trade'i logla
        if (msg.data.length > 0) {
          const firstTrade = msg.data[0];
          const value = parseFloat(firstTrade.sz || 0) * parseFloat(firstTrade.px || 0);
          if (value >= 50000) {
            console.log(`📈 Trade: ${firstTrade.coin} | $${(value/1000).toFixed(0)}k | crossed: ${firstTrade.crossed}`);
          }
        }
        
>>>>>>> 99e8202b548d16c039de71c8bb695510157d27f6
        processTrades(msg.data);
        
        // Check for liquidation trades
        processLiquidations(msg.data);
      }
    } catch (err) {
      // Ignore parse errors
    }
  });
  
  ws.on('close', () => {
    console.log('WebSocket disconnected, reconnecting in 3s...');
    wsReconnectTimeout = setTimeout(connectWebSocket, 3000);
  });
  
  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
}

// Process incoming trades - discover whales
function processTrades(trades) {
  for (const trade of trades) {
    const tradeValue = parseFloat(trade.sz) * parseFloat(trade.px);
    
    // $100k+ trade = potential whale
    if (tradeValue >= CONFIG.MIN_TRADE_USD) {
      const now = Date.now();
      
      // Track both buyer and seller
      if (trade.users && trade.users.length === 2) {
        const [buyer, seller] = trade.users;
        
        for (const addr of [buyer, seller]) {
          if (addr && addr !== '0x0000000000000000000000000000000000000000') {
            const addrLower = addr.toLowerCase();
            const isNewWhale = !knownWhaleAddresses.has(addrLower);
            
            // Add to tracking set
            knownWhaleAddresses.add(addrLower);
            
            // Update last seen
            addressLastSeen.set(addrLower, now);
            
            // Update cumulative volume
            const currentVol = addressTradeVolume.get(addrLower) || 0;
            addressTradeVolume.set(addrLower, currentVol + tradeValue);
            
            // ⚡ INSTANT CHECK: Büyük trade ise HEMEN pozisyonu kontrol et!
            if (tradeValue >= 500000) { // $500k+ = anında kontrol
              console.log(`🐋 ${isNewWhale ? 'NEW ' : ''}WHALE TRADE: ${addrLower.slice(0,10)}... | ${trade.coin} | $${(tradeValue/1000000).toFixed(2)}M`);
              
              // Async olarak hemen kontrol et
              checkAddressImmediately(addrLower, trade.coin, tradeValue, isNewWhale);
            } else if (isNewWhale) {
              console.log(`🐋 New whale: ${addrLower.slice(0,10)}... | ${trade.coin} | $${(tradeValue/1000).toFixed(0)}k`);
            }
          }
        }
      }
    }
  }
  
  // Cleanup old addresses
  cleanupOldAddresses();
}

// ============================================
// LIQUIDATION DETECTION
// ============================================
// İki kaynak kullanıyoruz:
// 1. Trade stream'den crossed=true olanlar (gerçek zamanlı)
// 2. Hyperliquid liquidatable API (periyodik)

const KNOWN_LIQUIDATOR_VAULTS = [
  '0x2e3f42c178ee5a23a3e1e853e8de02e0a6e5c6c1', // HLP Liquidator
];

// Fetch liquidatable positions from API
async function fetchLiquidatablePositions() {
  try {
    const response = await axios.post(CONFIG.HYPERLIQUID_API, {
      type: 'liquidatable'
    });
    
    if (response.data && Array.isArray(response.data)) {
      console.log(`📊 Found ${response.data.length} liquidatable positions`);
      return response.data;
    }
    return [];
  } catch (error) {
    console.error('Error fetching liquidatable positions:', error.message);
    return [];
  }
}

function processLiquidations(trades) {
  if (!trades || !Array.isArray(trades)) return;
  
  for (const trade of trades) {
    try {
      const sz = parseFloat(trade.sz || 0);
      const px = parseFloat(trade.px || 0);
      if (!sz || !px) continue;
      
      const tradeValue = Math.abs(sz) * px;
      
<<<<<<< HEAD
      // SADECE crossed=true olan işlemler likidasyon olabilir
      // crossed = taker order (market order) - likidasyonlar HER ZAMAN market order
      // Normal limit order'lar crossed=false olur
      const isCrossed = trade.crossed === true;
      
      // SADECE crossed trade'leri liq olarak say
      // Ve minimum $50k threshold (çok küçük liq'leri atlayalım)
      if (isCrossed && tradeValue >= 50000) {
        const liq = {
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          coin: trade.coin,
=======
      // Hyperliquid'de crossed=true olan işlemler market order (taker)
      // Likidasyonlar her zaman market order ile yapılır
      // NOT: Bazen crossed field gelmeyebilir, büyük ani işlemleri de dahil edelim
      const isCrossed = trade.crossed === true;
      
      // $5k+ crossed trade = potansiyel likidasyon (daha düşük threshold)
      // VEYA $50k+ herhangi bir trade (büyük market order = muhtemel liq)
      const isLiquidation = (isCrossed && tradeValue >= 5000) || tradeValue >= 50000;
      
      if (isLiquidation) {
        const liq = {
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          coin: trade.coin,
          // Buyer (B) aldıysa, bir short likidasyona uğradı
          // Seller (A) sattıysa, bir long likidasyona uğradı
>>>>>>> 99e8202b548d16c039de71c8bb695510157d27f6
          side: trade.side === 'B' ? 'SHORT' : 'LONG',
          price: px,
          size: Math.abs(sz),
          value: tradeValue,
          timestamp: trade.time || Date.now(),
          hash: trade.hash || null,
<<<<<<< HEAD
        };
        
        // Duplicate kontrolü (son 3 saniye içinde aynı coin + benzer value)
        const isDuplicate = recentLiquidations.some(l => 
          l.coin === liq.coin && 
          Math.abs(l.value - liq.value) < 1000 && 
          Math.abs(l.timestamp - liq.timestamp) < 3000
        );
        
        if (!isDuplicate) {
=======
          crossed: isCrossed
        };
        
        // Duplicate kontrolü (son 2 saniye içinde aynı coin/value)
        const isDuplicate = recentLiquidations.some(l => 
          l.coin === liq.coin && 
          Math.abs(l.value - liq.value) < 100 && 
          Math.abs(l.timestamp - liq.timestamp) < 2000
        );
        
        if (!isDuplicate) {
          // Add to all liquidations
>>>>>>> 99e8202b548d16c039de71c8bb695510157d27f6
          recentLiquidations.unshift(liq);
          if (recentLiquidations.length > MAX_LIQUIDATIONS) {
            recentLiquidations = recentLiquidations.slice(0, MAX_LIQUIDATIONS);
          }
          
          // Whale liq ($500k+)
          if (tradeValue >= 500000) {
            recentWhaleLiquidations.unshift(liq);
            if (recentWhaleLiquidations.length > 50) {
              recentWhaleLiquidations = recentWhaleLiquidations.slice(0, 50);
            }
            console.log(`🐋💀 WHALE LIQ: ${liq.coin} ${liq.side} | $${(tradeValue/1000000).toFixed(2)}M @ $${px.toFixed(2)}`);
<<<<<<< HEAD
          } else if (tradeValue >= 100000) {
=======
          } else if (tradeValue >= 50000) {
>>>>>>> 99e8202b548d16c039de71c8bb695510157d27f6
            console.log(`💀 LIQ: ${liq.coin} ${liq.side} | $${(tradeValue/1000).toFixed(0)}k @ $${px.toFixed(2)}`);
          }
        }
      }
    } catch (err) {
      // Skip malformed trades
    }
  }
}

// ⚡ INSTANT POSITION CHECK - Büyük trade yapan adresi hemen tara
async function checkAddressImmediately(address, tradeCoin, tradeValue, isNewAddress) {
  try {
    const state = await getUserState(address);
    
    if (state && state.assetPositions && state.assetPositions.length > 0) {
      let foundHighRisk = false;
      
      for (const assetPos of state.assetPositions) {
        const pos = assetPos.position;
        // Pass full account data
        const processed = processPosition(address, pos, allMids[pos.coin], state);
        
        if (processed) {
          foundHighRisk = true;
          
          // Check if already in tracked positions
          const existingIdx = trackedPositions.findIndex(
            p => p.user === address && p.coin === pos.coin
          );
          
          const isNewPosition = existingIdx < 0;
          
          if (existingIdx >= 0) {
            // Update existing
            trackedPositions[existingIdx] = processed;
          } else {
            // Add new - en başa ekle görünürlük için
            trackedPositions.unshift(processed);
          }
          
          // 🚨 ALERT for high-risk positions
          const emoji = processed.dangerLevel === 'CRITICAL' ? '🚨🚨🚨' : '⚠️';
          console.log(`${emoji} INSTANT DETECT: ${processed.userShort} | ${processed.coin} ${processed.direction}`);
          console.log(`   💰 Size: $${(processed.positionUSD/1000000).toFixed(2)}M | ⚡ Lev: ${processed.leverage}x | 📍 Distance: ${processed.distancePercent}%`);
          console.log(`   💼 Wallet: $${(processed.walletBalance/1000).toFixed(0)}k | 📊 Total Positions: ${processed.totalPositionCount}`);
          
          if (isNewAddress) {
            console.log(`   🆕 YENİ ADRES - Muhtemel insider/kumarbaz!`);
          }
          
          // 📨 Send Telegram & Twitter alerts for new critical positions
          if (isNewPosition || isNewAddress) {
            sendAlerts(processed);
          }
        }
      }
      
      // Re-sort by danger level
      if (foundHighRisk) {
        trackedPositions.sort((a, b) => a.distanceToLiq - b.distanceToLiq);
      }
    }
  } catch (err) {
    // Silently ignore - regular scan'de yakalanır
  }
}

// Remove stale addresses to keep memory manageable
function cleanupOldAddresses() {
  const now = Date.now();
  const oneDayAgo = now - (24 * 60 * 60 * 1000);
  
  if (knownWhaleAddresses.size > CONFIG.MAX_ADDRESSES_TO_SCAN) {
    // Sort by volume and keep top addresses
    const addressVolumes = [...addressTradeVolume.entries()]
      .sort((a, b) => b[1] - a[1]);
    
    // Keep top 80% by volume
    const keepCount = Math.floor(CONFIG.MAX_ADDRESSES_TO_SCAN * 0.8);
    const keepSet = new Set(addressVolumes.slice(0, keepCount).map(x => x[0]));
    
    // Remove addresses not in keep set
    for (const addr of knownWhaleAddresses) {
      const lastSeen = addressLastSeen.get(addr) || 0;
      if (!keepSet.has(addr) && lastSeen < oneDayAgo) {
        knownWhaleAddresses.delete(addr);
        addressLastSeen.delete(addr);
        addressTradeVolume.delete(addr);
      }
    }
  }
}

// ============================================
// BATCH POSITION SCANNING
// ============================================

// Scan positions for a list of addresses with rate limiting
async function scanPositions(addresses) {
  const results = [];
  const batchSize = 10; // Scan 10 addresses at a time
  const delayBetweenBatches = 500; // 500ms delay between batches
  
  for (let i = 0; i < addresses.length; i += batchSize) {
    const batch = addresses.slice(i, i + batchSize);
    
    const batchPromises = batch.map(async (address) => {
      try {
        const state = await getUserState(address);
        if (state && state.assetPositions) {
          const positions = [];
          for (const assetPos of state.assetPositions) {
            const pos = assetPos.position;
            // Pass full account data for wallet balance and other positions
            const processed = processPosition(address, pos, allMids[pos.coin], state);
            if (processed) {
              positions.push(processed);
            }
          }
          return positions;
        }
      } catch (err) {
        // Silently ignore individual address errors
      }
      return [];
    });
    
    const batchResults = await Promise.all(batchPromises);
    batchResults.forEach(posArray => {
      results.push(...posArray);
    });
    
    // Small delay to avoid rate limiting
    if (i + batchSize < addresses.length) {
      await new Promise(r => setTimeout(r, delayBetweenBatches));
    }
  }
  
  return results.sort((a, b) => a.distanceToLiq - b.distanceToLiq);
}

// Initialize
async function initialize() {
  console.log('🚀 Initializing Hyperliquid Liquidation Hunter...');
  console.log('📊 Config:', {
    minPositionUSD: `$${(CONFIG.MIN_POSITION_USD / 1000000).toFixed(0)}M`,
    minTradeUSD: `$${(CONFIG.MIN_TRADE_USD / 1000).toFixed(0)}k`,
    dangerThresholds: '5% / 10%'
  });
  
  // Get asset metadata and initial prices
  await getAssetMeta();
  allCoins = assetMeta;
  console.log(`✅ Loaded ${assetMeta.length} tradeable assets`);
  
  // Try to fetch from Coinglass first (if API key available)
  if (CONFIG.COINGLASS_API_KEY) {
    await fetchCoinglassWhales();
  }
  
  // Connect WebSocket to start discovering whales from live trades
  connectWebSocket();
  
  // Wait a bit for initial whale discovery
  console.log('⏳ Waiting 5s for initial whale discovery from live trades...');
  await new Promise(r => setTimeout(r, 5000));
  
  // Initial scan
  await refreshPositions();
  
  // Set up periodic refresh
  setInterval(refreshPositions, CONFIG.REFRESH_INTERVAL);
  
  // Periodically fetch from Coinglass (every 5 min)
  if (CONFIG.COINGLASS_API_KEY) {
    setInterval(fetchCoinglassWhales, 5 * 60 * 1000);
  }
}

async function refreshPositions() {
  const addressCount = knownWhaleAddresses.size;
  
  if (addressCount === 0) {
    console.log('⚠️ No whale addresses discovered yet. Waiting for trades...');
    return;
  }
  
  console.log(`🔍 Scanning ${addressCount} addresses for high-risk positions...`);
  const startTime = Date.now();
  
  trackedPositions = await scanPositions([...knownWhaleAddresses]);
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const criticalCount = trackedPositions.filter(p => p.dangerLevel === 'CRITICAL').length;
  const warningCount = trackedPositions.filter(p => p.dangerLevel === 'WARNING').length;
  
  console.log(`✅ Scan complete in ${elapsed}s | Found: ${criticalCount} CRITICAL, ${warningCount} WARNING, ${trackedPositions.length} total`);
  
  // Alert for new critical positions
  trackedPositions.filter(p => p.dangerLevel === 'CRITICAL').forEach(p => {
    console.log(`🚨 CRITICAL: ${p.userShort} | ${p.coin} ${p.direction} | $${(p.positionUSD/1000000).toFixed(1)}M | ${p.distancePercent}% to liq`);
  });
}

// API Routes
app.get('/api/positions', (req, res) => {
  const { minSize, maxDistance, dangerLevel } = req.query;
  
  let filtered = [...trackedPositions];
  
  if (minSize) {
    filtered = filtered.filter(p => p.positionUSD >= parseFloat(minSize));
  }
  
  if (maxDistance) {
    filtered = filtered.filter(p => p.distanceToLiq <= parseFloat(maxDistance) / 100);
  }
  
  if (dangerLevel) {
    filtered = filtered.filter(p => p.dangerLevel === dangerLevel);
  }
  
  // Separate longs and shorts
  const longs = filtered.filter(p => p.direction === 'LONG').sort((a, b) => a.distanceToLiq - b.distanceToLiq);
  const shorts = filtered.filter(p => p.direction === 'SHORT').sort((a, b) => a.distanceToLiq - b.distanceToLiq);
  
  // Calculate totals
  const longsAtRisk = longs.reduce((sum, p) => sum + p.positionUSD, 0);
  const shortsAtRisk = shorts.reduce((sum, p) => sum + p.positionUSD, 0);
  
  // Count by whale type
  const profitableLongs = longs.filter(p => p.isProfitableWhale).length;
  const losingLongs = longs.filter(p => !p.isProfitableWhale).length;
  const profitableShorts = shorts.filter(p => p.isProfitableWhale).length;
  const losingShorts = shorts.filter(p => !p.isProfitableWhale).length;
  
  res.json({
    count: filtered.length,
    lastUpdate: Date.now(),
    // Separated positions
    longs: longs,
    shorts: shorts,
    // Totals
    longsAtRisk: longsAtRisk,
    shortsAtRisk: shortsAtRisk,
    longsCount: longs.length,
    shortsCount: shorts.length,
    // Whale type breakdown
    profitableLongs,
    losingLongs,
    profitableShorts,
    losingShorts,
    // Legacy - all positions
    positions: filtered
  });
});

app.get('/api/prices', (req, res) => {
  res.json(allMids);
});

// Recent liquidations endpoint
app.get('/api/liquidations', (req, res) => {
  const { minValue, coin, side, limit } = req.query;
  
  let filtered = [...recentLiquidations];
  
  if (minValue) {
    filtered = filtered.filter(l => l.value >= parseFloat(minValue));
  }
  
  if (coin) {
    filtered = filtered.filter(l => l.coin === coin.toUpperCase());
  }
  
  if (side) {
    filtered = filtered.filter(l => l.side === side.toUpperCase());
  }
  
  const limitNum = parseInt(limit) || 50;
  filtered = filtered.slice(0, limitNum);
  
  // Calculate stats
  const totalValue = filtered.reduce((sum, l) => sum + l.value, 0);
  const longLiqs = filtered.filter(l => l.side === 'LONG');
  const shortLiqs = filtered.filter(l => l.side === 'SHORT');
  const longValue = longLiqs.reduce((sum, l) => sum + l.value, 0);
  const shortValue = shortLiqs.reduce((sum, l) => sum + l.value, 0);
  
  res.json({
    count: filtered.length,
    totalValue,
    longCount: longLiqs.length,
    shortCount: shortLiqs.length,
    longValue,
    shortValue,
    liquidations: filtered,
    lastUpdate: Date.now()
  });
});

// Whale liquidations endpoint (ayrı - $500k+)
app.get('/api/whale-liquidations', (req, res) => {
  const { coin, side, limit } = req.query;
  
  let filtered = [...recentWhaleLiquidations];
  
  if (coin) {
    filtered = filtered.filter(l => l.coin === coin.toUpperCase());
  }
  
  if (side) {
    filtered = filtered.filter(l => l.side === side.toUpperCase());
  }
  
  const limitNum = parseInt(limit) || 20;
  filtered = filtered.slice(0, limitNum);
  
  const totalValue = filtered.reduce((sum, l) => sum + l.value, 0);
  const longValue = filtered.filter(l => l.side === 'LONG').reduce((sum, l) => sum + l.value, 0);
  const shortValue = filtered.filter(l => l.side === 'SHORT').reduce((sum, l) => sum + l.value, 0);
  
  res.json({
    count: filtered.length,
    totalValue,
    longValue,
    shortValue,
    liquidations: filtered,
    lastUpdate: Date.now()
  });
});

app.get('/api/stats', (req, res) => {
  const criticalCount = trackedPositions.filter(p => p.dangerLevel === 'CRITICAL').length;
  const warningCount = trackedPositions.filter(p => p.dangerLevel === 'WARNING').length;
  const totalValueAtRisk = trackedPositions.reduce((sum, p) => sum + p.positionUSD, 0);
  
  const byCoin = {};
  trackedPositions.forEach(p => {
    if (!byCoin[p.coin]) {
      byCoin[p.coin] = { count: 0, value: 0, longs: 0, shorts: 0 };
    }
    byCoin[p.coin].count++;
    byCoin[p.coin].value += p.positionUSD;
    if (p.direction === 'LONG') byCoin[p.coin].longs++;
    else byCoin[p.coin].shorts++;
  });
  
  // Top whales by trading volume
  const topWhales = [...addressTradeVolume.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([addr, vol]) => ({
      address: addr,
      addressShort: `${addr.slice(0,6)}...${addr.slice(-4)}`,
      volume: vol,
      lastSeen: addressLastSeen.get(addr)
    }));
  
  res.json({
    totalPositions: trackedPositions.length,
    criticalCount,
    warningCount,
    totalValueAtRisk,
    addressesTracked: knownWhaleAddresses.size,
    byCoin,
    topWhales,
    config: {
      minPositionUSD: CONFIG.MIN_POSITION_USD,
      minTradeUSD: CONFIG.MIN_TRADE_USD,
      dangerThreshold5: CONFIG.DANGER_THRESHOLD_5,
      dangerThreshold10: CONFIG.DANGER_THRESHOLD_10,
    },
    coinglassEnabled: !!CONFIG.COINGLASS_API_KEY,
    lastUpdate: Date.now()
  });
});

app.post('/api/add-address', (req, res) => {
  const { address } = req.body;
  if (address && address.startsWith('0x') && address.length === 42) {
    knownWhaleAddresses.add(address.toLowerCase());
    res.json({ success: true, message: 'Address added for tracking' });
  } else {
    res.status(400).json({ error: 'Invalid address format' });
  }
});

app.get('/api/check-address/:address', async (req, res) => {
  const { address } = req.params;
  try {
    const state = await getUserState(address);
    if (state && state.assetPositions) {
      const positions = [];
      for (const assetPos of state.assetPositions) {
        const pos = assetPos.position;
        const markPrice = allMids[pos.coin];
        const szi = parseFloat(pos.szi);
        const liqPx = parseFloat(pos.liquidationPx);
        
        if (szi === 0) continue;
        
        const positionUSD = Math.abs(szi) * (markPrice || parseFloat(pos.positionValue) / Math.abs(szi));
        const isLong = szi > 0;
        let distanceToLiq = isLong 
          ? (markPrice - liqPx) / markPrice 
          : (liqPx - markPrice) / markPrice;
        
        positions.push({
          coin: pos.coin,
          direction: isLong ? 'LONG' : 'SHORT',
          positionSize: szi,
          positionUSD,
          entryPrice: parseFloat(pos.entryPx),
          markPrice,
          liqPrice: liqPx,
          distancePercent: (distanceToLiq * 100).toFixed(2),
          leverage: pos.leverage?.value,
          unrealizedPnl: parseFloat(pos.unrealizedPnl)
        });
      }
      res.json({
        address,
        accountValue: state.marginSummary?.accountValue,
        positions
      });
    } else {
      res.json({ address, positions: [] });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  initialize();
});
