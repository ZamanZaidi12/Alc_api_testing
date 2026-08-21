# eth-api-console

A small Node.js/Express backend + vanilla-JS frontend for exercising the Ethereum
data APIs referenced in your forensics platform design: standard JSON-RPC methods
(`eth_getBalance`, `eth_getCode`, `eth_getBlockByNumber`, etc.), Alchemy-enhanced
methods (`alchemy_getTokenBalances`, `alchemy_getAssetTransfers`), `trace_transaction`,
`eth_getLogs`, and Etherscan's `txlistinternal`.

The backend exists mainly so your API key never touches the browser, and so you can
point `ETH_RPC_URL` at either Alchemy or your self-hosted Geth node's exposed RPC
without changing any frontend code — same test console either way. That makes it a
convenient way to sanity-check that your own node returns the same shapes as Alchemy
before you build the forensics API layer on top of it.

## Setup

```bash
npm install
cp .env.example .env
# edit .env: set ETH_RPC_URL (Alchemy URL or http://<server-lan-ip>:8545),
# and optionally ALCHEMY_API_KEY / ETHERSCAN_API_KEY
npm start
```

Then open `http://localhost:3001` (or the LAN IP, if running on your shared office
server and connecting from your laptop).

## Putting nginx in front of it

Two ways to do this — pick whichever fits how you already work.

### Option A: Docker Compose (easiest, works the same on any OS)

```bash
cp .env.example .env
# fill in .env as above
docker compose up --build
```

Open `http://localhost:8080` — nginx is on 8080, proxying to the Node app
running in its own container on the internal `app:3001`. No native nginx
install needed.

### Option B: native nginx + `npm start`

If you'd rather not use Docker:

```bash
# macOS (Homebrew)
brew install nginx
cp nginx/eth-api-console.conf /opt/homebrew/etc/nginx/servers/
brew services restart nginx

# Ubuntu/Debian
sudo apt install nginx
sudo cp nginx/eth-api-console.conf /etc/nginx/sites-available/eth-api-console
sudo ln -s /etc/nginx/sites-available/eth-api-console /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Then run the app as usual (`npm start`) and open `http://localhost:8080`
instead of `:3001`.

### Why bother with nginx for local testing at all

- **Rate limiting** (`limit_req_zone`, 10 req/s with a burst of 20) sits in
  front of `/api/*` — this is the actual reason it's worth doing here: a
  stray retry loop or an accidental double-click on "run request" can't
  silently burn through metered Alchemy/Etherscan credits, since nginx
  starts returning `503`s before the requests even reach your backend.
- One clean port to remember instead of `:3001`.
- gzip + basic security headers (`X-Content-Type-Options`, `X-Frame-Options`).
- A real place to terminate TLS later if this ever needs to be reachable
  beyond your own laptop.

Both configs (`nginx/eth-api-console.conf` for native, `nginx/docker.conf`
for Compose) were tested with `nginx -t` and end-to-end with real requests —
including confirming the rate limiter actually returns `503`s once you
exceed the burst.

## Exposing it to other people on your network

Both nginx configs now restrict access to **private IP ranges only**
(`127.0.0.1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) with no login
required. That's a deliberate trade-off: your teammates on the same
LAN/office network can just open the URL and use it, but the port stays
closed to the public internet even if it's ever accidentally forwarded on a
router — nginx returns a `403` to anything outside those ranges before the
request reaches your backend. This was tested directly: a simulated private
IP got a `200`, a simulated public IP got a `403`.

**If this ever needs to be reachable from outside your network** (not just
your LAN), don't just remove the `allow`/`deny` block — add real
authentication first (e.g. HTTP Basic Auth via nginx, or an API-key check in
the Express backend) and put it behind HTTPS. Happy to set that up when you
know the actual audience.

### Steps to let teammates reach it

**1. Find your laptop's LAN IP:**

```bash
# macOS
ipconfig getifaddr en0     # or en1 if you're on Wi-Fi vs Ethernet

# Linux
hostname -I | awk '{print $1}'

# Windows (PowerShell)
ipconfig | findstr IPv4
```

**2. Open the port on your host firewall** (nginx allowing the IP range
isn't enough on its own — the OS firewall has to let the connection through
in the first place):

```bash
# macOS: System Settings → Network → Firewall → Options → allow incoming
# connections for nginx, or temporarily:
sudo pfctl -d   # disables the firewall entirely — fine for a quick office
                # demo, but re-enable after (sudo pfctl -e)

# Ubuntu/Debian (ufw)
sudo ufw allow from 192.168.0.0/16 to any port 8080
sudo ufw allow from 10.0.0.0/8 to any port 8080

# Windows (PowerShell, run as Administrator)
New-NetFirewallRule -DisplayName "eth-api-console" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow
```

**3. Share `http://<your-lan-ip>:8080`** with your teammates. They need to
be on the same network — same office Wi-Fi/Ethernet, or same VPN if your
office uses one.

**Docker Compose caveat:** on Docker Desktop (macOS/Windows), traffic passes
through Docker's internal VM, and depending on your Docker Desktop version
the source IP nginx sees (`$remote_addr`) may show up as an internal Docker
address rather than your teammate's real LAN IP — which would make the
allow-list see everything as "not private" and block it, or as
"127.0.0.1"-ish and allow it too broadly. If teammates on Docker Desktop
can't reach it or the allow-list doesn't behave as expected, that's the
likely cause — the native nginx option (Option B) doesn't have this issue
since nginx sees real source IPs directly.

## Deploying to the public internet (GitHub \u2192 Render)

Pushing this repo to GitHub doesn't expose anything by itself — GitHub is
just source control, nothing runs there. What actually makes this reachable
from the public internet is deploying it somewhere that runs the server,
and pointing that at your GitHub repo so it deploys automatically on push.
[Render](https://render.com) is a straightforward fit here since it builds
directly from a `Dockerfile` (already in this repo) and gives you a public
HTTPS URL with no server management.

**This path skips nginx entirely.** Render terminates TLS and reverse-proxies
at its own edge, so there's no nginx container in this deployment — that's
why auth (`CONSOLE_USERNAME`/`CONSOLE_PASSWORD`) and rate limiting
(`API_RATE_LIMIT_MAX`) were moved into `server.js` itself rather than left
as nginx-only config: they now protect this console no matter how it's
hosted. The nginx setup from the sections above is still there and still
useful for the LAN/VPS path — just not part of this one.

### Before you push: protect your secrets

1. **Never commit `.env`.** A `.gitignore` is already included that excludes
   it — double-check `git status` doesn't show `.env` before your first
   commit.
2. **Set `CONSOLE_USERNAME`/`CONSOLE_PASSWORD` before deploying.** Without
   them, anyone who finds the URL can use this console and spend your
   Alchemy/Etherscan credits — the backend prints a loud warning on startup
   if they're unset, precisely so this isn't easy to miss.

### Deploy

```bash
git init                       # if this isn't already a repo
git add .
git commit -m "eth-api-console"
git remote add origin https://github.com/<you>/eth-api-console.git
git push -u origin main
```

Then on Render:

1. **New → Blueprint**, connect your GitHub account, and select the repo.
   Render reads `render.yaml` (already included) and sets up the service.
2. On the service's **Environment** tab, fill in the real values for
   `ETH_RPC_URL`, `ALCHEMY_API_KEY`, `ETHERSCAN_API_KEY`,
   `CONSOLE_USERNAME`, and `CONSOLE_PASSWORD` — Render prompts for these
   during Blueprint setup and stores them as encrypted secrets, never in
   the repo.
3. Deploy. Render gives you a URL like
   `https://eth-api-console.onrender.com` — HTTPS included automatically.

From then on, every `git push` to `main` redeploys automatically
(`autoDeploy: true` in `render.yaml`).

**Free-tier note:** Render's free web services spin down after periods of
inactivity and take a few seconds to wake back up on the next request —
fine for a shared testing tool, worth knowing so a slow first request
doesn't look like a bug.

**Alternative platforms:** Railway and Fly.io work the same way — connect
the GitHub repo, they detect the `Dockerfile`, you set the same env vars in
their dashboard. No `render.yaml`-equivalent is included for those, but the
Dockerfile-based build is identical.

**If you'd rather run this on a VPS instead of a PaaS:** the Docker Compose
+ nginx setup from the sections above still applies — `git clone` the repo
on the VPS, `docker compose up -d`, and put nginx behind a real TLS cert
(e.g. via `certbot`) instead of the private-IP allow-list, since the VPS
would now be genuinely public. That's a bigger step than the Render path
above; ask if you want it built out.

## Layout

```
server.js             Express backend — one route per API, all proxied through
                       axios so the browser never sees your API keys. Also
                       where CONSOLE_USERNAME/PASSWORD auth and the /api/*
                       rate limiter live, so they apply regardless of host.
public/index.html      Console shell.
public/app.js           Endpoint registry + form rendering + fetch calls.
public/style.css        Styling.
.env.example             Copy to .env and fill in.
.gitignore                Keeps .env and node_modules out of git.
Dockerfile               Builds the Node app for docker-compose or Render.
docker-compose.yml        App + nginx together (LAN/VPS path).
render.yaml                Render Blueprint for GitHub -> public deploy.
nginx/eth-api-console.conf  nginx config for a native install (LAN/VPS).
nginx/docker.conf            nginx config used by docker-compose.
```

## Routes

| Method | Path                                   | Wraps                                  |
|--------|-----------------------------------------|-----------------------------------------|
| GET    | `/api/health`                           | reports current RPC target / key config |
| GET    | `/api/balance/:address`                 | `eth_getBalance`                        |
| GET    | `/api/code/:address`                    | `eth_getCode`                           |
| GET    | `/api/account/:address`                 | `eth_getAccount`                        |
| GET    | `/api/token-balances/:address`          | `alchemy_getTokenBalances`              |
| GET    | `/api/tokens-by-wallet/:address`        | Alchemy Data API "Tokens By Wallet"     |
| GET    | `/api/asset-transfers`                  | `alchemy_getAssetTransfers`             |
| GET    | `/api/expand/:address`                  | custom: 2-hop counterparty expansion    |
| GET    | `/api/block/number/:number`             | `eth_getBlockByNumber`                  |
| GET    | `/api/block/hash/:hash`                 | `eth_getBlockByHash`                    |
| GET    | `/api/tx/:hash`                         | `eth_getTransactionByHash` + receipt    |
| GET    | `/api/tx/:hash/best-trace`              | ⭐ custom: trace that works on any free setup |
| GET    | `/api/trace/:hash`                      | `trace_transaction` (paid tier)         |
| GET    | `/api/debug-trace/:hash`                | `debug_traceTransaction` (raw, paid tier) |
| GET    | `/api/custom-trace/:hash`               | custom: trace_transaction shape (needs debug_traceTransaction) |
| GET    | `/api/tx/:hash/call-tree`               | custom: full nested call tree (needs debug_traceTransaction) |
| GET    | `/api/logs`                             | `eth_getLogs`                           |
| GET    | `/api/internal-transactions/:address`   | Etherscan `txlistinternal` by address   |
| GET    | `/api/internal-transactions/tx/:hash`   | Etherscan `txlistinternal` by tx hash   |
| POST   | `/api/rpc` `{method, params}`           | any raw JSON-RPC method                 |

Every route defaults to a real address/tx hash (Vitalik's public wallet, Uniswap
router, a sample tx hash) so you can hit "run request" with no typing to confirm
wiring, then swap in whatever you're actually investigating.

## Trace routes: paid vs. free

Both `trace_transaction` (Parity/Erigon `trace_*` namespace) **and**
`debug_traceTransaction` (Geth's native debug namespace) are gated behind
paid tiers on Alchemy, QuickNode, and most other hosted providers — running a
full trace is genuinely expensive to compute server-side, so this isn't a
bug or a stingy free tier, it's standard across the industry. On Alchemy's
free tier you'll see:

```json
{ "error": { "code": -32600, "message": "debug_traceTransaction is not available on the Free tier..." } }
```

**`/api/tx/:hash/best-trace` is the route to reach for on a free setup.** It
tries `debug_traceTransaction` first (so it upgrades automatically if you
later move to a paid plan or your own node), and if that 400s, falls back to
a reconstruction built entirely from sources that are free everywhere:

- `eth_getTransactionByHash` / `eth_getTransactionReceipt` — top-level call,
  status, gas used. Standard JSON-RPC, free on every tier.
- The receipt's logs, decoded for ERC-20/721 `Transfer` events **and WETH
  `Deposit`/`Withdrawal` events** — free, no extra call, just parsing what
  the receipt already returned. The WETH events matter because wrapping/
  unwrapping ETH is one of the most common "invisible" legs in a DeFi trace
  — WETH9 emits `Deposit`/`Withdrawal`, not `Transfer`, when it receives or
  releases raw ETH, so it needs separate decoding or it silently vanishes.
- Etherscan's `txlistinternal` filtered by `txhash` — free with an API key.
  Etherscan computes the trace server-side on their own infrastructure and
  hands back just the ETH-value internal transfers.

**Hard limit, not a bug:** this can never show a call that moves no ETH and
emits no event log (e.g. a bare `STATICCALL`/`DELEGATECALL` used only to
read state or run library logic). That information genuinely doesn't exist
anywhere outside the EVM's own execution trace — no combination of log
decoding or additional free APIs can recover it, because it was never
written anywhere except transient execution state. Everything with money,
tokens, or wrapped ETH attached comes through in the fallback; pure
control-flow calls don't and structurally can't.

**Also worth knowing:** Etherscan's `txlistinternal` API can itself return
fewer internal transfers than what their own website shows for the same
transaction, particularly on complex multi-call DeFi transactions (flash-
accounting patterns like Uniswap V4's `unlock()` callback are a known
example). This isn't something `best-trace` can compensate for — it's
faithfully relaying whatever Etherscan's API returns, which is sometimes a
subset of their site's richer internal indexing. If a transaction's real
trace matters enough to need ground truth, `debug_traceTransaction` (paid
tier, or pointing `ETH_RPC_URL` at your own node) is the only source immune
to this gap, since it reads the EVM's execution directly rather than through
someone else's index.

The other trace routes are kept for when you *do* have `debug_traceTransaction`
access (a paid plan, or your own node):

- **`/api/debug-trace/:hash?tracer=callTracer|structLog`** — raw passthrough.
  `callTracer` returns a small nested call tree; `structLog` returns Geth's
  opcode-level step trace (storage/memory disabled by default to keep it a
  reasonable size — pass `tracerConfig={"disableStorage":false}` to include them).
- **`/api/custom-trace/:hash`** — takes the `callTracer` output and flattens
  it into the exact `action` / `result` / `subtraces` / `traceAddress` shape
  that `trace_transaction` returns, so it's a drop-in substitute for anywhere
  the platform design assumed that response shape.
- **`/api/tx/:hash/call-tree`** — the other view of the same data: kept
  nested instead of flattened, with hex value/gas converted to decimal and
  summary stats (`maxDepth`, `delegateCalls`, `staticCalls`, `creates`,
  `errors`) rolled up at the top. This is the literal "full call tree for one
  transaction" endpoint.

One more caveat if you do get `debug_traceTransaction` access:  it needs
either an archive node or a transaction recent enough to still have its
pre-state available. On your own Geth node that means running in archive
mode (`--gcmode=archive`) or accepting that older transactions may 404.

## 2-hop wallet expansion (`/api/expand/:address`)

Not a wrapper around one provider call — it composes `alchemy_getAssetTransfers`
(in and out) to build a small counterparty graph, in the same
`rootTarget → hop1Neighbors → hop2Neighbors` shape as the BFS expansion design:

```
GET /api/expand/0xabc...?hops=2&maxPerHop=5
```

- `hops` — 1 or 2 (capped at 2 to keep it fast and synchronous; more hops is
  exactly the case the async job-pattern in your suspect-expansion design was
  meant for).
- `maxPerHop` — how many top counterparties to keep per node, ranked by total
  transfer volume (capped at 15).
- Each hop-1 node then gets its own in/out lookup to produce hop-2, so total
  provider calls are roughly `2 + 2 × hop1Neighbors.length` — fine for a quick
  test, but something to be mindful of if you wire this into a UI that lets
  people crank `maxPerHop` up.

## Notes

- The Alchemy-enhanced JSON-RPC routes (`token-balances`, `asset-transfers`,
  `expand`) will return an error if `ETH_RPC_URL` points at a plain Geth node
  rather than Alchemy — Geth doesn't implement those methods. That's expected;
  it's a useful way to confirm which calls need to stay on Alchemy vs. which
  can move to your own node.
- "Tokens By Wallet" is a *different* Alchemy product — the newer Data API,
  not JSON-RPC. It always calls `api.g.alchemy.com` directly using
  `ALCHEMY_API_KEY`, independent of what `ETH_RPC_URL` is set to.
- **Token balances are hex, not decimal.** Both token routes return
  `tokenBalance` as a raw hex base-unit integer straight from the chain (e.g.
  `0x0de0b6b3a7640000`) — that's correct on Alchemy's part, not a bug, but it's
  not human-readable without knowing the token's decimals (18 for most
  ERC-20s, but e.g. 6 for USDC/USDT). Both routes here add a
  `tokenBalanceFormatted` field alongside the raw hex:
  - `tokens-by-wallet` already gets `decimals` back in `tokenMetadata`, so
    it's decoded with no extra calls.
  - `token-balances` (the JSON-RPC method) doesn't return decimals at all, so
    the backend calls `alchemy_getTokenMetadata` per contract to get them —
    capped by `maxDecode` (default 25) so a wallet holding hundreds of tokens
    doesn't fan out hundreds of extra calls. Raise `maxDecode` if you need more
    decoded, or read `tokenBalance` + fetch metadata yourself for the rest.
- `eth_getAccount` is a newer JSON-RPC method; not all providers/node versions
  support it yet, so a "method not found" here is informative, not a bug.
- The internal-transactions route needs `ETHERSCAN_API_KEY` and calls
  Etherscan's **v2** API (`api.etherscan.io/v2/api` with a `chainid` param) —
  Etherscan retired the old unversioned v1 endpoint.
- No API keys ever reach the browser; the frontend only ever talks to your own
  backend on `localhost`.
