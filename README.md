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



*

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
- The receipt's logs, decoded for ERC-20/721 `Transfer` events — free, no
  extra call, just parsing what the receipt already returned.
- Etherscan's `txlistinternal` filtered by `txhash` — free with an API key.
  Etherscan computes the trace server-side on their own infrastructure and
  hands back just the ETH-value internal transfers.

The one thing this can't recover: an internal call that moves no ETH and
emits no event log — e.g. a bare `DELEGATECALL` used only to read state.
That detail only exists in a real trace. Everything with money or token
movement attached — value flow, token transfers, contract creations with
value — comes through in the fallback.

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
