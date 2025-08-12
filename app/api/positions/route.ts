// app/api/positions-rpc/route.ts
import { NextRequest, NextResponse } from "next/server";

export const revalidate = 20;

// ====== ENV ======
const BASE_RPC_URL = process.env.BASE_RPC_URL || "";
const SLIPSTREAM_NFPM = (process.env.SLIPSTREAM_NFPM || "0x827922686190790b37229fd06084350E74485b72").toLowerCase();
const BASESCAN_API_KEY = process.env.BASESCAN_API_KEY || ""; // optional but recommended
// Optional: set this to compute current tick and IN/OUT
const SLIPSTREAM_FACTORY = (process.env.SLIPSTREAM_FACTORY || "").toLowerCase();

// ====== low-level RPC ======
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
const SEL_OWNER_OF = "0x6352211e";                 // ownerOf(uint256)
const SEL_POSITIONS = "0x514ea4bf";                 // positions(uint256)
const SEL_DECIMALS = "0x313ce567";                  // decimals()
const SEL_SYMBOL   = "0x95d89b41";                  // symbol()
const SEL_FACTORY  = "0xc45a0155";                  // factory() on NFPM (Uniswap v3-style)
const SEL_GETPOOL  = "0x1698ee82";                  // getPool(address,address,uint24) on factory
const SEL_SLOT0    = "0x3850c7bd";                  // slot0() on pool
const ERC721_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Helpers
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

// Simple call helpers
async function call(to: string, data: string) {
  const out: string = await rpc("eth_call", [{ to, data }, "latest"]);
  return out;
}
async function ownerOf(nfpm: string, tokenId: string) {
  const data = SEL_OWNER_OF + tokenIdToTopic(tokenId).slice(2);
  const out = await call(nfpm, data);
  return hexToAddress(out);
}
async function positions(nfpm: string, tokenId: string) {
  const out = await call(nfpm, SEL_POSITIONS + tokenIdToTopic(tokenId).slice(2));
  // positions returns: nonce (0), operator (1), token0 (2), token1 (3), fee (4), tickLower (5), tickUpper (6),
  // liquidity (7), feeGrowthInside0LastX128 (8), feeGrowthInside1LastX128 (9), tokensOwed0 (10), tokensOwed1 (11)
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
    // Could be dynamic string or bytes32; handle bytes32 case
    if (out.length === 2 + 64) {
      const bytes = Buffer.from(out.slice(2), "hex");
      return bytes.toString("utf8").replace(/\u0000+$/, "") || null;
    }
    // dynamic ABI encoded string: skip head (offset), read length & data
    const len = Number(BigInt(wordAt(out, 1)));
    const raw = out.slice(2 + 64 * 2, 2 + 64 * 2 + len * 2);
    const buf = Buffer.from(raw, "hex");
    return buf.toString("utf8");
  } catch { return null; }
}

// Optional: resolve pool & current tick
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
  const out = await call(factory, encGetPool(token0, token1, fee));
  const pool = hexToAddress(out);
  if (!pool) return null;
  const slot0 = await call(pool, SEL_SLOT0);
  // slot0 returns many words; tick is at index 1 (per UniswapV3)
  return parseInt24Signed(wordAt(slot0, 1));
}

// ====== TokenID discovery ======

// Preferred: BaseScan token-nft tx history for NFPM + wallet
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

// Fallback: RPC logs (can be slower on some providers)
async function tokenIdsFromLogs(wallet: string): Promise<Set<string>> {
  const set = new Set<string>();
  const filters = [
    // to = wallet
    { address: SLIPSTREAM_NFPM, topics: [ERC721_TRANSFER_TOPIC, null, toTopicAddress(wallet)], fromBlock: "0x1", toBlock: "latest" },
    // from = wallet
    { address: SLIPSTREAM_NFPM, topics: [ERC721_TRANSFER_TOPIC, toTopicAddress(wallet)], fromBlock: "0x1", toBlock: "latest" },
  ];
  for (const f of filters) {
    try {
      const logs = await rpc("eth_getLogs", [f as any]);
      for (const l of logs as any[]) {
        const tid = l.topics?.[3];
        if (tid) set.add(BigInt(tid).toString());
      }
    } catch {
      // ignore; some RPCs limit log range
    }
  }
  return set;
}

// ====== API ======
export async function GET(req: NextRequest) {
  const addrs = req.nextUrl.searchParams.getAll("addresses[]").map(a => a.toLowerCase()).filter(Boolean);
  if (!addrs.length) return NextResponse.json({ items: [], notes: ["Pass addresses[]=0x..."] });

  const items: any[] = [];
  const notes: string[] = [];

  // discover tokenIds for each wallet
  const tokenIds = new Set<string>();
  for (const w of addrs) {
    let ids = await tokenIdsFromBasescan(w);
    if (ids.size === 0) {
      notes.push(`BaseScan empty for ${w.slice(0,6)}… — trying RPC logs`);
      ids = await tokenIdsFromLogs(w);
    }
    if (ids.size === 0) {
      notes.push(`No NFPM activity found for ${w.slice(0,6)}…`);
      continue;
    }
    ids.forEach(id => tokenIds.add(id));
  }

  // If nothing found, return early
  if (tokenIds.size === 0) {
    if (!BASESCAN_API_KEY) notes.push("Tip: add BASESCAN_API_KEY to improve discovery speed/coverage.");
    return NextResponse.json({ items, notes });
  }

  // For each tokenId, read on-chain data
  for (const tokenId of tokenIds) {
    try {
      const p = await positions(SLIPSTREAM_NFPM, tokenId);
      const owner = await ownerOf(SLIPSTREAM_NFPM, tokenId);

      // token metadata
      const [dec0, sym0, dec1, sym1] = await Promise.all([
        decimals(p.token0), symbol(p.token0),
        decimals(p.token1), symbol(p.token1),
      ]);

      // mark as "yours" if the depositor wallet is in the query OR
      // if the current owner is one of your wallets
      const depositorIsYou = true; // we include all tokenIds tied to you via history
      const ownerIsYou = addrs.some(a => a === owner);

      // staked if you don't currently own the NFT
      const staked = !ownerIsYou;

      // optional: compute current tick (and IN/OUT)
      let currentTick: number | null = null;
      try { currentTick = await currentTickFor(p.token0, p.token1, p.fee); } catch {}
      const inRange = (currentTick !== null)
        ? (currentTick >= p.tickLower && currentTick <= p.tickUpper)
        : null;

      items.push({
        kind: "SLIPSTREAM",
        owner,                 // current on-chain owner (gauge if staked)
        tokenId,
        poolId: null,          // resolved only if factory provided
        token0: { id: p.token0, symbol: sym0 || "T0", decimals: String(dec0 ?? 18) },
        token1: { id: p.token1, symbol: sym1 || "T1", decimals: String(dec1 ?? 18) },
        deposited: null,       // on-chain doesn't expose historical deposit sums cheaply
        current: null,
        fees: { token0: String(parseUint(p.tokensOwed0)), token1: String(parseUint(p.tokensOwed1)) },
        emissions: null,
        range: {
          tickLower: p.tickLower,
          tickUpper: p.tickUpper,
          currentTick,
          status: currentTick === null ? "-" : (inRange ? "IN" : "OUT"),
        },
        staked,
        __source: "rpc",
      });
    } catch (e: any) {
      notes.push(`tokenId ${tokenId}: ${e.message || "read failed"}`);
    }
  }

  if (!SLIPSTREAM_FACTORY) {
    notes.push("IN/OUT requires SLIPSTREAM_FACTORY to resolve pool.slot0(); without it, status may be '-' for some tokens.");
  }

  if (items.length) notes.push(`RPC mode: positions loaded ✅ (${items.length} rows).`);
  if (!BASESCAN_API_KEY) notes.push("Tip: add BASESCAN_API_KEY for faster, more complete tokenId discovery.");
  return NextResponse.json({ items, notes });
}
