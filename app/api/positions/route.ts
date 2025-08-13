// app/api/positions/route.ts
import { NextRequest, NextResponse } from "next/server";
import { GraphQLClient, gql } from "graphql-request";

export const revalidate = 30;

/* ========= ENV ========= */
const SLIP_URL = process.env.AERO_SLIPSTREAM_SUBGRAPH || "";
const SUBGRAPH_KEY = process.env.SUBGRAPH_API_KEY || "";
const STAKERS_FROM_ENV = (process.env.SLIPSTREAM_STAKERS || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// RPC is used only for depositor mapping fallback:
const BASE_RPC_URL = process.env.BASE_RPC_URL || "";
const SLIPSTREAM_NFPM = (process.env.SLIPSTREAM_NFPM || "0x827922686190790b37229fd06084350E74485b72").toLowerCase();
const RPC_START_BLOCK_ENV = process.env.RPC_START_BLOCK || "";

/* ========= GraphQL client ========= */
function makeClient(url?: string) {
  if (!url) return null;
  const headers = SUBGRAPH_KEY
    ? { "x-api-key": SUBGRAPH_KEY, "api-key": SUBGRAPH_KEY, Authorization: `Bearer ${SUBGRAPH_KEY}` }
    : undefined;
  try { return new GraphQLClient(url, headers ? { headers } : undefined); } catch { return null; }
}
const client = makeClient(SLIP_URL);

/* ========= GQL Utils ========= */
type Try<T> = { ok: true; data: T } | { ok: false; err: string };
async function q<T>(c: GraphQLClient | null, query: any, vars?: any): Promise<Try<T>> {
  if (!c) return { ok: false, err: "no client" };
  try { return { ok: true, data: await c.request<T>(query, vars) }; }
  catch (e: any) {
    const msg = e?.response?.errors?.map((x: any) => x.message).join("; ") || e?.message || "unknown";
    return { ok: false, err: msg };
  }
}

/* ========= Schemas ========= */
// Discover stakers/gauges (any variant)
const STAKERS_CANDIDATES = [
  gql`{ clGauges { id } }`,
  gql`{ gauges { id } }`,
  gql`{ positionStakers { id } }`,
  gql`{ nonfungiblePositionStakers { id } }`,
];

// Positions by owner (tick field fallbacks)
const POSITIONS_BY_OWNER_V1 = gql`query($owners:[String!]!){
  positions(where:{ owner_in:$owners }) {
    id owner liquidity
    tickLower tickUpper
    collectedFeesToken0 collectedFeesToken1
    depositedToken0 depositedToken1
    withdrawnToken0 withdrawnToken1
    pool { id feeTier token0{ id symbol decimals } token1{ id symbol decimals } tick }
  }
}`;
const POSITIONS_BY_OWNER_V2 = gql`query($owners:[String!]!){
  positions(where:{ owner_in:$owners }) {
    id owner liquidity
    lowerTick: tickLower
    upperTick: tickUpper
    collectedFeesToken0 collectedFeesToken1
    pool { id feeTier token0{ id symbol decimals } token1{ id symbol decimals } currentTick: tick }
  }
}`;

// Stake mappings (tokenId -> user/account/owner)
const STAKED_BY_USER_CANDIDATES = [
  gql`query($owners:[String!]!){ stakedPositions(where:{ user_in:$owners }) { tokenId user{ id } } }`,
  gql`query($owners:[String!]!){ positionStakings(where:{ user_in:$owners }) { tokenId user{ id } } }`,
  gql`query($owners:[String!]!){ stakes(where:{ owner_in:$owners }) { tokenId owner{ id } } }`,
  gql`query($owners:[String!]!){ stakedNonFungiblePositions(where:{ account_in:$owners }) { tokenId account{ id } } }`,
];

// Transfers to staker (derive depositor when stake-mapping not available)
const TRANSFERS_TO_STAKER = [
  gql`query($froms:[String!]!,$tos:[String!]!){
    positionTransfers(where:{ from_in:$froms, to_in:$tos }
      orderBy:blockNumber, orderDirection:desc, first:1000){
      tokenId from{ id } to{ id } blockNumber
    }
  }`,
  gql`query($froms:[String!]!,$tos:[String!]!){
    nonfungiblePositionTransfers(where:{ from_in:$froms, to_in:$tos }
      orderBy:blockNumber, orderDirection:desc, first:1000){
      tokenId from{ id } to{ id } blockNumber
    }
  }`,
  gql`query($froms:[String!]!,$tos:[String!]!){
    transfers(where:{ from_in:$froms, to_in:$tos }
      orderBy:blockNumber, orderDirection:desc, first:1000){
      tokenId from{ id } to{ id } blockNumber
    }
  }`,
  gql`query($froms:[String!]!,$tos:[String!]!){
    transferEvents(where:{ from_in:$froms, to_in:$tos }
      orderBy:blockNumber, orderDirection:desc, first:1000){
      tokenId from{ id } to{ id } blockNumber
    }
  }`,
];

// Positions by ids (rehydrate gauge-owned items)
const POSITIONS_BY_IDS = gql`query($ids:[String!]!){
  positions(where:{ id_in:$ids }) {
    id owner liquidity
    tickLower tickUpper
    lowerTick: tickLower
    upperTick: tickUpper
    collectedFeesToken0 collectedFeesToken1
    depositedToken0 depositedToken1
    withdrawnToken0 withdrawnToken1
    pool { id feeTier token0{ id symbol decimals } token1{ id symbol decimals } tick currentTick: tick }
  }
}`;

/* ========= Normalizers ========= */
function normalizeTicks(p: any) {
  const tl = (p as any).tickLower ?? (p as any).lowerTick ?? null;
  const tu = (p as any).tickUpper ?? (p as any).upperTick ?? null;
  const ct = (p as any).pool?.tick ?? (p as any).pool?.currentTick ?? null;
  if (tl !== null && tu !== null && ct !== null) {
    const tln = Number(tl), tun = Number(tu), ctn = Number(ct);
    const status = ctn >= tln && ctn <= tun ? "IN" : "OUT";
    return { tickLower: tln, tickUpper: tun, currentTick: ctn, status };
  }
  return { tickLower: tl, tickUpper: tu, currentTick: ct, status: "-" as const };
}

/* ========= RPC helpers (fallback) ========= */
const ERC721_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
function toTopicAddress(addr: string) { return "0x" + "0".repeat(24) + addr.toLowerCase().replace(/^0x/, ""); }
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
function toHex(n: number) { return "0x" + n.toString(16); }
function parseBlockParam(v: string | null): number | null {
  if (!v) return null;
  if (v.startsWith("0x")) return Number(BigInt(v));
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Scan NFPM Transfer(from=wallet, to=staker) in block windows; return tokenIds */
async function scanWalletToStaker(
  wallet: string,
  staker: string,
  startBlock: number | null,
  window: number,
  maxLookback: number
): Promise<Set<string>> {
  const found = new Set<string>();
  const headHex: string = await rpc("eth_blockNumber", []);
  const head = Number(BigInt(headHex));

  let end = head;
  let scanned = 0;
  const minStart = startBlock ?? 0;

  while (end > minStart && scanned < maxLookback) {
    const start = Math.max(minStart, end - window);
    const fromBlock = toHex(start);
    const toBlock = toHex(end);
    const filter = {
      address: SLIPSTREAM_NFPM,
      topics: [ ERC721_TRANSFER_TOPIC, toTopicAddress(wallet), toTopicAddress(staker) ],
      fromBlock, toBlock
    };
    try {
      const logs: any[] = await rpc("eth_getLogs", [filter as any]);
      for (const l of logs) {
        const tidTopic = (l as any).topics?.[3];
        if (tidTopic) found.add(BigInt(tidTopic).toString());
      }
    } catch { /* window may be too large; keep scanning */ }
    scanned += window;
    end = start;
    if (found.size >= 500) break;
  }
  return found;
}

/* ========= Discovery ========= */
async function discoverStakers(c: GraphQLClient | null): Promise<Set<string>> {
  const set = new Set<string>(STAKERS_FROM_ENV);
  if (!c) return set;
  for (const qy of STAKERS_CANDIDATES) {
    const r = await q<any>(c, qy);
    if (!r.ok) continue;
    const rows = (r.data as any).clGauges ??
                 (r.data as any).gauges ??
                 (r.data as any).positionStakers ??
                 (r.data as any).nonfungiblePositionStakers ?? [];
    for (const g of rows) {
      const id = String((g as any).id || "").toLowerCase();
      if (id) set.add(id);
    }
    if (set.size) break;
  }
  return set;
}

/* ========= Route ========= */
export async function GET(req: NextRequest) {
  const addrs = req.nextUrl.searchParams.getAll("addresses[]").map(a => a.toLowerCase()).filter(Boolean);
  if (!addrs.length) return NextResponse.json({ items: [], notes: ["Pass addresses[]=0x..."] });

  const items: any[] = [];
  const notes: string[] = [];

  if (!client) return NextResponse.json({ items, notes: ["AERO_SLIPSTREAM_SUBGRAPH missing."] });

  // 1) Wallet-owned positions
  let walletPositions: any[] = [];
  {
    let r = await q<any>(client, POSITIONS_BY_OWNER_V1, { owners: addrs });
    if (!r.ok) r = await q<any>(client, POSITIONS_BY_OWNER_V2, { owners: addrs });
    if (r.ok) walletPositions = (r.data as any).positions ?? [];
    else notes.push(`Wallet positions failed: ${r.err}`);
  }

  // 2) Discover all stakers/gauges (cross-pool)
  const stakers = await discoverStakers(client);
  if (STAKERS_FROM_ENV.length) notes.push(`Merged ${STAKERS_FROM_ENV.length} staker(s) from env.`);
  if (!stakers.size) notes.push("No stakers found in subgraph (set SLIPSTREAM_STAKERS=0xGaugeA,0xGaugeB).");

  // 3) Gauge-owned positions (owner ∈ stakers)
  let gaugePositions: any[] = [];
  if (stakers.size) {
    const owners = Array.from(stakers);
    let r = await q<any>(client, POSITIONS_BY_OWNER_V1, { owners });
    if (!r.ok) r = await q<any>(client, POSITIONS_BY_OWNER_V2, { owners });
    if (r.ok) gaugePositions = (r.data as any).positions ?? [];
    else notes.push(`Gauge-owned positions failed: ${r.err}`);
  }

  // 4) Build tokenId -> depositor map
  const depositorOf = new Map<string,string>(); // tokenId -> depositor (lowercased)

  // 4A) Stake mapping (best case)
  if (addrs.length) {
    for (const qy of STAKED_BY_USER_CANDIDATES) {
      const r = await q<any>(client, qy, { owners: addrs });
      if (!r.ok) continue;
      const d: any = r.data;
      const rows = d.stakedPositions ?? d.positionStakings ?? d.stakes ?? d.stakedNonFungiblePositions ?? [];
      for (const row of rows) {
        const tid = String((row as any).tokenId ?? (row as any).id ?? "");
        const who = (row as any).user?.id ?? (row as any).owner?.id ?? (row as any).account?.id
                 ?? (row as any).user ?? (row as any).owner ?? (row as any).account;
        if (tid && who) depositorOf.set(tid, String(who).toLowerCase());
      }
      if (depositorOf.size) { notes.push(`Stake mapping matched ${depositorOf.size} tokenId(s).`); break; }
    }
  }

  // 4B) Transfers in subgraph: latest from ∈ wallets, to ∈ stakers
  const stakerList = Array.from(stakers);
  if (stakerList.length && addrs.length) {
    for (const qy of TRANSFERS_TO_STAKER) {
      const r = await q<any>(client, qy, { froms: addrs, tos: stakerList });
      if (!r.ok) continue;
      const rows = (r.data as any).positionTransfers ??
                   (r.data as any).nonfungiblePositionTransfers ??
                   (r.data as any).transfers ??
                   (r.data as any).transferEvents ?? [];
      for (const tr of rows) {
        const tid = String((tr as any).tokenId ?? "");
        const from = (tr as any).from?.id ?? (tr as any).from;
        if (tid && from && !depositorOf.has(tid)) depositorOf.set(tid, String(from).toLowerCase());
      }
      if (rows.length) { notes.push(`Transfer mapping matched ${rows.length} row(s).`); break; }
    }
  } else {
    notes.push("Skipped transfer mapping (no stakers discovered).");
  }

  // 4C) RPC fallback (chunked wallet→staker scan)
  if (BASE_RPC_URL && gaugePositions.length) {
    // collect unique stakers from the subgraph's gauge-owned set
    const stakerSet = new Set<string>();
    for (const p of gaugePositions) {
      const ownerField = (p as any)?.owner?.id !== undefined && (p as any)?.owner?.id !== null
        ? (p as any).owner.id
        : (p as any)?.owner;
      const s = String((ownerField ?? "")).toLowerCase();
      if (s) stakerSet.add(s);
    }
    const stakersForScan = Array.from(stakerSet);

    // scan parameters (URL overrides > env > defaults)
    const qp = req.nextUrl.searchParams;
    const startBlockFromQP = parseBlockParam(qp.get("startBlock"));
    const windowFromQP = parseBlockParam(qp.get("window"));
    const lookbackFromQP = parseBlockParam(qp.get("maxLookback"));
    const startBlockFromEnv = parseBlockParam(RPC_START_BLOCK_ENV || null);

    const startBlock = startBlockFromQP ?? startBlockFromEnv ?? null;
    const window = windowFromQP ?? 50_000;
    const maxLookback = lookbackFromQP ?? 150_000_000;

    // gauge-owned tokenIds set (so we only keep those)
    const gaugeIds = new Set<string>(gaugePositions.map((p: any) => String(p.id)));

    let rpcHits = 0;
    for (const w of addrs) {
      for (const s of stakersForScan) {
        const tokenIds = await scanWalletToStaker(w, s, startBlock, window, maxLookback);
        for (const tid of tokenIds) {
          if (gaugeIds.has(tid) && !depositorOf.has(tid)) {
            depositorOf.set(tid, w.toLowerCase());
            rpcHits++;
          }
        }
      }
    }
    if (rpcHits) notes.push(`RPC depositor mapping (chunked) matched ${rpcHits} tokenId(s).`);
    else notes.push(`RPC depositor mapping (chunked) matched 0 — try &startBlock= or bigger &maxLookback.`);
  } else if (!BASE_RPC_URL && gaugePositions.length) {
    notes.push("Set BASE_RPC_URL (and optional RPC_START_BLOCK) to enable depositor mapping when the subgraph lacks transfers.");
  }

  // 5) Keep only your staked tokenIds (depositor ∈ addrs), rehydrate via positions-by-ids
  const stakedIds = Array.from(new Set(
    gaugePositions
      .map(p => String((p as any).id))
      .filter(tid => addrs.includes(depositorOf.get(tid) || ""))
  ));
  let yourStaked: any[] = [];
  if (stakedIds.length) {
    const r = await q<any>(client, POSITIONS_BY_IDS, { ids: stakedIds });
    yourStaked = r.ok ? ((r.data as any).positions ?? []) : [];
    if (!r.ok) notes.push(`Positions-by-ids failed: ${r.err}`);
  } else {
    notes.push("No gauge-owned token mapped to your wallets yet.");
  }

  // 6) Emit
  const seen = new Set<string>();
  for (const p of walletPositions) {
    const tid = String((p as any).id); if (seen.has(tid)) continue; seen.add(tid);
    const ownerField = (p as any)?.owner?.id !== undefined && (p as any)?.owner?.id !== null
      ? (p as any).owner.id
      : (p as any)?.owner;
    items.push({
      kind: "SLIPSTREAM",
      owner: ownerField,
      tokenId: (p as any).id,
      poolId: (p as any).pool?.id,
      token0: (p as any).pool?.token0, token1: (p as any).pool?.token1,
      deposited: { token0: (p as any).depositedToken0 ?? "0", token1: (p as any).depositedToken1 ?? "0" },
      current: null,
      fees: { token0: (p as any).collectedFeesToken0 ?? "0", token1: (p as any).collectedFeesToken1 ?? "0" },
      emissions: null,
      range: normalizeTicks(p),
      staked: false,
    });
  }

  for (const p of yourStaked) {
    const tid = String((p as any).id); if (seen.has(tid)) continue; seen.add(tid);
    const depositor = depositorOf.get(tid);
    items.push({
      kind: "SLIPSTREAM",
      owner: depositor || (((p as any)?.owner?.id !== undefined && (p as any)?.owner?.id !== null) ? (p as any).owner.id : (p as any)?.owner),
      tokenId: (p as any).id,
      poolId: (p as any).pool?.id,
      token0: (p as any).pool?.token0, token1: (p as any).pool?.token1,
      deposited: { token0: (p as any).depositedToken0 ?? "0", token1: (p as any).depositedToken1 ?? "0" },
      current: null,
      fees: { token0: (p as any).collectedFeesToken0 ?? "0", token1: (p as any).collectedFeesToken1 ?? "0" },
      emissions: null,
      range: normalizeTicks(p),
      staked: true,
    });
  }

  notes.push(`Slipstream: positions loaded ✅ (${items.length} rows).`);
  return NextResponse.json({ items, notes });
}
