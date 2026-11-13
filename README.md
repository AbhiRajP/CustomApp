# Azure Cost Monitoring

The app uses Microsoft Entra delegated sign-in. It stores the MSAL token cache encrypted in the backend database and calls Azure APIs from the backend; access tokens are not sent to frontend JavaScript.

## Configure Azure sign-in

1. Register a Microsoft Entra application that supports accounts in any organizational directory. Add this Web redirect URI exactly:
   `http://127.0.0.1:8000/api/auth/callback`
2. Copy `backend/.env.example` to `backend/.env`, then set `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` there. The example contains placeholders only.
3. Configure delegated permission `Azure Service Management > user_impersonation` for the app and grant consent as required by your organization.
4. Assign the signed-in user read-only Azure RBAC permissions on the subscriptions they need to monitor:
   - **Reader** for subscriptions and resource inventory.
   - **Cost Management Reader** for Cost Management queries.
5. Generate a fresh token-encryption key with `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` and set `AZURE_TOKEN_ENCRYPTION_KEY` in `backend/.env`. Keep `.env` out of source control. The local SQLite database is the default; set `DATABASE_URL` to use another database.
6. Start the backend from `backend/` with `python -m uvicorn app.main:app --host 127.0.0.1 --port 8000`, then start the frontend from `frontend/` with `npm run dev`. Open the app using `http://127.0.0.1:3000` so the configured callback and cookie hosts match.

For production, use HTTPS, set `APP_COOKIE_SECURE=true`, store the client secret and encryption key in a secret manager, and use a durable database with backups. Changing the token encryption key invalidates existing saved Azure sessions.

## App behavior

- **Connect Azure** signs in the user and lets them select a subscription. Resource inventory is shown for the entire selected subscription.
- **Billing management** automatically loads current-month-to-date daily costs for the selected subscription on the dashboard, which shows only the live total, bill by date, and spend by Azure service. Cost comparison is a separate page; the user explicitly enters both cost-period and comparison-period dates. One Azure daily-granularity query covers both ranges, and the backend splits rows for comparison results. The dashboard query groups by service only; comparisons also group by resource to support resource-level results. Cost Management requests include an identifying `ClientType` and `x-ms-command-name`. Successful responses are cached in SQLite for five minutes under a key scoped to the signed-in customer, tenant, subscription, both date ranges, granularity, and comparison setting. Identical concurrent requests share one upstream query; distinct cost queries use a two-request global limit with a bounded queue. Azure throttling is logged with its status, sanitized error body, and allowlisted rate-limit/request headers. Retries are bounded, honor Cost Management-specific retry-after headers (waiting only for short delays), and otherwise use exponential backoff with jitter; longer delays are returned to the frontend with a retry message and header. These request identifiers improve attribution but do not override Azure throttling or guarantee a higher quota. To enable background current-month collection, set `COST_COLLECTION_INTERVAL_SECONDS` to a positive number of seconds in `backend/.env`; it is disabled by default to avoid unrequested Azure traffic.
- API errors and missing Azure permissions are shown to the user; the application does not substitute sample values for live Azure data.
