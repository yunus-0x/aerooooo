// app/api/positions-rpc/route.ts
import { NextRequest, NextResponse } from "next/server";

export const revalidate = 20;

// ========= ENV =========
const BASE_RPC_URL = process.env.BASE_RPC_URL || "";
const SLIPSTREAM_NFPM = (process.env.SLIPSTREAM_NFPM || "0x827922686190790b37229fd06084350E74485b72").toLowerCase();
// Optional accelerators:
const BASESCAN_API_KEY = process.env.BASESCAN_API_KEY || "";    // speeds up discovery (recommended)
const SLIPSTREAM_FACTORY = (process.env.SLIPSTREAM_FACTORY || "").toLowerCase(); // for live tick (IN/OUT)

// ========= Low-level RPC =========
async function rpc(method: string, params: any[]) {
  if (!BASE_RPC_URL) throw new Error("BASE_RPC_URL missing");
  const res = await fetch(BASE_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result;
}

const pad32 = (hexNo0x: string) => hexNo0x.padStart(64, "0");
const toTopicAddress = (addr: string) => "0x" + "0".repeat(24) + addr.toLowerCase().replace(/^0x/, "");
const tokenIdToTopic = (id: string | number | bigint) => "0x" + BigInt(id).toString(16).padStart(64, "0");

// Selectors
const SEL_OWNER_OF = "0x6352211e";  // ownerOf(uint256)
const SEL_POSITIONS = "0x514ea4bf"; // positions(uint256)
const SEL_DECIMALS = "0x313ce567";  // decimals()
const SEL_SYMBOL   = "0x95d89b41";  // symbol()
const SEL_FACTORY  = "0xc45a0155";  // factory() on NFPM
const SEL_GETPOOL  = "0x1698ee82";  // getPool(address,address,uint24)
const SEL_SLOT0    = "0x3850c7bd";  // slot0()
const ERC721_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Utils
function hexToAddress(hex: string) {
  if (!hex || hex === "0x") return null;
  return ("0x" + hex.slice(-40)).toLowerCase() as `0x${string}`;
}
function wordAt(hex: string, idx: number) {
  return "0x" + hex.slice(2 + idx * 64, 2 + (idx + 1) * 64);
}
function parseInt24Signed(wordHex: string) {
  const x = BigInt(wordHex);
  const mask = (1n << 24n) - 1n;
  let v = x & mask;
  if (v >> 23n) v = v - (1n << 24n);
  return Number(v);
}
function parseUint(wordHex: string) {
  return BigInt(wordHex);
}

// Simple calls
async function call(to: string, data: string) {
  const out: string = await rpc("eth_call", [{ to, data }, "latest"]);
  return out;
}
async function ownerOf(nfpm: string, tokenId: string) {
  const out = await call(nfpm, SEL_OWNER_OF + tokenIdToTopic(tokenId).slice(2));
  return hexToAddress(out);
}
async function positions(nfpm: string, tokenId: string) {
  const out = await call(nfpm, SEL_POSITIONS + tokenIdToTopic(tokenId).slice(2));
  if (!out || out.length < 2 + 64 * 12) throw new Error("positions: bad return");
  return {
    token0: hexToAddress(wordAt(out, 2))!,
    token1: hexToAddress(wordAt(out, 3))!,
    fee: Number(BigInt(wordAt(out, 4))),
    tickLower: parseInt24Signed(wordAt(out, 5)),
    tickUpper: parseInt24Signed(wordAt(out, 6)),
    liquidity: wordAt(out, 7),
    tokensOwed0: wordAt(out, 10),
    tokensOwed1: wordAt(out, 11),
  };
}
async function decimals(token: string): Promise<number | null> {
  try {
    const out = await call(token, SEL_DECIMALS);
    return Number(BigInt(out));
  } catch { return null; }
}
async function symbol(token: string): Promise<string | null> {
  try {
    const out = await call(token, SEL_SYMBOL);
    // bytes32 vs dynamic string handling
    if (out.length === 2 + 64) {
      const bytes = Buffer.from(out.slice(2), "hex");
      return bytes.toString("utf8").replace(/\u0000+$/, "") || null;
    }
    const len = Number(BigInt(wordAt(out, 1)));
    const raw = out.slice(2 + 64 * 2, 2 + 64 * 2 + len * 2);
    return Buffer.from(raw, "hex").toString("utf8");
  } catch { return null; }
}

// Factory / pool tick
async function nfpmFactory(): Promise<string | null> {
  if (SLIPSTREAM_FACTORY) return SLIPSTREAM_FACTORY;
  try {
    const out = await call(SLIPSTREAM_NFPM, SEL_FACTORY);
    return hexToAddress(out);
  } catch { return null; }
}
function encGetPool(token0: string, token1: string, fee: number) {
  const t0 = token0.toLowerCase().replace(/^0x/, "");
  const t1 = token1.toLowerCase().replace(/^0x/, "");
  const feeHex = fee.toString(16).padStart(64, "0");
  return SEL_GETPOOL + pad32(t0) + pad32(t1) + feeHex;
}
async function currentTickFor(token0: string, token1: string, fee: number): Promise<number | null> {
  const factory = await nfpmFactory();
  if (!factory) return null;
  const poolOut = await call(factory, encGetPool(token0, token1, fee));
  const pool = hexToAddress(poolOut);
  if (!pool) return null;
  const slot0 = await call(pool, SEL_SLOT0);
  return parseInt24Signed(wordAt(slot0, 1));
}

// ===== TokenId discovery =====

// BaseScan (fast path, optional)
async function tokenIdsFromBasescan(wallet: string): Promise<Set<string>> {
  const set = new Set<string>();
  if (!BASESCAN_API_KEY) return set;
  const url = new URL("https://api.basescan.org/api");
  url.searchParams.set("module", "account");
  url.searchParams.set("action", "tokennfttx");
  url.searchParams.set("address", wallet);
  url.searchParams.set("contractaddress", SLIPSTREAM_NFPM);
  url.searchParams.set("page", "1");
  url.searchParams.set("offset", "10000");
  url.searchParams.set("sort", "asc");
  url.searchParams.set("apikey", BASESCAN_API_KEY);
  const res = await fetch(url.toString());
  const j = await res.json();
  if (j?.status === "1" && Array.isArray(j.result)) {
    for (const r of j.result) {
      const tid = String(r.tokenID || r.tokenId || "");
      if (tid) set.add(tid);
    }
  }
  return set;
}

// Chunked RPC logs (no API key needed)
async function tokenIdsFromLogsChunked(wallet: string): Promise<Set<string>> {
  const set = new Set<string>();

  // provider-friendly windowing
  const headHex: string = await rpc("eth_blockNumber", []);
  const head = Number(BigInt(headHex));
  const WINDOW = 100_000;            // ~manageable per call
  const MAX_LOOKBACK = 6_000_000;    // adjust as needed (~60 calls)
  let end = head;
  let scanned = 0;

  while (end > 0 && scanned < MAX_LOOKBACK) {
    const start = Math.max(0, end - WINDOW);
    const fromBlock = "0x" + start.toString(16);
    const toBlock = "0x" + end.toString(16);

    // to = wallet
    const fTo = { address: SLIPSTREAM_NFPM, topics: [ERC721_TRANSFER_TOPIC, null, toTopicAddress(wallet)], fromBlock, toBlock };
    // from = wallet
    const fFrom = { address: SLIPSTREAM_NFPM, topics: [ERC721_TRANSFER_TOPIC, toTopicAddress(wallet)], fromBlock, toBlock };

    try {
      const [logsTo, logsFrom] = await Promise.allSettled([
        rpc("eth_getLogs", [fTo as any]),
        rpc("eth_getLogs", [fFrom as any]),
      ]);

      const pushLogs = (res: any) => {
        if (res.status === "fulfilled" && Array.isArray(res.value)) {
          for (const l of res.value as any[]) {
            const tid = l.topics?.[3];
            if (tid) set.add(BigInt(tid).toString());
          }
        }
      };
      pushLogs(logsTo);
      pushLogs(logsFrom);
    } catch { /* ignore window errors */ }

    scanned += WINDOW;
    end = start;
    // small optimization: stop early if we already found a bunch
    if (set.size >= 200) break;
  }

  return set;
}

// ===== API =====
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const addrs = url.searchParams.getAll("addresses[]").map(a => a.toLowerCase()).filter(Boolean);
  const explicitIds = url.searchParams.getAll("tokenIds[]").map(s => s.trim()).filter(Boolean); // manual override if you know ids

  if (!addrs.length && !explicitIds.length) {
    return NextResponse.json({ items: [], notes: ["Pass addresses[]=0x... or tokenIds[]=123"] });
  }

  const items: any[] = [];
  const notes: string[] = [];

  // 1) Collect tokenIds
  const tokenIds = new Set<string>(explicitIds);
  if (addrs.length) {
    for (const w of addrs) {
      let ids = await tokenIdsFromBasescan(w);
      if (ids.size === 0) {
        notes.push(`BaseScan empty for ${w.slice(0,6)}… — scanning RPC logs in chunks`);
        ids = await tokenIdsFromLogsChunked(w);
      }
      if (ids.size === 0) {
        notes.push(`No NFPM activity found for ${w.slice(0,6)}… via either path`);
      } else {
        ids.forEach(id => tokenIds.add(id));
      }
    }
  }

  if (tokenIds.size === 0) {
    if (!BASESCAN_API_KEY) notes.push("Tip: add BASESCAN_API_KEY for faster discovery.");
    notes.push("If you know a tokenId, call: /api/positions-rpc?tokenIds[]=<id>");
    return NextResponse.json({ items, notes });
  }

  // 2) For each tokenId, read everything on-chain
  for (const tokenId of tokenIds) {
    try {
      const p = await positions(SLIPSTREAM_NFPM, tokenId);
      const owner = await ownerOf(SLIPSTREAM_NFPM, tokenId);

      // token meta
      const [dec0, sym0, dec1, sym1] = await Promise.all([
        decimals(p.token0), symbol(p.token0),
        decimals(p.token1), symbol(p.token1),
      ]);

      // staked if current owner isn't one of your addresses (if addresses provided)
      const ownerIsYou = addrs.length ? addrs.some(a => a === owner) : false;
      const staked = addrs.length ? !ownerIsYou : (owner !== null); // if no address filter, just show owner

      // optional: compute live tick & IN/OUT
      let currentTick: number | null = null;
      try { currentTick = await currentTickFor(p.token0, p.token1, p.fee); } catch {}
      const inRange = (currentTick !== null)
        ? (currentTick >= p.tickLower && currentTick <= p.tickUpper)
        : null;

      items.push({
        kind: "SLIPSTREAM",
        owner,
        tokenId,
        poolId: null,
        token0: { id: p.token0, symbol: sym0 || "T0", decimals: String(dec0 ?? 18) },
        token1: { id: p.token1, symbol: sym1 || "T1", decimals: String(dec1 ?? 18) },
        deposited: null,
        current: null,
        fees: { token0: String(parseUint(p.tokensOwed0)), token1: String(parseUint(p.tokensOwed1)) },
        emissions: null,
        range: { tickLower: p.tickLower, tickUpper: p.tickUpper, currentTick, status: currentTick === null ? "-" : (inRange ? "IN" : "OUT") },
        staked,
        __source: "rpc",
      });
    } catch (e: any) {
      notes.push(`tokenId ${tokenId}: ${e.message || "read failed"}`);
    }
  }

  if (items.length) notes.push(`RPC mode: positions loaded ✅ (${items.length} rows).`);
  if (!SLIPSTREAM_FACTORY) notes.push("Set SLIPSTREAM_FACTORY to compute IN/OUT reliably (pool.slot0).");

  return NextResponse.json({ items, notes });
}
