require('dotenv').config();
const WebSocket = require('ws');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const OAuth = require('oauth-1.0a');
const http = require('http');

// ============================================
// CONFIG
// ============================================
const CONFIG = {
  HYPERLIQUID_API: 'https://api.hyperliquid.xyz/info',
  HYPERLIQUID_WS: 'wss://api.hyperliquid.xyz/ws',
  MIN_TRADE_USD: 200000, // $200K minimum trade to check
  MIN_POSITION_USD: 2000000, // $2M minimum position for notification
  MAX_DISTANCE_PERCENT: 10, // 10% max distance to liquidation
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  TWITTER_API_KEY: process.env.TWITTER_API_KEY,
  TWITTER_API_SECRET: process.env.TWITTER_API_SECRET,
  TWITTER_ACCESS_TOKEN: process.env.TWITTER_ACCESS_TOKEN,
  TWITTER_ACCESS_SECRET: process.env.TWITTER_ACCESS_SECRET,
  DATABASE_URL: process.env.DATABASE_URL
};

// Initialize Telegram Bot
let telegramBot = null;
if (CONFIG.TELEGRAM_BOT_TOKEN && CONFIG.TELEGRAM_CHAT_ID) {
  telegramBot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { polling: false });
  console.log('✅ Telegram bot initialized');
}

// Initialize Twitter OAuth
let twitter = null;
if (CONFIG.TWITTER_API_KEY && CONFIG.TWITTER_ACCESS_TOKEN) {
  const oauth = OAuth({
    consumer: { key: CONFIG.TWITTER_API_KEY, secret: CONFIG.TWITTER_API_SECRET },
    signature_method: 'HMAC-SHA1',
    hash_function(base_string, key) {
      return crypto.createHmac('sha1', key).update(base_string).digest('base64');
    }
  });
  const token = { key: CONFIG.TWITTER_ACCESS_TOKEN, secret: CONFIG.TWITTER_ACCESS_SECRET };
  twitter = { oauth, token };
  console.log('✅ Twitter OAuth initialized');
}

// ============================================
// DATABASE (Optional - for tracking sent notifications)
// ============================================
let dbClient = null;
if (CONFIG.DATABASE_URL) {
  const { Client } = require('pg');
  dbClient = new Client({ connectionString: CONFIG.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  dbClient.connect()
    .then(() => console.log('✅ PostgreSQL connected'))
    .catch(err => console.log('⚠️ PostgreSQL not available:', err.message));
}

// ============================================
// PRICE CACHE
// ============================================
let allMids = {};

async function updatePrices() {
  try {
    const response = await axios.post(CONFIG.HYPERLIQUID_API, { type: 'allMids' });
    if (response.data) {
      allMids = response.data;
    }
  } catch (err) {
    console.error('Price update error:', err.message);
  }
}

// ============================================
// NOTIFICATION TRACKING
// ============================================
const sentAlerts = new Map(); // address-coin -> timestamp
const ALERT_COOLDOWN = 24 * 60 * 60 * 1000; // 24 hours

function shouldSendAlert(address, coin) {
  const key = `${address.toLowerCase()}-${coin}`;
  const lastSent = sentAlerts.get(key);
  if (!lastSent) return true;
  return (Date.now() - lastSent) > ALERT_COOLDOWN;
}

function markAlertSent(address, coin) {
  const key = `${address.toLowerCase()}-${coin}`;
  sentAlerts.set(key, Date.now());
}

// ============================================
// HYPERLIQUID API
// ============================================
async function getUserState(address) {
  try {
    const response = await axios.post(CONFIG.HYPERLIQUID_API, {
      type: 'clearinghouseState',
      user: address
    });
    return response.data;
  } catch (err) {
    return null;
  }
}

// ============================================
// TELEGRAM NOTIFICATION
// ============================================
async function sendTelegramAlert(position) {
  if (!telegramBot) return;

  try {
    const isLong = position.direction === 'LONG';
    const isCritical = position.distancePercent < 5;
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

      if (pnlValue > 0) {
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
    lines.push('🔗 [View on Hypurrscan](' + getHypurrscanUrl(position.user) + ')');

    const message = lines.join('\n');

    await telegramBot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });

    console.log('✅ Telegram alert sent:', position.coin, position.direction);
  } catch (err) {
    console.error('Telegram error:', err.message);
  }
}

// ============================================
// TWITTER NOTIFICATION
// ============================================
async function sendTwitterAlert(position) {
  if (!twitter) return;

  try {
    const isLong = position.direction === 'LONG';
    const isCritical = position.distancePercent < 5;
    const ageDays = position.walletAgeDays;
    const isBrandNew = ageDays !== null && ageDays === 0;
    const isNewWallet = ageDays !== null && ageDays < 7;
    const isShitcoinBet = isShitcoin(position.coin) && position.positionUSD >= 2000000;
    const isPotentialVaultAttack = isShitcoin(position.coin) && position.positionUSD >= 10000000;

    let lines = [];

    // Header
    if (isPotentialVaultAttack) {
      lines.push('🚨🚨🚨 HYPERVAULT ATTACK ALERT 🚨🚨🚨\n');
    } else if (isShitcoinBet) {
      lines.push('🎰 DEGEN WHALE SPOTTED 🎰\n');
    } else if (isBrandNew) {
      lines.push('👶🔥 FRESH WALLET ALERT 🔥👶');
      lines.push('⚠️ Possible insider/exploit\n');
    }

    const dirIcon = isLong ? '🟢' : '🔴';
    const dangerIcon = isCritical ? '💀' : '⚠️';

    lines.push(dangerIcon + ' ' + position.coin + ' ' + position.direction);

    // Whale history
    if (position.allTimePnl !== null) {
      const pnlValue = position.allTimePnl;
      const pnlAbs = Math.abs(pnlValue);
      let pnlStr = pnlAbs >= 1000000 ? '$' + (pnlAbs / 1000000).toFixed(2) + 'M' : '$' + (pnlAbs / 1000).toFixed(0) + 'K';

      if (pnlValue > 0) {
        lines.push('👑 WINNER WHALE (+' + pnlStr + ')');
      } else {
        lines.push('🎲 LOSER WHALE (-' + pnlStr + ')');
      }
    }

    lines.push('');
    lines.push('💎 Size: $' + (position.positionUSD / 1000000).toFixed(2) + 'M');
    lines.push('⚡ ' + position.leverage + 'x leverage');
    lines.push('🎯 Distance: ' + position.distancePercent + '%');
    lines.push('💀 Liq: $' + formatPriceCompact(position.liqPrice));

    if (isBrandNew) {
      lines.push('\n🆕 BRAND NEW WALLET (<1 day)');
    } else if (isNewWallet) {
      lines.push('\n👶 Wallet: ' + ageDays + ' days old');
    } else if (ageDays !== null) {
      lines.push('\n🕐 Wallet: ' + formatWalletAge(ageDays));
    }

    lines.push('\n' + getHypurrscanUrl(position.user));

    const tweet = lines.join('\n');

    const requestData = {
      url: 'https://api.twitter.com/2/tweets',
      method: 'POST',
      data: { text: tweet }
    };

    const authHeader = twitter.oauth.toHeader(twitter.oauth.authorize(requestData, twitter.token));

    await axios.post(requestData.url, requestData.data, {
      headers: {
        ...authHeader,
        'Content-Type': 'application/json'
      }
    });

    console.log('✅ Twitter alert sent:', position.coin, position.direction);
  } catch (err) {
    console.error('Twitter error:', err.message);
  }
}

// ============================================
// HELPERS
// ============================================
const TOP_COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'DOT', 'MATIC', 'LINK', 'NEAR'];

function isShitcoin(coin) {
  return !TOP_COINS.includes(coin.toUpperCase());
}

function getHypurrscanUrl(address) {
  return `https://hypurrscan.io/address/${address}`;
}

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
  if (days < 7) return `${days} day${days === 1 ? '' : 's'}`;
  if (days < 30) return `${Math.floor(days)} days`;
  if (days < 365) return `${Math.floor(days / 30)} months`;
  return `${Math.floor(days / 365)} years`;
}

// ============================================
// POSITION PROCESSING
// ============================================
async function checkPosition(address, coin) {
  try {
    const state = await getUserState(address);
    if (!state || !state.assetPositions) return;

    for (const assetPos of state.assetPositions) {
      const pos = assetPos.position;
      if (pos.coin !== coin) continue;

      const szi = parseFloat(pos.szi);
      if (szi === 0) continue;

      const markPrice = allMids[pos.coin];
      if (!markPrice) continue;

      const positionUSD = Math.abs(szi) * markPrice;

      // Check if position meets notification criteria
      if (positionUSD < CONFIG.MIN_POSITION_USD) continue;

      const liqPx = parseFloat(pos.liquidationPx);
      const isLong = szi > 0;
      const distanceToLiq = isLong ? (markPrice - liqPx) / markPrice : (liqPx - markPrice) / markPrice;
      const distancePercent = distanceToLiq * 100;

      // Check if within danger zone
      if (distancePercent > CONFIG.MAX_DISTANCE_PERCENT || distancePercent < 0) continue;

      // Check if we already sent alert recently
      if (!shouldSendAlert(address, coin)) {
        console.log('⏭️  Skipping alert (cooldown):', address.slice(0, 10), coin);
        continue;
      }

      // Build position object
      const position = {
        user: address,
        coin: pos.coin,
        direction: isLong ? 'LONG' : 'SHORT',
        positionUSD,
        entryPrice: parseFloat(pos.entryPx),
        markPrice,
        liqPrice: liqPx,
        distancePercent: distancePercent.toFixed(2),
        leverage: pos.leverage?.value || 1,
        unrealizedPnl: parseFloat(pos.unrealizedPnl),
        walletAgeDays: null,
        allTimePnl: null
      };

      // Try to get additional info (non-blocking)
      try {
        const walletAge = await getWalletAge(address);
        position.walletAgeDays = walletAge;
      } catch (err) {}

      try {
        const allTimePnl = await getAllTimePnl(address);
        position.allTimePnl = allTimePnl;
      } catch (err) {}

      console.log('🚨 ALERT:', address.slice(0, 10), coin, position.direction, `$${(positionUSD/1000000).toFixed(2)}M`, `${distancePercent.toFixed(2)}%`);

      // Send notifications
      await Promise.all([
        sendTelegramAlert(position),
        sendTwitterAlert(position)
      ]);

      // Mark as sent
      markAlertSent(address, coin);

      // Save to DB
      if (dbClient) {
        try {
          await dbClient.query(
            `INSERT INTO sent_notifications (address, coin, direction, size_usd, distance_percent, timestamp)
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT DO NOTHING`,
            [address, coin, position.direction, positionUSD, distancePercent]
          );
        } catch (err) {}
      }
    }
  } catch (err) {
    console.error('Position check error:', err.message);
  }
}

// ============================================
// WALLET INFO
// ============================================
async function getWalletAge(address) {
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
      return ageDays;
    }
    return null;
  } catch (err) {
    return null;
  }
}

async function getAllTimePnl(address) {
  try {
    const response = await axios.post(CONFIG.HYPERLIQUID_API, {
      type: 'userFills',
      user: address
    });
    if (response.data && Array.isArray(response.data)) {
      let totalPnl = 0;
      response.data.forEach(fill => {
        if (fill.closedPnl) totalPnl += parseFloat(fill.closedPnl);
      });
      return totalPnl;
    }
    return null;
  } catch (err) {
    return null;
  }
}

// ============================================
// WEBSOCKET TRADE MONITORING
// ============================================
let ws = null;
let wsPingInterval = null;

function connectWebSocket() {
  try {
    ws = new WebSocket(CONFIG.HYPERLIQUID_WS);

    ws.on('open', () => {
      console.log('✅ WebSocket connected');
      ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades' } }));

      // Keep-alive ping every 30 seconds
      if (wsPingInterval) clearInterval(wsPingInterval);
      wsPingInterval = setInterval(() => {
        if (ws && ws.readyState === 1) {
          ws.ping();
        }
      }, 30000);
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);

        if (msg.channel === 'subscriptionResponse') {
          console.log('✅ Subscribed to trades stream');
        }

        if (msg.channel === 'trades' && msg.data) {
          processTrades(msg.data);
        }
      } catch (err) {
        console.error('WebSocket message error:', err.message);
      }
    });

    ws.on('pong', () => {
      // Keep-alive pong received
    });

    ws.on('close', () => {
      console.log('⚠️ WebSocket closed, reconnecting in 5s...');
      if (wsPingInterval) {
        clearInterval(wsPingInterval);
        wsPingInterval = null;
      }
      setTimeout(connectWebSocket, 5000);
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
    });
  } catch (err) {
    console.error('WebSocket connection error:', err.message);
    setTimeout(connectWebSocket, 5000);
  }
}

function processTrades(trades) {
  if (!trades || !Array.isArray(trades)) return;

  // Track for health check
  tradesReceived += trades.length;
  lastTradeTime = Date.now();

  // Log occasionally to confirm WebSocket is working
  if (Math.random() < 0.05) {
    console.log('📡 WebSocket: Received', trades.length, 'trades');
  }

  for (const trade of trades) {
    const sz = parseFloat(trade.sz || 0);
    const px = parseFloat(trade.px || 0);
    if (!sz || !px) continue;

    const tradeValue = Math.abs(sz) * px;
    if (tradeValue < CONFIG.MIN_TRADE_USD) continue;

    const users = trade.users || [];
    for (const user of users) {
      if (!user || user.length < 10) continue;

      console.log('🐋 Large trade:', user.slice(0, 10), trade.coin, `$${(tradeValue/1000).toFixed(0)}K`);

      // Check position immediately
      checkPosition(user, trade.coin);
    }
  }
}

// ============================================
// HTTP HEALTH CHECK (for Railway)
// ============================================
let botStartTime = Date.now();
let lastTradeTime = null;
let tradesReceived = 0;

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    const uptime = Math.floor((Date.now() - botStartTime) / 1000);
    const wsConnected = ws && ws.readyState === 1;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: uptime + 's',
      websocket: wsConnected ? 'connected' : 'disconnected',
      trades_received: tradesReceived,
      last_trade: lastTradeTime ? new Date(lastTradeTime).toISOString() : 'none',
      prices_loaded: Object.keys(allMids).length
    }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('✅ HTTP server listening on port', PORT);
});

// ============================================
// STARTUP
// ============================================
async function start() {
  console.log('🚀 Hyperliquid Live Trade Bot starting...');
  console.log('📊 Min trade: $' + (CONFIG.MIN_TRADE_USD/1000) + 'K');
  console.log('💰 Min position for alert: $' + (CONFIG.MIN_POSITION_USD/1000000) + 'M');
  console.log('📉 Max distance: ' + CONFIG.MAX_DISTANCE_PERCENT + '%');
  console.log('');

  // Update prices initially
  await updatePrices();
  console.log('✅ Initial prices loaded:', Object.keys(allMids).length, 'coins');

  // Update prices every 5 seconds
  setInterval(updatePrices, 5000);

  // Connect WebSocket
  connectWebSocket();
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing...');
  if (ws) ws.close();
  if (dbClient) dbClient.end();
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, closing...');
  if (ws) ws.close();
  if (dbClient) dbClient.end();
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

start();
