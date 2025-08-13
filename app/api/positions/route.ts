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
// RPC is only used as a last-resort for depositor mapping:
const BASE_RPC_URL = process.env.BASE_RPC_URL || "";

/* ========= Graph client ========= */
function makeClient(url?: string) {
  if (!url) return null;
  const headers = SUBGRAPH_KEY
    ? { "x-api-key": SUBGRAPH_KEY, "api-key": SUBGRAPH_KEY, Authorization: `Bearer ${SUBGRAPH_KEY}` }
    : undefined;
  try { return new GraphQLClient(url, headers ? { headers } : undefined); } catch { return null; }
}
const client = makeClient(SLIP_URL);

/* ========= Small RPC helpers (fallback only) ========= */
const ERC721_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SLIPSTREAM_NFPM = (process.env.SLIPSTREAM_NFPM || "0x827922686190790b37229fd06084350E74485b72").toLowerCase();
function toTopicAddress(addr: string) { return "0x" + "0".repeat(24) + addr.toLowerCase().replace(/^0x/,""); }
function tokenIdToTopic(id: string | number | bigint) { return "0x" + BigInt(id).toString(16).padStart(64, "0"); }
async function rpc(method: string, params: any[]) {
  if (!BASE_RPC_URL) throw new Error("BASE_RPC_URL missing");
  const res = await fetch(BASE_RPC_URL, {
    method: "POST", headers: { "content-type":"application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result;
}
async function depositorFromLogs(tokenId: string, staker: string): Promise<string | null> {
  try {
    const logs = await rpc("eth_getLogs", [{
      address: SLIPSTREAM_NFPM,
      topics: [ ERC721_TRANSFER_TOPIC, null, toTopicAddress(staker), tokenIdToTopic(tokenId) ],
      fromBlock: "0x1", toBlock: "latest"
    }]);
    if (!Array.isArray(logs) || logs.length === 0) return null;
    logs.sort((a: any, b: any) => (BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1 : -1));
    const last = logs[logs.length - 1];
    const fromTopic = last.topics?.[1];
    return fromTopic ? ("0x" + fromTopic.slice(-40)).toLowerCase() : null;
  } catch { return null; }
}

/* ========= GQL utils ========= */
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

// Transfers to staker (to derive depositor if stake-mapping not available)
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

// Positions by ids
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

/* ========= Helpers ========= */
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
      const id = String(g.id || "").toLowerCase();
      if (id) set.add(id);
    }
    if (set.size) break;
  }
  return set;
}

function normalizeTicks(p: any) {
  const tl = p.tickLower ?? p.lowerTick ?? null;
  const tu = p.tickUpper ?? p.upperTick ?? null;
  const ct = p.pool?.tick ?? p.pool?.currentTick ?? null;
  if (tl !== null && tu !== null && ct !== null) {
    const tln = Number(tl), tun = Number(tu), ctn = Number(ct);
    const status = ctn >= tln && ctn <= tun ? "IN" : "OUT";
    return { tickLower: tln, tickUpper: tun, currentTick: ctn, status };
  }
  return { tickLower: tl, tickUpper: tu, currentTick: ct, status: "-" as const };
}

export async function GET(req: NextRequest) {
  const addrs = req.nextUrl.searchParams.getAll("addresses[]").map(a => a.toLowerCase()).filter(Boolean);
  if (!addrs.length) return NextResponse.json({ items: [], notes: ["Pass addresses[]=0x..."] });

  const items: any[] = [];
  const notes: string[] = [];

  if (!client) return NextResponse.json({ items, notes: ["AERO_SLIPSTREAM_SUBGRAPH missing."] });

  // 1) Wallet-owned positions
  let walletPositions: any[] = [];
  { let r = await q<any>(client, POSITIONS_BY_OWNER_V1, { owners: addrs });
    if (!r.ok) r = await q<any>(client, POSITIONS_BY_OWNER_V2, { owners: addrs });
    if (r.ok) walletPositions = (r.data as any).positions ?? [];
    else notes.push(`Wallet positions failed: ${r.err}`); }

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
        const tid = String(row.tokenId ?? row.id ?? "");
        const who = row.user?.id ?? row.owner?.id ?? row.account?.id ?? row.user ?? row.owner ?? row.account;
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
        const tid = String(tr.tokenId ?? "");
        const from = tr.from?.id ?? tr.from;
        if (tid && from && !depositorOf.has(tid)) depositorOf.set(tid, String(from).toLowerCase());
      }
      if (rows.length) { notes.push(`Transfer mapping matched ${rows.length} row(s).`); break; }
    }
  } else {
    notes.push("Skipped transfer mapping (no stakers discovered).");
  }

  // 4C) RPC fallback (per-token, only if needed)
  // Use only for gauge-owned tokens we couldn't map via subgraph
if (BASE_RPC_URL && gaugePositions.length) {
  const unmapped = gaugePositions
    .map((p) => {
      const stakerRaw = ((p?.owner?.id ?? p?.owner) ?? ""); // add parens to avoid ?? with ||
      return { tid: String(p.id), staker: String(stakerRaw).toLowerCase() };
    })
    .filter((x) => x.tid && x.staker && !depositorOf.has(x.tid));
    let rpcHits = 0;
    for (const { tid, staker } of unmapped) {
      const dep = await depositorFromLogs(tid, staker);
      if (dep) { depositorOf.set(tid, dep); rpcHits++; }
    }
    if (rpcHits) notes.push(`RPC depositor mapping matched ${rpcHits} tokenId(s).`);
    if (!rpcHits && unmapped.length) notes.push(`RPC mapping found 0 of ${unmapped.length} (provider may limit logs).`);
  } else if (!BASE_RPC_URL && gaugePositions.length) {
    notes.push("Set BASE_RPC_URL to enable depositor mapping when the subgraph has no transfers.");
  }

  // 5) Keep only your staked tokenIds (depositor ∈ addrs), rehydrate via positions-by-ids
  const stakedIds = Array.from(new Set(
    gaugePositions
      .map(p => String(p.id))
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
    const tid = String(p.id); if (seen.has(tid)) continue; seen.add(tid);
    items.push({
      kind: "SLIPSTREAM",
      owner: (p.owner?.id ?? p.owner),
      tokenId: p.id,
      poolId: p.pool?.id,
      token0: p.pool?.token0, token1: p.pool?.token1,
      deposited: { token0: p.depositedToken0 ?? "0", token1: p.depositedToken1 ?? "0" },
      current: null,
      fees: { token0: p.collectedFeesToken0 ?? "0", token1: p.collectedFeesToken1 ?? "0" },
      emissions: null,
      range: normalizeTicks(p),
      staked: false,
    });
  }

  for (const p of yourStaked) {
    const tid = String(p.id); if (seen.has(tid)) continue; seen.add(tid);
    const depositor = depositorOf.get(tid);
    items.push({
      kind: "SLIPSTREAM",
      owner: depositor || (p.owner?.id ?? p.owner),  // display depositor if known
      tokenId: p.id,
      poolId: p.pool?.id,
      token0: p.pool?.token0, token1: p.pool?.token1,
      deposited: { token0: p.depositedToken0 ?? "0", token1: p.depositedToken1 ?? "0" },
      current: null,
      fees: { token0: p.collectedFeesToken0 ?? "0", token1: p.collectedFeesToken1 ?? "0" },
      emissions: null,
      range: normalizeTicks(p),
      staked: true,
    });
  }

  notes.push(`Slipstream: positions loaded ✅ (${items.length} rows).`);
  return NextResponse.json({ items, notes });
}
