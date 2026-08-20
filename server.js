require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const ETH_RPC_URL = process.env.ETH_RPC_URL || '';
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || '';
const CONSOLE_USERNAME = process.env.CONSOLE_USERNAME || '';
const CONSOLE_PASSWORD = process.env.CONSOLE_PASSWORD || '';
// Etherscan retired the unversioned v1 endpoint — v2 requires a chainid param
// (1 = Ethereum mainnet) but otherwise takes the same module/action params.
// https://docs.etherscan.io/v2-migration
const ETHERSCAN_BASE = 'https://api.etherscan.io/v2/api';

// ---- auth (only active if CONSOLE_USERNAME/CONSOLE_PASSWORD are set) ------
// This is intentionally at the application layer rather than nginx, so it
// works identically whether this is deployed behind your own nginx, or on
// a platform like Render/Railway/Fly that terminates TLS and proxies at
// their own edge (no nginx involved at all in that case).
//
// If you're deploying this somewhere reachable from the public internet —
// which is the case if you're pushing this to GitHub and deploying via a
// PaaS — set both env vars. Every request (frontend and /api/*) will then
// require HTTP Basic Auth. Leave them unset only if you're intentionally
// keeping this open (e.g. still LAN-only behind the nginx allow-list from
// before).
if (CONSOLE_USERNAME && CONSOLE_PASSWORD) {
  app.use((req, res, next) => {
    const header = req.headers.authorization;
    if (header && header.startsWith('Basic ')) {
      const [user, pass] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
      if (user === CONSOLE_USERNAME && pass === CONSOLE_PASSWORD) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="eth-api-console"');
    res.status(401).send('Authentication required.');
  });
  console.log('Basic auth is ENABLED — CONSOLE_USERNAME/CONSOLE_PASSWORD are set.');
} else {
  console.warn(
    '\u26a0\ufe0f  CONSOLE_USERNAME/CONSOLE_PASSWORD are NOT set — this console has NO authentication.\n' +
      '   Anyone who can reach this URL can use it, and it will spend YOUR Alchemy/Etherscan credits.\n' +
      '   Set both env vars before deploying anywhere reachable from the public internet.'
  );
}

app.use(express.static(path.join(__dirname, 'public')));

// ---- rate limiting for /api/* -----------------------------------------
// Application-level (not nginx) so it applies no matter how this is hosted.
// ~5 req/s average with room for bursts from someone clicking through the
// console quickly. Tune via API_RATE_LIMIT_MAX if this is genuinely shared
// by a larger group.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.API_RATE_LIMIT_MAX || '300', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded — too many requests. Try again shortly.' },
});
app.use('/api/', apiLimiter);

// ---- helpers -------------------------------------------------------------

let rpcId = 1;

/** Send a raw JSON-RPC request to whatever ETH_RPC_URL is configured
 *  (Alchemy endpoint or your own Geth node's exposed RPC). */
async function rpcCall(method, params = []) {
  if (!ETH_RPC_URL) {
    const err = new Error('ETH_RPC_URL is not configured on the server (.env)');
    err.status = 500;
    throw err;
  }
  const body = { jsonrpc: '2.0', id: rpcId++, method, params };
  const { data } = await axios.post(ETH_RPC_URL, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 20000,
  });
  if (data.error) {
    const err = new Error(data.error.message || 'RPC error');
    err.status = 400;
    err.rpcError = data.error;
    throw err;
  }
  return data.result;
}

function weiToEth(weiHex) {
  try {
    const wei = BigInt(weiHex);
    // simple decimal formatting without floating point drift for the integer part
    const eth = Number(wei) / 1e18;
    return eth;
  } catch {
    return null;
  }
}

// Alchemy's token endpoints return raw on-chain balances as hex strings
// (e.g. "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000"),
// which is the base-unit integer, not a human-readable amount. Converting it
// requires the token's decimals (18 for most ERC-20s, but not all — USDC is 6).
// This does the hex -> base-unit-integer -> decimal-string conversion without
// floating point, so large balances don't lose precision.
function formatTokenAmount(hexBalance, decimals) {
  if (hexBalance === null || hexBalance === undefined) return null;
  if (decimals === null || decimals === undefined) return null;
  let raw;
  try {
    raw = BigInt(hexBalance);
  } catch {
    return null;
  }
  const d = Number(decimals);
  if (!Number.isInteger(d) || d < 0) return null;
  if (d === 0) return raw.toString();
  const base = 10n ** BigInt(d);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(d, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

function asyncHandler(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error(err.message);
      res.status(err.status || 500).json({
        error: err.message,
        details: err.rpcError || err.response?.data || undefined,
      });
    });
  };
}

// ---- config / health -------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    ethRpcConfigured: Boolean(ETH_RPC_URL),
    ethRpcHost: ETH_RPC_URL ? safeHost(ETH_RPC_URL) : null,
    alchemyKeyConfigured: Boolean(ALCHEMY_API_KEY),
    etherscanConfigured: Boolean(ETHERSCAN_API_KEY),
  });
});

function safeHost(url) {
  try {
    const u = new URL(url);
    return u.hostname; // don't leak the API key path segment
  } catch {
    return 'invalid-url';
  }
}

// ---- 1. eth_getBalance ----------------------------------------------------

app.get('/api/balance/:address', asyncHandler(async (req, res) => {
  const { address } = req.params;
  const tag = req.query.tag || 'latest';
  const result = await rpcCall('eth_getBalance', [address, tag]);
  res.json({ address, tag, balanceWeiHex: result, balanceEth: weiToEth(result) });
}));

// ---- 2. eth_getCode ---------------------------------------------------------

app.get('/api/code/:address', asyncHandler(async (req, res) => {
  const { address } = req.params;
  const tag = req.query.tag || 'latest';
  const result = await rpcCall('eth_getCode', [address, tag]);
  res.json({ address, tag, bytecode: result, isContract: result !== '0x' });
}));

// ---- 3. eth_getAccount (newer method, not all nodes support it) -----------

app.get('/api/account/:address', asyncHandler(async (req, res) => {
  const { address } = req.params;
  const tag = req.query.tag || 'latest';
  const result = await rpcCall('eth_getAccount', [address, tag]);
  res.json({ address, tag, account: result });
}));

// ---- 4. alchemy_getTokenBalances -------------------------------------------
// The raw JSON-RPC response only returns tokenBalance as a hex base-unit
// integer with no decimals attached, so it can't be converted to a human
// amount on its own. This fetches alchemy_getTokenMetadata for each contract
// (capped, so a wallet holding hundreds of tokens doesn't fan out hundreds of
// calls) and attaches a decoded amount + symbol alongside the raw hex.

app.get('/api/token-balances/:address', asyncHandler(async (req, res) => {
  const { address } = req.params;
  const maxDecode = Math.min(parseInt(req.query.maxDecode || '25', 10), 50);
  const result = await rpcCall('alchemy_getTokenBalances', [address]);

  const balances = result.tokenBalances || [];
  const toDecode = balances.slice(0, maxDecode);
  const metadataList = await Promise.all(
    toDecode.map((t) =>
      rpcCall('alchemy_getTokenMetadata', [t.contractAddress]).catch(() => null)
    )
  );

  const decoded = balances.map((t, i) => {
    const meta = i < metadataList.length ? metadataList[i] : null;
    return {
      ...t,
      tokenMetadata: meta || undefined,
      tokenBalanceFormatted: meta ? formatTokenAmount(t.tokenBalance, meta.decimals) : null,
    };
  });

  res.json({
    address: result.address,
    tokenBalances: decoded,
    pageKey: result.pageKey,
    note:
      balances.length > maxDecode
        ? `Only the first ${maxDecode} of ${balances.length} tokens were decoded with metadata (raw hex balances are included for the rest). Raise maxDecode to decode more.`
        : undefined,
  });
}));

// ---- 4b. Alchemy Data API — Tokens by wallet -------------------------------
// Newer unified Data API (not JSON-RPC): POST with an api key in the URL path.
// Returns balances + metadata + live USD price in one call, across networks.
// tokenBalance in the raw response is also a hex base-unit integer — this
// endpoint already gets decimals back in tokenMetadata, so it's decoded
// in-place without any extra calls.

app.get('/api/tokens-by-wallet/:address', asyncHandler(async (req, res) => {
  if (!ALCHEMY_API_KEY) {
    return res.status(500).json({ error: 'ALCHEMY_API_KEY is not configured on the server (.env)' });
  }
  const { address } = req.params;
  const networks = (req.query.networks || 'eth-mainnet').split(',');
  const withMetadata = req.query.withMetadata !== 'false'; // default true
  const withPrices = req.query.withPrices !== 'false'; // default true
  const url = `https://api.g.alchemy.com/data/v1/${ALCHEMY_API_KEY}/assets/tokens/by-address`;
  const { data } = await axios.post(
    url,
    { addresses: [{ address, networks }], withMetadata, withPrices },
    { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
  );

  if (data?.data?.tokens) {
    data.data.tokens = data.data.tokens.map((t) => ({
      ...t,
      tokenBalanceFormatted: formatTokenAmount(t.tokenBalance, t.tokenMetadata?.decimals),
    }));
  }

  res.json(data);
}));

// ---- 5. alchemy_getAssetTransfers ------------------------------------------

app.get('/api/asset-transfers', asyncHandler(async (req, res) => {
  const {
    fromAddress,
    toAddress,
    category = 'external,erc20,erc721,erc1155',
    maxCount = '0x14', // 20
    fromBlock = '0x0',
    toBlock = 'latest',
  } = req.query;

  const params = {
    fromBlock,
    toBlock,
    category: category.split(','),
    maxCount,
    excludeZeroValue: true,
  };
  if (fromAddress) params.fromAddress = fromAddress;
  if (toAddress) params.toAddress = toAddress;

  const result = await rpcCall('alchemy_getAssetTransfers', [params]);
  res.json(result);
}));

// ---- 6. eth_getBlockByNumber / eth_getBlockByHash --------------------------

app.get('/api/block/number/:number', asyncHandler(async (req, res) => {
  const { number } = req.params;
  const full = req.query.full === 'true';
  const tag = /^\d+$/.test(number) ? '0x' + BigInt(number).toString(16) : number; // allow "latest" or decimal
  const result = await rpcCall('eth_getBlockByNumber', [tag, full]);
  res.json(result);
}));

app.get('/api/block/hash/:hash', asyncHandler(async (req, res) => {
  const { hash } = req.params;
  const full = req.query.full === 'true';
  const result = await rpcCall('eth_getBlockByHash', [hash, full]);
  res.json(result);
}));

// ---- 7. eth_getTransactionByHash + eth_getTransactionReceipt --------------

app.get('/api/tx/:hash', asyncHandler(async (req, res) => {
  const { hash } = req.params;
  const [tx, receipt] = await Promise.all([
    rpcCall('eth_getTransactionByHash', [hash]),
    rpcCall('eth_getTransactionReceipt', [hash]),
  ]);
  res.json({ transaction: tx, receipt });
}));

// ---- 8. trace_transaction (Parity/Erigon-style trace_* namespace) ---------
// NOTE: both trace_transaction and debug_traceTransaction are gated behind
// paid tiers on Alchemy, QuickNode, and most other hosted providers — running
// a full trace is genuinely expensive server-side, so "free tier" almost
// never includes either. debug-trace/custom-trace/call-tree below are kept
// as-is for when you're pointed at a provider or self-hosted node that does
// support debug_traceTransaction (e.g. a paid plan, or your own archive
// node). For a route that works on literally any free setup, see
// /api/tx/:hash/best-trace further down — it tries debug_traceTransaction
// first and automatically falls back to a free reconstruction if that 400s.

app.get('/api/trace/:hash', asyncHandler(async (req, res) => {
  const { hash } = req.params;
  const result = await rpcCall('trace_transaction', [hash]);
  res.json(result);
}));

// ---- 8b. debug_traceTransaction (raw) --------------------------------------
// Geth-native debug namespace. Works on paid provider tiers or a self-hosted
// node; will 400 on most free hosted tiers (see note above).

app.get('/api/debug-trace/:hash', asyncHandler(async (req, res) => {
  const { hash } = req.params;
  const tracer = req.query.tracer || 'callTracer';
  let tracerConfig = {};
  if (req.query.tracerConfig) {
    try {
      tracerConfig = JSON.parse(req.query.tracerConfig);
    } catch {
      return res.status(400).json({ error: 'tracerConfig must be valid JSON' });
    }
  }
  const options =
    tracer === 'structLog'
      ? { disableStorage: true, disableMemory: true, ...tracerConfig }
      : { tracer, tracerConfig };
  const result = await rpcCall('debug_traceTransaction', [hash, options]);
  res.json(result);
}));

// ---- 8c. custom: trace_transaction-equivalent, built for free -------------
// Runs debug_traceTransaction with callTracer (free/native) and flattens the
// resulting nested call tree into the same traceAddress/subtraces/action
// shape that the paid trace_transaction call returns, so this is a drop-in
// substitute wherever code was written against that response shape.

function flattenCallTree(node, traceAddress, ctx, out) {
  const isCreate = node.type === 'CREATE' || node.type === 'CREATE2';
  const item = {
    action: isCreate
      ? { from: node.from, gas: node.gas, init: node.input, value: node.value || '0x0' }
      : { callType: node.type.toLowerCase(), from: node.from, gas: node.gas, input: node.input, to: node.to, value: node.value || '0x0' },
    blockHash: ctx.blockHash,
    blockNumber: ctx.blockNumber,
    error: node.error || undefined,
    result: node.error ? undefined : { gasUsed: node.gasUsed, output: node.output || '0x' },
    subtraces: (node.calls || []).length,
    traceAddress,
    transactionHash: ctx.hash,
    transactionPosition: ctx.transactionPosition,
    type: isCreate ? 'create' : 'call',
  };
  out.push(item);
  (node.calls || []).forEach((child, i) => flattenCallTree(child, [...traceAddress, i], ctx, out));
}

app.get('/api/custom-trace/:hash', asyncHandler(async (req, res) => {
  const { hash } = req.params;
  const [callTree, tx] = await Promise.all([
    rpcCall('debug_traceTransaction', [hash, { tracer: 'callTracer' }]),
    rpcCall('eth_getTransactionByHash', [hash]),
  ]);
  const ctx = {
    hash,
    blockHash: tx ? tx.blockHash : null,
    blockNumber: tx ? tx.blockNumber : null,
    transactionPosition: tx ? tx.transactionIndex : null,
  };
  const out = [];
  flattenCallTree(callTree, [], ctx, out);
  res.json(out);
}));

// ---- 8d. custom: GET /tx/:hash/call-tree — full nested call tree ----------
// The other view of the same debug_traceTransaction data: instead of
// flattening, keep the nesting and add decimal value/gas conversions plus
// summary stats (depth, delegatecall/staticcall counts) that are handy for
// a quick read without post-processing on the client.

function simplifyNode(node, depth) {
  let valueEth = 0;
  try {
    valueEth = node.value ? Number(BigInt(node.value)) / 1e18 : 0;
  } catch {
    valueEth = 0;
  }
  return {
    type: node.type,
    depth,
    from: node.from,
    to: node.to || null,
    valueEth,
    gasUsed: node.gasUsed ? parseInt(node.gasUsed, 16) : 0,
    error: node.error || null,
    calls: (node.calls || []).map((c) => simplifyNode(c, depth + 1)),
  };
}

function collectStats(node, stats) {
  stats.totalCalls += 1;
  stats.maxDepth = Math.max(stats.maxDepth, node.depth);
  if (node.type === 'DELEGATECALL') stats.delegateCalls += 1;
  if (node.type === 'STATICCALL') stats.staticCalls += 1;
  if (node.type === 'CREATE' || node.type === 'CREATE2') stats.creates += 1;
  if (node.error) stats.errors += 1;
  node.calls.forEach((c) => collectStats(c, stats));
  return stats;
}

app.get('/api/tx/:hash/call-tree', asyncHandler(async (req, res) => {
  const { hash } = req.params;
  const raw = await rpcCall('debug_traceTransaction', [hash, { tracer: 'callTracer' }]);
  const callTree = simplifyNode(raw, 0);
  const stats = collectStats(callTree, {
    totalCalls: 0,
    maxDepth: 0,
    delegateCalls: 0,
    staticCalls: 0,
    creates: 0,
    errors: 0,
  });
  res.json({ transactionHash: hash, stats, callTree });
}));

// ---- 8e. custom: best-effort trace, free on literally any setup -----------
// debug_traceTransaction is paywalled on most hosted free tiers (Alchemy,
// QuickNode, etc.) — it's genuinely expensive to compute, so this isn't an
// oversight on their part. This route tries it first (works if you're on a
// paid plan or your own node), and if that 400s, falls back to a
// reconstruction built entirely from data that IS free everywhere:
//   - eth_getTransactionByHash / eth_getTransactionReceipt (top-level call,
//     status, gas used — always free, standard JSON-RPC)
//   - receipt logs, decoded for ERC-20/721 Transfer events (free, no extra call)
//   - Etherscan's txlistinternal filtered by txhash (free with an API key —
//     Etherscan computes the trace server-side on their own infra and hands
//     back just the ETH-value internal transfers)
// This will NOT catch internal calls that move no ETH and emit no event log
// (e.g. a bare DELEGATECALL used only for a state read) — that detail is
// only recoverable from a real trace. Everything else — value flow, token
// transfers, contract creations with value — comes through.

const ERC20_721_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function decodeTransferLogs(logs) {
  return (logs || []).map((log) => {
    if (log.topics && log.topics[0] === ERC20_721_TRANSFER_TOPIC) {
      const isErc721 = log.topics.length === 4; // 3 indexed args + topic0 => ERC-721
      const from = '0x' + log.topics[1].slice(26);
      const to = '0x' + log.topics[2].slice(26);
      if (isErc721) {
        let tokenId = null;
        try {
          tokenId = BigInt(log.topics[3]).toString();
        } catch {
          /* leave null */
        }
        return { contract: log.address, event: 'Transfer (ERC-721)', from, to, tokenId, logIndex: log.logIndex };
      }
      let value = null;
      try {
        value = BigInt(log.data).toString();
      } catch {
        /* leave null */
      }
      return { contract: log.address, event: 'Transfer (ERC-20)', from, to, valueBaseUnits: value, logIndex: log.logIndex };
    }
    return { contract: log.address, event: 'unknown', topics: log.topics, data: log.data, logIndex: log.logIndex };
  });
}

app.get('/api/tx/:hash/best-trace', asyncHandler(async (req, res) => {
  const { hash } = req.params;
  const chainid = req.query.chainid || '1';

  const [tx, receipt] = await Promise.all([
    rpcCall('eth_getTransactionByHash', [hash]),
    rpcCall('eth_getTransactionReceipt', [hash]),
  ]);

  // Try the real trace first — succeeds if ETH_RPC_URL is a paid plan or your own node.
  try {
    const raw = await rpcCall('debug_traceTransaction', [hash, { tracer: 'callTracer' }]);
    const callTree = simplifyNode(raw, 0);
    const stats = collectStats(callTree, {
      totalCalls: 0,
      maxDepth: 0,
      delegateCalls: 0,
      staticCalls: 0,
      creates: 0,
      errors: 0,
    });
    return res.json({ source: 'debug_traceTransaction', transactionHash: hash, stats, callTree });
  } catch {
    // fall through to the free reconstruction below
  }

  const decodedLogs = decodeTransferLogs(receipt?.logs);

  let internalTransfers = [];
  let internalTransfersNote;
  if (ETHERSCAN_API_KEY) {
    try {
      const { data } = await axios.get(ETHERSCAN_BASE, {
        params: { chainid, module: 'account', action: 'txlistinternal', txhash: hash, apikey: ETHERSCAN_API_KEY },
        timeout: 20000,
      });
      if (data.status === '1') {
        internalTransfers = data.result;
      } else if (data.message !== 'No transactions found') {
        internalTransfersNote = typeof data.result === 'string' ? data.result : data.message;
      }
    } catch (e) {
      internalTransfersNote = `Etherscan lookup failed: ${e.message}`;
    }
  } else {
    internalTransfersNote = 'ETHERSCAN_API_KEY not configured — internal ETH transfers are omitted. Set it in .env to include them.';
  }

  res.json({
    source: 'fallback: receipt + decoded logs + Etherscan internal transactions',
    note:
      'debug_traceTransaction is unavailable on this RPC endpoint\u2019s current plan. This reconstruction covers the top-level call, all Transfer event logs, and ETH-value internal transfers — it will not show internal calls that move no ETH and emit no log.',
    transactionHash: hash,
    topLevelCall: {
      from: tx?.from,
      to: tx?.to,
      valueWei: tx?.value,
      gas: tx?.gas,
      status: receipt?.status,
      gasUsed: receipt?.gasUsed,
      contractAddress: receipt?.contractAddress,
    },
    decodedLogs,
    internalTransfers,
    internalTransfersNote,
  });
}));

// ---- 9. eth_getLogs ---------------------------------------------------------

app.get('/api/logs', asyncHandler(async (req, res) => {
  const { address, fromBlock = '0x0', toBlock = 'latest', topics } = req.query;
  const filter = { fromBlock, toBlock };
  if (address) filter.address = address;
  if (topics) filter.topics = topics.split(',').map((t) => (t === '' ? null : t));
  const result = await rpcCall('eth_getLogs', [filter]);
  res.json(result);
}));

// ---- custom: 2-hop wallet expansion ----------------------------------------
// Not a wrapper around a single provider call — this composes
// alchemy_getAssetTransfers (in + out) at each hop to build a small
// counterparty graph, capped at 2 hops so it stays fast and bounded.
// This is the manual, synchronous version of the async suspect-expansion
// job pattern from the forensics API design.

async function getNeighbors(address, maxNeighbors) {
  const maxCountHex = '0x' + Math.min(maxNeighbors * 4, 100).toString(16); // over-fetch, then rank+trim
  const baseParams = {
    fromBlock: '0x0',
    toBlock: 'latest',
    category: ['external', 'erc20'],
    maxCount: maxCountHex,
    excludeZeroValue: true,
  };

  const [outRes, inRes] = await Promise.all([
    rpcCall('alchemy_getAssetTransfers', [{ ...baseParams, fromAddress: address }]),
    rpcCall('alchemy_getAssetTransfers', [{ ...baseParams, toAddress: address }]),
  ]);

  const neighbors = new Map();

  const record = (counterparty, direction, transfer) => {
    if (!counterparty) return;
    const key = counterparty.toLowerCase();
    if (!neighbors.has(key)) {
      neighbors.set(key, {
        address: counterparty,
        relationship: direction, // OUTFLOW, INFLOW, or BOTH
        totalVolume: 0,
        txHashes: [],
      });
    }
    const n = neighbors.get(key);
    if (n.relationship !== direction) n.relationship = 'BOTH';
    n.totalVolume += Number(transfer.value || 0);
    if (n.txHashes.length < 5 && !n.txHashes.includes(transfer.hash)) n.txHashes.push(transfer.hash);
  };

  (outRes.transfers || []).forEach((t) => record(t.to, 'OUTFLOW', t));
  (inRes.transfers || []).forEach((t) => record(t.from, 'INFLOW', t));

  return Array.from(neighbors.values())
    .sort((a, b) => b.totalVolume - a.totalVolume)
    .slice(0, maxNeighbors)
    .map((n) => ({ ...n, totalVolume: Number(n.totalVolume.toFixed(6)) }));
}

app.get('/api/expand/:address', asyncHandler(async (req, res) => {
  const { address } = req.params;
  const hops = Math.max(1, Math.min(parseInt(req.query.hops || '2', 10), 2)); // capped at 2
  const maxPerHop = Math.max(1, Math.min(parseInt(req.query.maxPerHop || '5', 10), 15));

  const hop1Neighbors = await getNeighbors(address, maxPerHop);

  let hop2Neighbors = [];
  if (hops >= 2 && hop1Neighbors.length > 0) {
    const perParent = await Promise.all(
      hop1Neighbors.map(async (n) => {
        const neighbors = await getNeighbors(n.address, maxPerHop);
        // drop the root itself and the hop1 node's own parent edge from hop2 results
        return neighbors
          .filter((n2) => n2.address.toLowerCase() !== address.toLowerCase())
          .map((n2) => ({ parentHop1Address: n.address, ...n2 }));
      })
    );
    hop2Neighbors = perParent.flat();
  }

  res.json({
    rootTarget: address,
    hops,
    maxPerHop,
    hop1Neighbors,
    hop2Neighbors,
  });
}));

// ---- 10. Etherscan internal transactions (txlistinternal) -----------------

app.get('/api/internal-transactions/:address', asyncHandler(async (req, res) => {
  if (!ETHERSCAN_API_KEY) {
    return res.status(500).json({ error: 'ETHERSCAN_API_KEY is not configured on the server (.env)' });
  }
  const { address } = req.params;
  const {
    startblock = '0',
    endblock = '99999999',
    page = '1',
    offset = '50',
    sort = 'desc',
    chainid = '1', // 1 = Ethereum mainnet; see https://docs.etherscan.io/v2-migration#chain-list
  } = req.query;
  const { data } = await axios.get(ETHERSCAN_BASE, {
    params: {
      chainid,
      module: 'account',
      action: 'txlistinternal',
      address,
      startblock,
      endblock,
      page,
      offset,
      sort,
      apikey: ETHERSCAN_API_KEY,
    },
    timeout: 20000,
  });
  res.json(data);
}));

// ---- 10b. Etherscan internal transactions by tx hash -----------------------
// Same endpoint, filtered by a single transaction instead of an address —
// this is the one best-trace uses under the hood, exposed standalone too
// since it's useful on its own.

app.get('/api/internal-transactions/tx/:hash', asyncHandler(async (req, res) => {
  if (!ETHERSCAN_API_KEY) {
    return res.status(500).json({ error: 'ETHERSCAN_API_KEY is not configured on the server (.env)' });
  }
  const { hash } = req.params;
  const chainid = req.query.chainid || '1';
  const { data } = await axios.get(ETHERSCAN_BASE, {
    params: { chainid, module: 'account', action: 'txlistinternal', txhash: hash, apikey: ETHERSCAN_API_KEY },
    timeout: 20000,
  });
  res.json(data);
}));

// ---- 11. generic raw JSON-RPC passthrough (for any method not wrapped above) --

app.post('/api/rpc', asyncHandler(async (req, res) => {
  const { method, params = [] } = req.body;
  if (!method) return res.status(400).json({ error: 'method is required' });
  const result = await rpcCall(method, params);
  res.json({ method, params, result });
}));

app.listen(PORT, () => {
  console.log(`Eth API tester backend running on http://localhost:${PORT}`);
  console.log(`RPC target: ${ETH_RPC_URL ? safeHost(ETH_RPC_URL) : '(not configured)'}`);
});
