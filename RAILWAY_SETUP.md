# Railway Deployment Setup

## Environment Variables Configuration

To deploy this application on Railway, you need to configure the following environment variables in your Railway project dashboard:

### Required for Telegram Notifications

```
TELEGRAM_BOT_TOKEN=8310560697:AAG2QZ3I4U-hWSGx0vmOJaa6MS59Rnfaj7o
TELEGRAM_CHANNEL_ID=-4809785478
```

### Required for Twitter/X Notifications

```
TWITTER_API_KEY=M3f7AnvGb67E2OACy9QpRkFJE
TWITTER_API_SECRET=yvlFFvIZk9p01w276tOnyUkRUNw8tS3JEUpwn2VrkwEigfhNT3
TWITTER_ACCESS_TOKEN=1821527439136215040-PeNIicAxw0xck77t0hfDnNliHc9TbU
TWITTER_ACCESS_SECRET=S08FV6BVtUYrgFxpt1V88mS2VEA2fQYePoVfMNYjdWUus
```

### Optional Settings

```
MIN_POSITION_USD=2000000
MIN_TRADE_USD=100000
REFRESH_INTERVAL=60000
```

### Database (Optional)

If you add a PostgreSQL database from Railway dashboard, it will automatically set:
```
DATABASE_URL=postgresql://...
```

## Setup Steps

1. **Create a new Railway project** or open your existing one
2. **Navigate to Variables tab** in your Railway project
3. **Add each environment variable** listed above
4. **Deploy** - Railway will automatically rebuild with the new configuration

## Testing the Setup

After deployment, you can test the notification systems:

- **Telegram Test**: Send GET request to `/api/test-telegram`
- **Twitter Test**: Send GET request to `/api/test-twitter`

## Security Notes

- ⚠️ Never commit the `.env` file to git (already in `.gitignore`)
- ✅ Use Railway's environment variables dashboard for production
- ✅ Keep your API tokens secure and rotate them periodically
- ✅ The `.env` file is only for local development

## Local Development

For local development, the `.env` file has been configured with all credentials. Simply run:

```bash
npm install
npm start
```

The application will automatically load variables from `.env` file.

## Monitoring

Check Railway logs to verify:
- ✅ WebSocket connection to Hyperliquid
- ✅ Telegram bot authentication
- ✅ Twitter API authentication
- ✅ Position scanning started

Look for these success messages:
```
✅ WebSocket connected
✅ Subscribed to trades stream
✅ Initial load complete
```
