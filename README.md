# STUCHA Loan Management Web Application

Secure client application portal, admin review queue, notifications, and Google Sheets approval sync.

## Run Locally

```powershell
node server.js
```

Open `http://localhost:4173`.

If `ADMIN_PASSWORD` is not set, the server prints a temporary development password in the terminal. Log in with that password once, then use the Admin Security panel to set your own username and password. Dashboard-set credentials are stored in `data/settings.json` as a salted password hash.

## What Is Included

- Client portal with required full name, student ID, phone, client photo, Omang/passport upload, student ID upload, campus/hostel address, home address, Google Maps location, debt declaration, signature, and loan amount.
- Client status lookup using the application reference or student ID plus phone number.
- Loan calculator with P100 minimum and P1000 maximum by default.
- Loan categories: Standard 30% from the 1st to month end, and Late Month 25% from the 15th to month end.
- Repayment due date is the 27th of the current month, or the next month when applying after the 27th. If the 27th falls on a weekend, it moves back to Friday.
- Admin dashboard with a review queue, document links, Google Maps links, approval checkbox, local spreadsheet status, and a security panel to set your own admin username and password.
- Admin approval and rejection actions. Clients see Pending as "In Progress" when they check their status.
- Local CSV spreadsheet at `data/loan_applications.csv`, with an admin-only download button in the dashboard.
- Upload validation by file signature for JPG, PNG, WEBP, and PDF.
- Session cookies, CSRF protection for admin actions, strict security headers, rate limiting, and non-public upload storage.
- Twilio WhatsApp or generic webhook notifications.
- SendGrid email alerts with document attachments, or a generic email webhook fallback.
- Google Sheets append using a service account, without third-party packages.

## Google Sheets Setup

Google Sheets sync is optional. The app now keeps a local spreadsheet automatically, so you can operate without Google Sheets while testing or while deployed with persistent storage.

1. Create a Google Cloud service account with access to the Google Sheets API.
2. Copy the service account email and private key into `.env`.
3. Share your sheet with the service account email as an Editor.
4. Set:

```env
GOOGLE_SHEET_ID=1A2Em_TlWDdSvpAG6-ew1eLAC29qolZ7W5eFI8DV8N7I
GOOGLE_SHEET_TAB=Loans
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service-account@project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

The approval action appends columns:

```text
Date, Name, Student ID, Amount Out, Percentage, Interest, Amount In, Status, Paid
```

`Paid` is written as `FALSE`. `Interest` and `Amount In` are written as formulas for the appended row, so normal sheet totals continue to update automatically.

Recommended header row:

```text
Date | Name | Student ID | Amount Out | Percentage | Interest | Amount In | Status | Paid
```

Example totals:

```text
Total Amount Out: =SUM(D2:D)
Total Interest:   =SUM(F2:F)
Total Amount In:  =SUM(G2:G)
Unpaid Balance:   =SUMIF(I2:I,FALSE,G2:G)
```

## Notifications

For WhatsApp, configure Twilio:

```env
OWNER_WHATSAPP_TO=whatsapp:+26770000000
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
```

Or set `WHATSAPP_WEBHOOK_URL` to receive a JSON payload.

For email with uploaded documents attached, configure SendGrid:

```env
OWNER_EMAIL=owner@example.com
ALERT_FROM_EMAIL=alerts@example.com
SENDGRID_API_KEY=...
```

Or set `EMAIL_WEBHOOK_URL` to receive a JSON payload with the application summary and protected document links.

## Render Hosting

This repository includes `render.yaml` for a Render web service.

Use a paid Render web service plan with a persistent disk. Render's normal service filesystem is ephemeral, so uploaded IDs/photos/signatures and the local spreadsheet need the disk mounted at `/var/data`.

The Blueprint also defines a separate `stucha-webhook-api` Python service for Railway PostgreSQL/Jotform webhooks. If you apply the Blueprint, Render will ask you to fill the secrets marked `sync: false`, including `DATABASE_URL`.

The webhook service is pinned to Python `3.12.13` through `.python-version` and `PYTHON_VERSION`. This avoids compatibility problems with Render's newer default Python runtime.

Recommended Render settings:

```text
Build Command: npm install
Start Command: node server.js
Health Check Path: /healthz
Persistent Disk Mount Path: /var/data
```

Set these required environment variables in Render:

```env
ADMIN_PASSWORD=your-long-private-password
STORAGE_DIR=/var/data
MIN_LOAN_AMOUNT=100
MAX_LOAN_AMOUNT=1000
DEFAULT_INTEREST_RATE=0.30
LATE_MONTH_INTEREST_RATE=0.25
REPAYMENT_DUE_DAY=27
```

Then add Twilio and SendGrid values when you are ready for WhatsApp/email alerts.

Notification environment variables:

```env
OWNER_WHATSAPP_TO=whatsapp:+2677XXXXXXX
OWNER_EMAIL=you@example.com

# For WhatsApp through Twilio
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886

# Or for a WhatsApp automation webhook
WHATSAPP_WEBHOOK_URL=https://...

# For email through SendGrid
SENDGRID_API_KEY=...
ALERT_FROM_EMAIL=alerts@yourdomain.com

# Or for an email automation webhook
EMAIL_WEBHOOK_URL=https://...
```

Setting only `OWNER_WHATSAPP_TO` or only `OWNER_EMAIL` stores the destination, but an actual provider such as Twilio, SendGrid, or a webhook is required to send real alerts.

## Railway PostgreSQL + Jotform Webhook API

This repository also includes a separate FastAPI webhook service in `services/webhook_api`. Use it when you are ready to receive Jotform webhooks, store submissions in Railway PostgreSQL, and optionally append summary rows to Google Sheets.

Deploy it as a second Render Web Service using:

```text
Root Directory: leave blank
Build Command: pip install -r services/webhook_api/requirements.txt
Start Command: cd services/webhook_api && uvicorn app.main:app --host 0.0.0.0 --port $PORT
Health Check Path: /healthz
```

Set `DATABASE_URL` in Render to your rotated Railway public/proxy PostgreSQL connection string. Do not use the private `postgres.railway.internal` URL, and do not commit the real Railway URL to GitHub. Full setup instructions are in `services/webhook_api/README.md`.

## Production Notes

Use HTTPS, a permanent database, encrypted object storage, antivirus scanning for uploads, backups, audit logs, and a real deployment secret manager before collecting actual Omang/passport or student ID records. This local app keeps uploads outside the public folder and requires admin login to view them, but production identity-document storage deserves stronger infrastructure controls.
