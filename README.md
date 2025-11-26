# 🎯 Hyperliquid Liquidation Hunter

**High-Risk Position Tracker for Hyperliquid DEX**

Bu araç, Hyperliquid üzerindeki büyük pozisyonları ($2M+) izler ve likidasyona yakın olanları (<%10) filtreler. Amaç: potansiyel insider trading veya yüksek riskli kumarbazları tespit etmek.

## 🚀 Hızlı Deploy (Railway - 5 dakika)

### 1. GitHub'a Yükle
```bash
cd hl-liq-tracker
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/KULLANICI_ADIN/hl-liq-tracker.git
git push -u origin main
```

### 2. Railway'e Deploy Et
1. https://railway.app adresine git
2. GitHub ile giriş yap
3. "New Project" → "Deploy from GitHub repo"
4. `hl-liq-tracker` repo'sunu seç
5. Otomatik deploy başlayacak (2-3 dakika)
6. "Settings" → "Generate Domain" → Public URL al!

### 3. Sonuç
`https://hl-liq-tracker-xxxx.railway.app` gibi bir URL alacaksın - 7/24 çalışacak!

---

## 🎯 Temel Özellikler

- **$2M+ Pozisyon Filtresi**: Sadece büyük pozisyonları takip eder
- **Likidasyon Uzaklığı Hesaplama**: Mevcut fiyattan likidasyon fiyatına mesafe
- **Kritik Seviyeler**: 
  - 🔴 **CRITICAL**: <%5 uzaklık (çok riskli)
  - 🟡 **WARNING**: %5-10 uzaklık (riskli)
- **Real-time Fiyat Takibi**: WebSocket üzerinden canlı fiyat güncellemeleri
- **Whale Discovery**: Büyük işlemlerden yeni whale adresleri otomatik tespit
- **Wallet Info**: Her pozisyon için cüzdan bakiyesi ve diğer pozisyonlar
- **📱 Telegram Alerts**: Kritik pozisyonlar için otomatik bildirim
- **🐦 Twitter/X Alerts**: Otomatik tweet atma
- **Modern Dashboard**: Dark theme, trading terminal aesthetic

---

## 📱 Telegram Bot Kurulumu

### 1. Bot Oluştur
1. Telegram'da [@BotFather](https://t.me/BotFather)'a git
2. `/newbot` yaz
3. Bot adı ver (örn: "HL Liq Hunter")
4. Username ver (örn: "hl_liq_hunter_bot")
5. **Token'ı kaydet!** (örn: `123456789:ABCdefGHI...`)

### 2. Kanal Oluştur
1. Telegram'da yeni kanal oluştur
2. Bot'u kanala **admin olarak ekle**
3. Channel ID'yi bul:
   - Public kanal: `@channel_name`
   - Private kanal: Kanal'a mesaj at, sonra:
     ```
     https://api.telegram.org/bot<TOKEN>/getUpdates
     ```
     Cevaptaki `chat.id` değerini al (örn: `-1001234567890`)

### 3. Environment Variables
```bash
# .env dosyası oluştur
cp .env.example .env

# Değerleri doldur
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNO...
TELEGRAM_CHANNEL_ID=@your_channel_name
```

---

## 🐦 Twitter/X API Kurulumu

### 1. Developer Account
1. https://developer.twitter.com adresine git
2. "Sign up" → Developer account oluştur (Free tier yeterli)
3. Use case açıkla: "Automated cryptocurrency alerts"

### 2. App Oluştur
1. Developer Portal → Projects & Apps → Create App
2. App name: "HL Liq Hunter"
3. **Keys and tokens** sekmesine git:
   - API Key and Secret → **Generate**
   - Access Token and Secret → **Generate**

### 3. Permissions Ayarla
1. App Settings → User authentication settings → **Set up**
2. App permissions: **Read and Write** seç
3. Save

### 4. Environment Variables
```bash
TWITTER_API_KEY=xxxxx
TWITTER_API_SECRET=xxxxx
TWITTER_ACCESS_TOKEN=xxxxx
TWITTER_ACCESS_SECRET=xxxxx
```

---

## 🚀 Başlatma

```bash
# Bağımlılıkları yükle
npm install

# .env dosyasını oluştur ve doldur
cp .env.example .env
nano .env

# Başlat
npm start
```

### Alert Örneği (Telegram)

```
🚨 HIGH-RISK POSITION DETECTED 🚨

🆕 NEW WALLET
🔴 SOL SHORT
💰 Size: $4.11M
⚡ Leverage: 20x
📍 Distance to Liq: 3.47%

📊 Entry: $137.11
📈 Mark: $136.88
💀 Liq: $141.64

💼 Wallet: $245K
📂 Total Positions: 2

🔗 View on Hyperliquid

#Hyperliquid #Liquidation #SOL #Whale
```

## 📦 Kurulum

### 1. Gereksinimleri Kur

```bash
# Node.js 18+ gerekli
node --version

# Proje klasörüne git
cd hl-liq-tracker

# Bağımlılıkları yükle
npm install
```

### 2. Sunucuyu Başlat

```bash
npm start
```

### 3. Dashboard'u Aç

Tarayıcıda: `http://localhost:3000`

## 🔧 Yapılandırma

`server.js` içindeki CONFIG objesini düzenleyebilirsin:

```javascript
const CONFIG = {
  MIN_POSITION_USD: 2000000,    // Minimum pozisyon büyüklüğü
  DANGER_THRESHOLD_5: 0.05,     // %5 kritik seviye
  DANGER_THRESHOLD_10: 0.10,    // %10 uyarı seviyesi
  REFRESH_INTERVAL: 30000,      // Yenileme aralığı (ms)
};
```

## 📡 API Endpoints

### `GET /api/positions`
Tüm yüksek riskli pozisyonları getirir.

Query params:
- `minSize`: Minimum pozisyon büyüklüğü (USD)
- `maxDistance`: Maksimum likidasyon uzaklığı (%)
- `dangerLevel`: `CRITICAL` veya `WARNING`

### `GET /api/stats`
Dashboard istatistikleri.

### `GET /api/prices`
Güncel fiyatlar.

### `POST /api/add-address`
Yeni adres takibe ekle.

Body: `{ "address": "0x..." }`

### `GET /api/check-address/:address`
Belirli bir adresin pozisyonlarını kontrol et.

## 🐋 Whale Adres Kaynakları

Dashboard varsayılan olarak birkaç örnek whale adresi ile başlar. Daha fazla adres eklemek için:

### 1. Manuel Ekleme
Dashboard'da "Add Address" butonunu kullan.

### 2. Coinglass API (Ücretli)
Coinglass API key alarak whale pozisyonlarını otomatik çekebilirsin:
- https://docs.coinglass.com/reference/hyperliquid-whale-position

### 3. Hyperliquid Explorer
- https://app.hyperliquid.xyz/explorer

### 4. CoinAnk/WhaleTrades
- https://coinank.com/hyperliquid
- https://whaletrades.io/

## 🔄 Veri Akışı

```
Hyperliquid API
      │
      ├── metaAndAssetCtxs → Asset metadata + fiyatlar
      │
      ├── clearinghouseState (per address) → Pozisyon detayları
      │
      └── WebSocket (trades) → Real-time whale discovery

      ↓

Position Processing
      │
      ├── Calculate position value in USD
      ├── Calculate distance to liquidation
      └── Filter: >$2M && <10% distance

      ↓

Dashboard
```

## 📊 Likidasyon Hesaplama

```javascript
// Long pozisyon için:
distanceToLiq = (markPrice - liqPrice) / markPrice

// Short pozisyon için:
distanceToLiq = (liqPrice - markPrice) / markPrice
```

## ⚠️ Dikkat Edilecekler

1. **Rate Limits**: Hyperliquid API'si rate limit uygular. Çok fazla adres takip etme.

2. **Cross vs Isolated**: Cross margin pozisyonlarında likidasyon fiyatı diğer pozisyonlara bağlı olarak değişebilir.

3. **Funding Fees**: Funding ücretleri pozisyonun gerçek likidasyon seviyesini etkileyebilir.

4. **Network Delays**: WebSocket bağlantısı kopabilir, otomatik yeniden bağlanma var.

## 🛠️ Geliştirme

### Yapı

```
hl-liq-tracker/
├── server.js          # Express + WebSocket backend
├── public/
│   └── index.html     # Dashboard frontend
├── package.json
└── README.md
```

### Teknolojiler

- **Backend**: Node.js, Express, WebSocket (ws)
- **Frontend**: Vanilla JS, CSS3 (custom design)
- **API**: Hyperliquid native API

### TODO / Geliştirmeler

- [ ] Coinglass API entegrasyonu
- [ ] Telegram/Discord alert sistemi
- [ ] Pozisyon geçmişi ve trend analizi
- [ ] Birden fazla timeframe desteği
- [ ] Export to CSV/JSON
- [ ] Auth sistemi
- [ ] PostgreSQL/Redis cache

## 📝 Örnek Senaryo

1. $10M BTC LONG pozisyon, 25x kaldıraç
2. Entry: $100,000, Current: $95,000, Liq: $92,000
3. Distance: ($95k - $92k) / $95k = 3.16%
4. Status: **CRITICAL** 🔴

Bu trader ya çok emindir, ya da bildiği bir şey var!

## 📄 Lisans

MIT - İstediğin gibi kullan, geliştir, dağıt.

## 🔗 Kaynaklar

- [Hyperliquid API Docs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api)
- [Hyperliquid Python SDK](https://github.com/hyperliquid-dex/hyperliquid-python-sdk)
- [Coinglass API](https://docs.coinglass.com)

---

**⚡ Made for tracking high-risk traders on Hyperliquid**
