# Ringover Daily Export - Setup

## ⚙️ Configuration

Add your Ringover API key to `.env`:

```bash
RINGOVER_API_KEY=your_ringover_key_here
```

## 🚀 Daily Export (Automatic)

Runs automatically every day at **12:00 AM French time (Paris/Europe timezone)**

- Exports only customers created that day
- Pushes directly to Ringover API
- Prevents duplicates (only customers created today)
- No CSV files generated (API push only)

## 📡 Manual Triggers

### Via API Endpoint

**Daily Export (customers created today):**
```bash
curl -X POST "http://localhost:5000/api/ringover-export/daily"
```

**Custom Date Range Export:**
```bash
curl -X POST "http://localhost:5000/api/ringover-export/generate?fromDate=2026-04-23T00:00:00Z&toDate=2026-04-24T00:00:00Z&pushToAPI=true&generateCSV=false"
```

**Generate CSV Only (no API push):**
```bash
curl -X POST "http://localhost:5000/api/ringover-export/generate?pushToAPI=false&generateCSV=true"
```

### Via Cron Management

Add endpoint to trigger/monitor cron:
```javascript
// In a new controller function
app.get("/api/ringover-export/cron-status", (req, res) => {
  const { getCronStatus } = require('./services/ringoverDailyExportCron');
  res.json(getCronStatus());
});
```

## 📊 What Happens

1. **Daily at 12:00 AM (French time):**
   - Queries customers created in the past 24 hours
   - Normalizes phone numbers to E164 format
   - Pushes to Ringover API
   - Logs success/failure

2. **Duplicate Prevention:**
   - Only customers created that specific day are exported
   - Ringover API handles duplicate detection on their end
   - Each export has unique batchId for tracking

3. **Logging:**
   - Check console/logs for: `[Ringover Cron]` entries
   - Export metadata saved to MongoDB `RingoverExport` collection

## ✅ Endpoints

```
POST /api/ringover-export/generate
  Query params:
    - pushToAPI: boolean (default: true)
    - generateCSV: boolean (default: true)
    - fromDate: ISO date string (optional)
    - toDate: ISO date string (optional)

POST /api/ringover-export/daily
  Manually trigger daily export for customers created today

POST /api/ringover-export/generate?fromDate=X&toDate=Y
  Export customers created between X and Y dates
```

## 🔍 Monitoring

Check MongoDB `RingoverExport` collection:
```javascript
db.ringoverexports.find({ status: "success" }).sort({ exportedAt: -1 }).limit(10)
```

Check console logs:
```bash
grep "Ringover Cron" /var/log/app.log
```

## 🛠️ Note on Timezone

The cron job uses Node.js `cron` with standard UTC scheduling. The service converts to French time (Europe/Paris) when calculating the date range for customer filtering. This ensures you export customers created in the French timezone, not UTC.

---

**Ready! Provide the Ringover API key and the daily exports will start automatically.**
