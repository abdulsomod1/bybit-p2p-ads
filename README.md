# Bybit P2P Bot

A production-oriented TypeScript application for secure Bybit P2P operations. It includes a React dashboard, Express API, PostgreSQL persistence, signed Bybit API support, authentication, audit tables, health checks, Docker deployment, and strict confirmation-oriented operation boundaries.

## Safety model

- Live P2P ad updates and automatic repricing are disabled at startup. An administrator must enable LIVE mode, then separately enable automatic repricing and opt in each advertisement.
- A persistent emergency STOP blocks live ad updates. Restarting the server always disarms LIVE mode.
- The bot does not automate P2P payments, order completion, asset release, withdrawals, or transfers.
- All operation records are persisted with a unique idempotency key.
- Credentials stay server-side and are never returned to the frontend.
- Unknown Bybit responses are never treated as success.
- The public Bybit connectivity probe is available without private credentials.
- Private API credentials require the appropriate Bybit API permissions.

## Requirements

- Node.js 24+
- PostgreSQL 17+
- Docker optional

## Local setup

1. Copy `.env.example` to `.env`.
2. Set `JWT_SECRET` to at least 32 random characters.
3. Set `ADMIN_PASSWORD` to a strong password.
4. Set `DATABASE_URL` to `postgresql://bybit_app:URL_ENCODED_APP_PASSWORD@localhost:5432/bybit_p2p`. URL-encode any special characters in the password; do not commit `.env`.
5. Optionally set `BYBIT_API_KEY` and `BYBIT_API_SECRET`.
6. Install and run:

```powers
npm.cmd install
npm.cmd run dev
```

Open `http://localhost:5173`.

## P2P ad price monitoring

The P2P integration supports BTC/NGN and USDT/NGN. It reads online competitor ads, your own ads, own-ad details, and configured payment methods using Bybit's documented P2P endpoints: [online ads](https://bybit-exchange.github.io/docs/p2p/ad/online-ad-list), [my ads](https://bybit-exchange.github.io/docs/p2p/ad/ad-list), [ad details](https://bybit-exchange.github.io/docs/p2p/ad/ad-detail), [payment methods](https://bybit-exchange.github.io/docs/p2p/user/user-payment), and [ad updates](https://bybit-exchange.github.io/docs/p2p/ad/update-list-ad). It proposes changes only for online fixed-price (`priceType=0`) ads and selects the first returned online Verified Advertiser (`VA`) whose payment type overlaps with your ad. Bybit's documentation does not guarantee that the online-ad response is ranked, so this is not guaranteed to be the marketplace's top ad.

The scanner reads online competitor ads and your own ads, then filters competitors by overlapping payment methods, compatible trade limits, liquidity, Verified Advertiser status, and configured completion statistics. It targets one eligible market reference: sellers move below the cheapest eligible seller, while buyers move above the highest eligible buyer, using the per-ad NGN offset. A candidate is discarded if it violates that ad's per-token reference-price margin. Bybit does not guarantee response ordering, so the selected eligible price is not guaranteed to be the absolute market best.

Automatic scanning defaults to every 5 seconds and can be changed through `P2P_SCAN_INTERVAL_MS` or the admin dashboard (5–300 seconds). Each P2P request is paced at no more than four starts per second, below Bybit's documented P2P endpoint limits; scans do not overlap and may take longer than the configured interval when pagination or API latency grows. Short-lived market caching reduces duplicate reads. Transient read failures use bounded exponential backoff; ad writes are not blindly retried.

`P2P_AUTO_SCAN=false` disables scheduled scans and automatic repricing. A price delta greater than `P2P_LARGE_CHANGE_THRESHOLD_NGN` (default ₦600) is flagged in the dashboard and server logs. The dashboard records scan duration, API latency, update duration, update counts, failures, and rate-limit warnings.

### Deliberate live advertisement updates

Live mode is DRY-RUN by default and resets to DRY-RUN whenever the server starts. To make live mode eligible, configure `P2P_LIVE_MIN_PRICE_NGN`, `P2P_LIVE_MAX_PRICE_NGN`, and `P2P_LIVE_MAX_CHANGE_NGN` in the private `.env`; the minimum and maximum are required, and the maximum change defaults to ₦600. Restart the server after changing these values.

The admin dashboard's **Enable LIVE** control verifies the signed `/v5/user/query-api` response, requires a read-write API key with only the `FiatP2P: Advertising` permission, rejects P2P order and Wallet permissions, and checks authenticated access to the P2P own-ad and payment-list endpoints. The key must be restricted to the server IP where supported. Never grant withdrawal, transfer, P2P-order, or unrelated permissions to this key. `BYBIT_TESTNET=true` selects the testnet unless `BYBIT_BASE_URL` overrides it; confirm the configured hostname and environment before enabling LIVE.

Automatic repricing only runs after LIVE and Auto are separately enabled and only for ads individually opted in with a confirmed reference price and minimum margin. Before each update, the server fetches current ad details and rechecks proposal freshness, ID, asset, NGN currency, direction, online/fixed-price status, current price, ad limits, configured global price boundaries, per-ad margin, minimum difference, maximum movement, update limits, and API permissions. It preserves the ad's existing quantity, limits, payment methods, preferences, and payment period. Updates are not reported as successful until Bybit confirms the resulting ad price; failed or uncertain writes are not blindly retried. All attempts, outcomes, sanitized Bybit responses, and failures are written to `audit_events`. If a request times out or persistence fails, inspect the ad on Bybit before taking further action.

Profit protection is configured separately for every ad and token. SELL floor = reference price × (1 + margin%); BUY ceiling = reference price × (1 − margin%). References include the operator's applicable acquisition/resale costs and fees; the app never infers or silently changes them. Both values are required and revalidated immediately before a live update. Reference and margin settings older than `P2P_REFERENCE_MAX_AGE_DAYS` (default 30 days), invalid settings, stale market data, authentication failures, database failures, emergency STOP, or an unexpected price movement pause automatic repricing.

The scanner's 5-second default is a polling delay, not a guarantee that every scan completes within five seconds. The client globally paces P2P requests at 250 ms (at most four request starts/second), reads Bybit's `X-Bapi-Limit*` response headers, delays after an exhausted limit, and backs off on transient/rate-limit errors. Bybit's current [general rate-limit rules](https://bybit-exchange.github.io/docs/v5/rate-limit) describe per-IP and per-UID/endpoint limits, but the public table does not list P2P endpoints separately. Therefore this request pacing is conservative relative to the general documented limits, but the exact P2P-specific ceiling must be confirmed from the response headers or Bybit before relying on a particular scan cadence. This bot limits updates to at most one per ad per minute by default and enforces a global daily cap; use Bybit's [advertisement update documentation](https://bybit-exchange.github.io/docs/p2p/ad/update-list-ad) for the current supported request shape.

The emergency **STOP** button disarms live updates and latches the stop until an administrator explicitly re-enables LIVE after permission verification. It cannot cancel a Bybit request already in flight. This deployment should run as one application instance; mode and stop state are persisted in PostgreSQL, but coordinate any multi-instance deployment behind a shared control plane before using live mode.

Live mode changes advertisements only. It does not create P2P orders, confirm payments, complete orders, release assets, withdraw funds, or transfer funds. Live advertisements can nevertheless attract real counterparties and orders, which must be handled manually in Bybit.

The update endpoint is Bybit's documented `POST /v5/p2p/item/update` with `actionType: MODIFY`; the app never uses the relist action. See [Update / Relist Ad](https://bybit-exchange.github.io/docs/p2p/ad/update-list-ad), [Get API Key Information](https://bybit-exchange.github.io/docs/v5/user/apikey-info), [Get My Ads](https://bybit-exchange.github.io/docs/p2p/ad/ad-list), and [Get My Ad Details](https://bybit-exchange.github.io/docs/p2p/ad/ad-detail).

`server/migrations/001_initial.sql` contains the initial application schema. Numbered SQL migrations run in a transaction at startup and use additive `IF NOT EXISTS` DDL; the live-mode migrations add the persistent control row, per-ad settings, and scan metrics without dropping existing data. Re-running migrations does not delete or rewrite existing rows. Startup verifies the configured database and role and required application-table permissions.

As a database administrator, grant the app role the required schema access:

```sql
GRANT CONNECT ON DATABASE bybit_p2p TO bybit_app;
GRANT USAGE, CREATE ON SCHEMA public TO bybit_app;
```

The initial, P2P proposal, live-control, and automatic-repricing migrations are applied at startup. The latest migration adds per-ad settings and scan metrics without dropping or overwriting existing data. Tables created by the migration are owned by `bybit_app`; that does not make the role the owner of the database.

## Docker

Create `.env` from `.env.example` and set `DATABASE_URL_DOCKER`, `BYBIT_APP_DB_PASSWORD`, and `POSTGRES_ADMIN_PASSWORD`, then:

```powers
docker compose up --build
```

The application is exposed on port 4000 and PostgreSQL data is stored in the `postgres_data` volume.
On a new, empty Docker data volume, the init script creates a non-superuser `bybit_app` role and grants schema access. Docker uses the hostname `postgres` inside its network; local development uses `localhost`. Init scripts do not run again for an already-initialized volume.

## Commands

- `npm.cmd run dev` - start frontend and backend development servers
- `npm.cmd run build` - production build
- `npm.cmd run test` - server and client tests
- `npm.cmd run typecheck` - frontend and backend type checks
- `npm.cmd run lint` - frontend and backend lint

## API

- `GET /api/health` - application and database health
- `POST /api/auth/login` - create a secure session
- `POST /api/auth/logout` - invalidate the browser session
- `GET /api/auth/me` - current user
- `GET /api/config/status` - non-secret configuration status
- `GET /api/bybit/server-time` - public Bybit connectivity test
- `GET /api/p2p/ads` - authenticated own-ad prices and limits (sanitized fields)
- `POST /api/p2p/scan` - authenticated dry-run scan and proposed price changes
- `GET /api/p2p/proposals` - latest persisted dry-run proposals
- `GET /api/p2p/live/status` - administrator live mode and safety status
- `POST /api/p2p/live/enable` - verify API permissions and arm live ad updates
- `POST /api/p2p/live/stop` - disarm live updates and latch emergency STOP
- `POST /api/p2p/proposals/:proposalId/apply` - administrator-only validated ad-price update endpoint; automation uses the same server-side safety checks
- `POST /api/operations` - persist an idempotent operation
- `GET /api/operations` - list persisted operations

## Production configuration

Set `NODE_ENV=production`, `PORT`, `CLIENT_ORIGIN`, `DATABASE_URL`, `JWT_SECRET`, `ADMIN_PASSWORD`, and optional Bybit credentials. Place TLS at a reverse proxy, restrict database and application ports, use a dedicated PostgreSQL account, and rotate credentials regularly.

## Backup and recovery

Back up PostgreSQL with `pg_dump`, store encrypted backups outside the application host, and test restores regularly. Use the deployment rollback by rebuilding the previous image and restoring a compatible database backup. Never roll back an in-progress live financial operation without checking Bybit state.

## Known limitations

- PostgreSQL 17+ is required at runtime; Docker is optional.
- P2P order execution, payment confirmation, order completion, asset release, withdrawals, and transfers are not implemented. Advertisement updates require LIVE mode and explicit per-ad automatic opt-in.
- The scanner uses Bybit's first returned verified ad because the documented endpoint does not guarantee sort order. Review candidate selection against your Bybit market before relying on it.
- Notifications are currently in the dashboard and server logs; email, SMS, or messaging-app notifications are not configured.
