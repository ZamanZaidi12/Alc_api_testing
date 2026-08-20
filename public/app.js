const API_BASE = ''; // same origin

// Sample address so every field has a working default: Vitalik's public wallet.
const SAMPLE_ADDR = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const SAMPLE_TX = '0x17104ac9d3312d8c136b7f44d4b8b47852618065ebfa534bd2d3b5ef218ca1f3';

const GROUPS = [
  {
    label: 'account / state',
    routes: [
      {
        id: 'balance',
        title: 'eth_getBalance',
        desc: 'Native ETH balance for an address. Returns hex wei, converted to ETH.',
        method: 'GET',
        build: (v) => `/api/balance/${v.address}?tag=${v.tag}`,
        fields: [
          { name: 'address', label: 'address', default: SAMPLE_ADDR },
          { name: 'tag', label: 'block tag', type: 'select', options: ['latest', 'pending', 'earliest'], default: 'latest' },
        ],
      },
      {
        id: 'code',
        title: 'eth_getCode',
        desc: 'Bytecode at an address. "0x" means it is an EOA, not a contract.',
        method: 'GET',
        build: (v) => `/api/code/${v.address}?tag=${v.tag}`,
        fields: [
          { name: 'address', label: 'address', default: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D' },
          { name: 'tag', label: 'block tag', type: 'select', options: ['latest', 'pending', 'earliest'], default: 'latest' },
        ],
      },
      {
        id: 'account',
        title: 'eth_getAccount',
        desc: 'Newer combined method: balance, nonce, codeHash, storageRoot in one call. Not every node/provider supports this yet.',
        method: 'GET',
        build: (v) => `/api/account/${v.address}?tag=${v.tag}`,
        fields: [
          { name: 'address', label: 'address', default: SAMPLE_ADDR },
          { name: 'tag', label: 'block tag', type: 'select', options: ['latest', 'pending', 'earliest'], default: 'latest' },
        ],
      },
      {
        id: 'token-balances',
        title: 'alchemy_getTokenBalances',
        desc: 'ERC-20 balances for an address. Alchemy-enhanced JSON-RPC method — only works if ETH_RPC_URL points at Alchemy. Raw tokenBalance is a hex base-unit integer with no decimals attached, so the backend fetches token metadata (capped by maxDecode) and adds tokenBalanceFormatted alongside it.',
        method: 'GET',
        build: (v) => `/api/token-balances/${v.address}?maxDecode=${v.maxDecode}`,
        fields: [
          { name: 'address', label: 'address', default: SAMPLE_ADDR },
          { name: 'maxDecode', label: 'max tokens to decode', default: '25' },
        ],
      },
      {
        id: 'tokens-by-wallet',
        title: 'Tokens By Wallet (Data API)',
        desc: 'Alchemy\u2019s newer unified Data API — balances + metadata + live USD price in one call, across networks. Needs ALCHEMY_API_KEY, separate from the JSON-RPC methods above. tokenBalance in the raw response is also hex — the backend adds tokenBalanceFormatted using the decimals already included in tokenMetadata.',
        method: 'GET',
        build: (v) => `/api/tokens-by-wallet/${v.address}?networks=${v.networks}&withMetadata=${v.withMetadata}&withPrices=${v.withPrices}`,
        fields: [
          { name: 'address', label: 'address', default: SAMPLE_ADDR },
          { name: 'networks', label: 'networks (csv)', default: 'eth-mainnet' },
          { name: 'withMetadata', label: 'with metadata', type: 'select', options: ['true', 'false'], default: 'true' },
          { name: 'withPrices', label: 'with prices', type: 'select', options: ['true', 'false'], default: 'true' },
        ],
      },
    ],
  },
  {
    label: 'transfers / traces',
    routes: [
      {
        id: 'asset-transfers',
        title: 'alchemy_getAssetTransfers',
        desc: 'ETH / token transfer history in or out of a wallet. Alchemy-enhanced — the backbone of the BFS hop-expansion work.',
        method: 'GET',
        build: (v) => {
          const p = new URLSearchParams();
          if (v.fromAddress) p.set('fromAddress', v.fromAddress);
          if (v.toAddress) p.set('toAddress', v.toAddress);
          p.set('category', v.category);
          p.set('maxCount', v.maxCount);
          return `/api/asset-transfers?${p.toString()}`;
        },
        fields: [
          { name: 'fromAddress', label: 'from address (optional)', default: SAMPLE_ADDR },
          { name: 'toAddress', label: 'to address (optional)', default: '' },
          { name: 'category', label: 'category (csv)', default: 'external,erc20' },
          { name: 'maxCount', label: 'max count (hex)', default: '0x14' },
        ],
      },
      {
        id: 'best-trace',
        title: '\u2b50 best-trace (works on any free setup)',
        desc: 'Custom endpoint: tries debug_traceTransaction first, and if that 400s (paywalled — the usual case on free tiers), automatically falls back to a reconstruction from eth_getTransactionReceipt logs + Etherscan\u2019s internal transactions. This is the one to reach for by default.',
        method: 'GET',
        build: (v) => `/api/tx/${v.hash}/best-trace?chainid=${v.chainid}`,
        fields: [
          { name: 'hash', label: 'tx hash', default: SAMPLE_TX },
          { name: 'chainid', label: 'chain id', default: '1' },
        ],
      },
      {
        id: 'trace',
        title: 'trace_transaction (paid tier)',
        desc: 'Parity/Erigon-style trace_* namespace. Gated behind a paid plan on Alchemy, QuickNode, and most hosted providers — kept here for comparison.',
        method: 'GET',
        build: (v) => `/api/trace/${v.hash}`,
        fields: [{ name: 'hash', label: 'tx hash', default: SAMPLE_TX }],
      },
      {
        id: 'debug-trace',
        title: 'debug_traceTransaction (raw, paid tier)',
        desc: 'Geth-native debug namespace. Also gated behind paid tiers on most hosted providers — genuinely expensive to compute server-side, so this isn\u2019t a bug on their part. Works if you\u2019re on a paid plan or your own node. callTracer gives a nested call tree; structLog gives an opcode-level step trace (large — storage/memory disabled by default).',
        method: 'GET',
        build: (v) => `/api/debug-trace/${v.hash}?tracer=${v.tracer}`,
        fields: [
          { name: 'hash', label: 'tx hash', default: SAMPLE_TX },
          { name: 'tracer', label: 'tracer', type: 'select', options: ['callTracer', 'structLog'], default: 'callTracer' },
        ],
      },
      {
        id: 'custom-trace',
        title: 'custom-trace (trace_transaction shape, needs debug_traceTransaction)',
        desc: 'Runs debug_traceTransaction and flattens the call tree into the same traceAddress/subtraces/action shape trace_transaction returns. Needs debug_traceTransaction to succeed first — on a free tier, use best-trace above instead.',
        method: 'GET',
        build: (v) => `/api/custom-trace/${v.hash}`,
        fields: [{ name: 'hash', label: 'tx hash', default: SAMPLE_TX }],
      },
      {
        id: 'call-tree',
        title: 'GET /tx/{hash}/trace — full call tree (needs debug_traceTransaction)',
        desc: 'Same debug_traceTransaction data, kept nested instead of flattened, with decimal value/gas and summary stats. Also needs debug_traceTransaction to succeed — on a free tier, use best-trace above instead.',
        method: 'GET',
        build: (v) => `/api/tx/${v.hash}/call-tree`,
        fields: [{ name: 'hash', label: 'tx hash', default: SAMPLE_TX }],
      },
      {
        id: 'expand',
        title: '2-hop wallet expansion (custom)',
        desc: 'Composed endpoint, not a single provider call: walks in + out transfers from alchemy_getAssetTransfers to build a rootTarget \u2192 hop1Neighbors \u2192 hop2Neighbors counterparty graph. This is the synchronous version of the suspect-expansion BFS pattern.',
        method: 'GET',
        build: (v) => `/api/expand/${v.address}?hops=${v.hops}&maxPerHop=${v.maxPerHop}`,
        fields: [
          { name: 'address', label: 'address', default: SAMPLE_ADDR },
          { name: 'hops', label: 'hops', type: 'select', options: ['1', '2'], default: '2' },
          { name: 'maxPerHop', label: 'max neighbors per hop', default: '5' },
        ],
      },
      {
        id: 'internal-tx',
        title: 'Etherscan txlistinternal (by address)',
        desc: 'Internal transactions for an address via Etherscan API v2. Requires ETHERSCAN_API_KEY on the backend.',
        method: 'GET',
        build: (v) => `/api/internal-transactions/${v.address}?startblock=${v.startblock}&endblock=${v.endblock}&chainid=${v.chainid}`,
        fields: [
          { name: 'address', label: 'address', default: SAMPLE_ADDR },
          { name: 'startblock', label: 'start block', default: '0' },
          { name: 'endblock', label: 'end block', default: '99999999' },
          { name: 'chainid', label: 'chain id', default: '1' },
        ],
      },
      {
        id: 'internal-tx-hash',
        title: 'Etherscan txlistinternal (by tx hash)',
        desc: 'Same Etherscan endpoint, filtered to one transaction instead of an address. Requires ETHERSCAN_API_KEY.',
        method: 'GET',
        build: (v) => `/api/internal-transactions/tx/${v.hash}?chainid=${v.chainid}`,
        fields: [
          { name: 'hash', label: 'tx hash', default: SAMPLE_TX },
          { name: 'chainid', label: 'chain id', default: '1' },
        ],
      },
      {
        id: 'logs',
        title: 'eth_getLogs',
        desc: 'Raw event logs, optionally filtered by address and topics.',
        method: 'GET',
        build: (v) => {
          const p = new URLSearchParams();
          if (v.address) p.set('address', v.address);
          p.set('fromBlock', v.fromBlock);
          p.set('toBlock', v.toBlock);
          if (v.topics) p.set('topics', v.topics);
          return `/api/logs?${p.toString()}`;
        },
        fields: [
          { name: 'address', label: 'contract address (optional)', default: '' },
          { name: 'fromBlock', label: 'from block', default: 'latest' },
          { name: 'toBlock', label: 'to block', default: 'latest' },
          { name: 'topics', label: 'topics (csv, optional)', default: '' },
        ],
      },
    ],
  },
  {
    label: 'blocks',
    routes: [
      {
        id: 'block-number',
        title: 'eth_getBlockByNumber',
        desc: 'Block by number (decimal, hex, or "latest").',
        method: 'GET',
        build: (v) => `/api/block/number/${v.number}?full=${v.full}`,
        fields: [
          { name: 'number', label: 'block number / "latest"', default: 'latest' },
          { name: 'full', label: 'full tx objects', type: 'select', options: ['false', 'true'], default: 'false' },
        ],
      },
      {
        id: 'block-hash',
        title: 'eth_getBlockByHash',
        desc: 'Block by block hash.',
        method: 'GET',
        build: (v) => `/api/block/hash/${v.hash}?full=${v.full}`,
        fields: [
          { name: 'hash', label: 'block hash', default: '' },
          { name: 'full', label: 'full tx objects', type: 'select', options: ['false', 'true'], default: 'false' },
        ],
      },
      {
        id: 'tx',
        title: 'eth_getTransactionByHash + Receipt',
        desc: 'Fetches the transaction and its receipt together in one round trip.',
        method: 'GET',
        build: (v) => `/api/tx/${v.hash}`,
        fields: [{ name: 'hash', label: 'tx hash', default: SAMPLE_TX }],
      },
    ],
  },
  {
    label: 'raw',
    routes: [
      {
        id: 'raw-rpc',
        title: 'raw JSON-RPC passthrough',
        desc: 'Call any method directly against ETH_RPC_URL, e.g. eth_blockNumber, eth_chainId, net_version.',
        method: 'POST',
        raw: true,
        fields: [
          { name: 'method', label: 'method', default: 'eth_blockNumber' },
          { name: 'params', label: 'params (JSON array)', default: '[]' },
        ],
      },
    ],
  },
];

const rail = document.getElementById('rail');
const panelBody = document.getElementById('panel-body');
const output = document.getElementById('output');
const statusEl = document.getElementById('status');

let activeId = GROUPS[0].routes[0].id;

function findRoute(id) {
  for (const g of GROUPS) {
    const r = g.routes.find((r) => r.id === id);
    if (r) return r;
  }
  return null;
}

function renderRail() {
  rail.innerHTML = '';
  let idx = 1;
  GROUPS.forEach((group) => {
    const label = document.createElement('div');
    label.className = 'rail-group-label';
    label.textContent = group.label;
    rail.appendChild(label);
    group.routes.forEach((route) => {
      const btn = document.createElement('button');
      btn.className = 'rail-item' + (route.id === activeId ? ' active' : '');
      btn.innerHTML = `<span class="rail-idx">${String(idx).padStart(2, '0')}</span><span>${route.title}</span>`;
      btn.addEventListener('click', () => {
        activeId = route.id;
        renderRail();
        renderPanel();
      });
      rail.appendChild(btn);
      idx++;
    });
  });
}

function renderPanel() {
  const route = findRoute(activeId);
  panelBody.innerHTML = '';

  const title = document.createElement('h2');
  title.className = 'block-title';
  title.textContent = route.title;
  panelBody.appendChild(title);

  const desc = document.createElement('p');
  desc.className = 'block-desc';
  desc.textContent = route.desc;
  panelBody.appendChild(desc);

  const fieldRow = document.createElement('div');
  fieldRow.className = 'field-row';
  const inputs = {};

  route.fields.forEach((f) => {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const label = document.createElement('label');
    label.textContent = f.label;
    wrap.appendChild(label);

    let input;
    if (f.type === 'select') {
      input = document.createElement('select');
      f.options.forEach((opt) => {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        input.appendChild(o);
      });
      input.value = f.default;
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.value = f.default || '';
    }
    wrap.appendChild(input);
    fieldRow.appendChild(wrap);
    inputs[f.name] = input;
  });
  panelBody.appendChild(fieldRow);

  const runRow = document.createElement('div');
  runRow.className = 'run-row';
  const runBtn = document.createElement('button');
  runBtn.className = 'run-btn';
  runBtn.textContent = 'run request';
  runRow.appendChild(runBtn);

  const tag = document.createElement('span');
  tag.className = 'route-tag';
  tag.innerHTML = `<b>${route.method}</b>`;
  runRow.appendChild(tag);
  panelBody.appendChild(runRow);

  runBtn.addEventListener('click', () => runRoute(route, inputs, runBtn, tag));
}

async function runRoute(route, inputs, runBtn, tag) {
  const values = {};
  Object.entries(inputs).forEach(([k, el]) => (values[k] = el.value.trim()));

  runBtn.disabled = true;
  runBtn.textContent = 'running…';
  output.classList.remove('err');
  output.textContent = '// waiting on response…';

  try {
    let res, path;
    if (route.raw) {
      let parsedParams = [];
      try {
        parsedParams = values.params ? JSON.parse(values.params) : [];
      } catch {
        throw new Error('params must be valid JSON, e.g. [] or ["latest", true]');
      }
      path = '/api/rpc';
      tag.innerHTML = `<b>POST</b> ${path}`;
      res = await fetch(API_BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: values.method, params: parsedParams }),
      });
    } else {
      path = route.build(values);
      tag.innerHTML = `<b>${route.method}</b> ${path}`;
      res = await fetch(API_BASE + path);
    }

    const data = await res.json();
    if (!res.ok) {
      output.classList.add('err');
      output.textContent = JSON.stringify(data, null, 2);
    } else {
      output.textContent = JSON.stringify(data, null, 2);
    }
  } catch (err) {
    output.classList.add('err');
    output.textContent = `// request failed\n${err.message}`;
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = 'run request';
  }
}

document.getElementById('clearBtn').addEventListener('click', () => {
  output.classList.remove('err');
  output.textContent = '// cleared';
});

async function checkHealth() {
  try {
    const res = await fetch(API_BASE + '/api/health');
    const data = await res.json();
    if (data.ethRpcConfigured) {
      statusEl.className = 'status status--ok';
      statusEl.textContent = `rpc → ${data.ethRpcHost}`;
    } else {
      statusEl.className = 'status status--error';
      statusEl.textContent = 'ETH_RPC_URL not set';
    }
  } catch {
    statusEl.className = 'status status--error';
    statusEl.textContent = 'backend unreachable';
  }
}

renderRail();
renderPanel();
checkHealth();
