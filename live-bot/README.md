# Hyperliquid Live Trade Bot 🚀

Hyperliquid üzerinde gerçek zamanlı büyük trade'leri izleyen ve likidasyona yakın pozisyonlar için Telegram/Twitter bildirimi gönderen hafif bot.

## Özellikler

- ✅ WebSocket ile **gerçek zamanlı** trade monitoring
- ✅ $200K+ trade'leri otomatik tespit
- ✅ $2M+ pozisyonlar için bildirim
- ✅ Likidasyona %10'dan yakın pozisyonları takip
- ✅ Telegram ve Twitter bildirimleri
- ✅ 24 saat cooldown (aynı pozisyon için tekrar bildirim yok)
- ✅ Ping-pong keep-alive ile stabil WebSocket bağlantısı
- ✅ HTTP health check endpoint (Railway için)
- ✅ Railway'de kolay deploy

## Kurulum

### 1. Repository Oluştur

```bash
cd hl-live-bot
git init
git add .
git commit -m "Initial commit: Hyperliquid live trade bot"
```

GitHub'da yeni bir repo oluştur (örn: `hl-live-bot`) ve push et:

```bash
git remote add origin https://github.com/KULLANICI_ADINIZ/hl-live-bot.git
git branch -M main
git push -u origin main
```

### 2. Railway'de Deploy

1. Railway.app'e git
2. "New Project" → "Deploy from GitHub repo"
3. `hl-live-bot` repo'sunu seç
4. Environment Variables ekle:

```
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
TWITTER_API_KEY=your_api_key
TWITTER_API_SECRET=your_api_secret
TWITTER_ACCESS_TOKEN=your_access_token
TWITTER_ACCESS_SECRET=your_access_secret
DATABASE_URL=postgresql://... (opsiyonel)
```

5. Deploy! 🚀

### 3. Local Test (Opsiyonel)

```bash
npm install
cp .env.example .env
# .env dosyasını düzenle
node index.js
```

## Nasıl Çalışır?

1. **WebSocket bağlantısı** Hyperliquid trade stream'ine bağlanır
2. **$200K+ trade** geldiğinde otomatik tespit eder
3. **Pozisyon kontrolü** yapar (API'den kullanıcı durumunu çeker)
4. **Koşullar sağlanırsa** bildirim atar:
   - Pozisyon ≥ $2M
   - Likidasyona uzaklık ≤ 10%
   - Son 24 saatte bu pozisyon için bildirim atılmamış

## Bildirim Formatı

```
🚨 LIQUIDATION ALERT 🚨

🟢 BTC LONG
💰 Size: $2.5M
📉 Distance to Liq: 8.2%
🎯 Entry: $45,000 → Mark: $46,200
⚡ Liquidation: $42,400
📊 Leverage: 15x
💵 PnL: +$25.0K

🕐 Wallet Age: 45 days
📈 All-time PnL: +$180K

🔗 View on Hypurrscan
```

## Mevcut Bot ile Fark

**Mevcut Bot (Background Scan)**:
- Periyodik olarak tüm whale'leri tarar
- ~27K adresi her 2 dakikada kontrol eder
- WebSocket problemi yaşayabiliyor

**Bu Bot (Live Trade)**:
- Sadece büyük trade'leri dinler
- Çok daha hafif ve hızlı
- Stabil WebSocket bağlantısı
- Gerçek zamanlı tespit

## Health Check Endpoint

Bot, Railway için HTTP health check endpoint sağlar:

**GET /** veya **GET /health**

Örnek yanıt:
```json
{
  "status": "ok",
  "uptime": "1234s",
  "websocket": "connected",
  "trades_received": 15420,
  "last_trade": "2024-11-29T12:34:56.789Z",
  "prices_loaded": 476
}
```

Bu sayede Railway bot'un sağlıklı çalıştığını anlayabilir ve SIGTERM göndermez.

## Environment Variables

| Variable | Açıklama | Zorunlu |
|----------|----------|---------|
| `PORT` | HTTP server port (Railway otomatik set eder) | Hayır (default: 3000) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | Evet |
| `TELEGRAM_CHAT_ID` | Telegram chat/channel ID | Evet |
| `TWITTER_API_KEY` | Twitter API key | Opsiyonel |
| `TWITTER_API_SECRET` | Twitter API secret | Opsiyonel |
| `TWITTER_ACCESS_TOKEN` | Twitter access token | Opsiyonel |
| `TWITTER_ACCESS_SECRET` | Twitter access secret | Opsiyonel |
| `DATABASE_URL` | PostgreSQL connection string | Opsiyonel |

## Log Örneği

```
🚀 Hyperliquid Live Trade Bot starting...
📊 Min trade: $200K
💰 Min position for alert: $2M
📉 Max distance: 10%

✅ Telegram bot initialized
✅ Twitter OAuth initialized
✅ PostgreSQL connected
✅ Initial prices loaded: 157 coins
✅ WebSocket connected
✅ Subscribed to trades stream
📡 WebSocket: Received 45 trades
🐋 Large trade: 0x1234567... BTC $250K
🚨 ALERT: 0x1234567... BTC LONG $2.5M 8.2%
✅ Telegram alert sent: BTC LONG
✅ Twitter alert sent: BTC LONG
```

## Sorun Giderme

**WebSocket bağlantısı kesiliyor**
- Bot otomatik olarak yeniden bağlanır
- Ping-pong keep-alive mekanizması var

**Bildirim gelmiyor**
- Environment variables'ları kontrol et
- Logları kontrol et (Railway dashboard)
- Telegram bot token ve chat ID doğru mu?

**Çok fazla bildirim geliyor**
- Cooldown 24 saat olarak ayarlı
- `CONFIG.MIN_POSITION_USD` ve `CONFIG.MAX_DISTANCE_PERCENT` değerlerini ayarlayabilirsin

## Lisans

MIT
