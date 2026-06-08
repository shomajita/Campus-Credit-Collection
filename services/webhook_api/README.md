# STUCHA Webhook API

FastAPI service for receiving Jotform webhooks, saving normalized submissions to Railway PostgreSQL, and optionally appending a summary row to Google Sheets.

This service is separate from the existing Node.js STUCHA Loans website. Deploy it as a second Render Web Service when you are ready to centralize submissions in Railway.

## Repository Structure

```text
services/webhook_api/
  app/
    main.py                  # FastAPI routes and startup
    config.py                # Environment variable loading
    db.py                    # SQLAlchemy engine/session
    models.py                # PostgreSQL tables
    security.py              # Webhook/admin secret checks
    services/
      jotform.py             # Jotform payload parsing
      google_sheets.py       # Optional Google Sheets append
  requirements.txt
  render.yaml.example
  .env.example
```

## Render Environment Variables

Set these in the Render dashboard for the Python webhook service. Do not put real values in GitHub.

```env
DATABASE_URL=postgresql://postgres:NEW_ROTATED_PASSWORD@your-railway-host:your-port/railway
DATABASE_SSL=true
JOTFORM_WEBHOOK_SECRET=use-a-long-random-value
ADMIN_API_KEY=use-a-different-long-random-value
GOOGLE_SHEET_ID=your-google-sheet-id
GOOGLE_SHEET_TAB=Loans
GOOGLE_SERVICE_ACCOUNT_JSON_B64=base64-encoded-service-account-json
APP_ENV=production
```

Use a newly rotated Railway PostgreSQL URL because an old URL was shared in chat.

## Render Service Settings

Create a new Render Web Service from the same GitHub repository:

```text
Root Directory: services/webhook_api
Build Command: pip install -r requirements.txt
Start Command: uvicorn app.main:app --host 0.0.0.0 --port $PORT
Health Check Path: /healthz
```

The existing Node service can continue using the repository root and `node server.js`.

## Jotform Webhook URL

After the Python service is live, add this URL in Jotform:

```text
https://YOUR-RENDER-WEBHOOK-SERVICE.onrender.com/webhooks/jotform?token=YOUR_JOTFORM_WEBHOOK_SECRET
```

The API also accepts the secret in an `X-Webhook-Secret` header if your automation tool supports custom headers.

## Google Sheets Service Account

1. Create or reuse a Google Cloud service account.
2. Enable Google Sheets API.
3. Share the target Google Sheet with the service account email as Editor.
4. Base64 encode the full service account JSON file and paste it into `GOOGLE_SERVICE_ACCOUNT_JSON_B64` in Render.

PowerShell encoding example:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("service-account.json"))
```

Rows are appended to columns:

```text
Date, Name, Phone, Email, Amount, Jotform Submission ID, Status, Source
```

## Local Syntax Check

```powershell
python -m compileall services/webhook_api/app
```

Do not run local database tests with production credentials unless you intentionally want to write to Railway.
