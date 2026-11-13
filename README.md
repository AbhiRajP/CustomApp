# Azure Cost Monitoring

The app uses one organization-owned, multitenant Microsoft Entra ID app registration for all customers. It uses delegated sign-in: each customer user signs in to their own organization, and Azure APIs run on the backend using that user's authorization. The app does not ask customers for an app registration, client ID, or client secret.

## Shared Entra app setup

1. Create one Microsoft Entra app registration owned by your organization. Under **Supported account types**, choose **Accounts in any organizational directory**. Add the Web redirect URI for each deployment environment. For local development:
   `http://127.0.0.1:3000/api/auth/callback`
2. Configure the shared delegated permission **Azure Service Management > user_impersonation**. Admin-consent it in your own tenant as needed.
3. Configure the shared backend values in `backend/.env` for local development. Copy `backend/.env.example` first; it contains placeholders only:
   - `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`: the one shared app registration's credentials.
   - `AZURE_AUTHORITY=https://login.microsoftonline.com/common`: shared multitenant sign-in endpoint.
   - `AZURE_REDIRECT_URI`: the public app origin plus `/api/auth/callback`, registered on that same app. The frontend proxies this callback to FastAPI so the OAuth state cookie stays on the app's origin.
   - `AZURE_TOKEN_ENCRYPTION_KEY`: generate with `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`.
   - `APP_ORIGIN`: the frontend browser origin. Use one hostname consistently for the app and OAuth callback (for example, do not mix `localhost` and `127.0.0.1`).
4. Start the backend from `backend/` with `python -m uvicorn app.main:app --host 127.0.0.1 --port 8000`, then start the frontend from `frontend/` with `npm run dev`. Open the app using the configured `APP_ORIGIN`; register the matching frontend-origin callback (the Next.js `/api` rewrite forwards it to FastAPI).

### Onboarding another customer organization

No new app registration, client ID, or client secret is needed:

1. The customer's Entra administrator grants tenant-wide consent to the shared application's `user_impersonation` delegated permission, if their consent policy requires administrator approval. This creates the shared app's enterprise application/service principal in that customer tenant.
2. The administrator assigns the customer users **Reader** and **Cost Management Reader** roles on each subscription they should monitor.
3. The customer user opens the app and signs in with their organization's account. Microsoft Entra returns the tenant ID; the backend validates and stores it with the session.
4. The user selects one accessible subscription at a time in **Connect Azure**. All subscriptions visible to their account are listed, and they can switch the saved selection whenever needed.

Consent and Azure RBAC are distinct: consent authorizes the shared application to request the delegated ARM scope, while the signed-in user's RBAC roles determine which subscriptions and data Azure actually permits them to read.

## Tenant isolation and credential handling

- The OAuth redirect uses the shared `/common` authority. After sign-in, the backend validates the tenant ID (`tid`) from the Entra token and persists it with the opaque server-side session.
- Each session has a separate MSAL token cache encrypted with the backend's shared Fernet key. The frontend receives only an HTTP-only session cookie; client secrets and access/refresh tokens stay on the backend.
- For Azure API calls, the backend loads the cache associated with the caller's session and uses a tenant-specific authority derived from that session's validated tenant ID. Subscription IDs from other sessions are never used as an authorization context.
- Subscription preferences are keyed by customer tenant. Cost-cache keys include the authenticated account/tenant and subscription, preventing one customer's cached results from being returned to another.
- The frontend does not receive the client secret or Azure tokens. Do not configure them as `NEXT_PUBLIC_*` variables.

## Docker deployment

For local Docker Compose, create `backend/.env` from the safe example and set the shared app values and callback/origin for the host name you will use. The callback should be the public frontend origin, such as `http://127.0.0.1:3000/api/auth/callback`. Then run:

```powershell
docker compose up --build
```

Open the frontend at `http://127.0.0.1:3000` when the `.env` callback and origin use `127.0.0.1`. The compose setup passes `backend/.env` to the backend container at runtime, stores SQLite data in a named volume, and builds the frontend API proxy with the internal backend address. The Dockerfiles do not copy `.env` or credentials into either image; `.dockerignore` excludes environment files and local build artifacts.

For production Docker or Kubernetes, inject `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_AUTHORITY`, `AZURE_REDIRECT_URI`, `AZURE_TOKEN_ENCRYPTION_KEY`, and `APP_ORIGIN` from the platform's secret/configuration manager at runtime; set `APP_ENV=production`. Production mode rejects non-HTTPS origins/callbacks or `APP_COOKIE_SECURE=false`. Use a shared durable database for backend replicas, and keep the encryption key stable across replicas and restarts. Changing that key invalidates existing saved Azure sessions. Never put secrets in Docker build arguments, image layers, frontend build variables, or source control.

## App behavior

- **Connect Azure** signs in the user and lets them select one subscription at a time from the subscriptions accessible to that user. Resource inventory and costs are scoped to the currently selected subscription.
- **Billing management** automatically loads current-month-to-date daily costs for the selected subscription on the dashboard, which shows only the live total, bill by date, and spend by Azure service. Cost comparison is a separate page; the user explicitly enters both cost-period and comparison-period dates. One Azure daily-granularity query covers both ranges, and the backend splits rows for comparison results. The dashboard query groups by service only; comparisons also group by resource to support resource-level results. Cost Management requests include an identifying `ClientType` and `x-ms-command-name`. Successful responses are cached in SQLite for five minutes under a key scoped to the signed-in customer, tenant, subscription, both date ranges, granularity, and comparison setting. Identical concurrent requests share one upstream query; distinct cost queries use a two-request global limit with a bounded queue. Azure throttling is logged with its status, sanitized error body, and allowlisted rate-limit/request headers. Retries are bounded, honor Cost Management-specific retry-after headers (waiting only for short delays), and otherwise use exponential backoff with jitter; longer delays are returned to the frontend with a retry message and header. These request identifiers improve attribution but do not override Azure throttling or guarantee a higher quota. To enable background current-month collection, set `COST_COLLECTION_INTERVAL_SECONDS` to a positive number of seconds in `backend/.env`; it is disabled by default to avoid unrequested Azure traffic.
- API errors and missing Azure permissions are shown to the user; the application does not substitute sample values for live Azure data.
