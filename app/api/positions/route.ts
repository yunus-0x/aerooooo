import { NextRequest, NextResponse } from "next/server";
import { GraphQLClient, gql } from "graphql-request";

export const revalidate = 30;

/** ========= ENV ========= */
const SLIP_URL = process.env.AERO_SLIPSTREAM_SUBGRAPH || "";
const SUBGRAPH_KEY = process.env.SUBGRAPH_API_KEY || "";
const STAKERS_FROM_ENV = (process.env.SLIPSTREAM_STAKERS || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

/** ========= Client ========= */
function makeClient(url?: string) {
  if (!url) return null;
  const headers = SUBGRAPH_KEY
    ? { "x-api-key": SUBGRAPH_KEY, "api-key": SUBGRAPH_KEY, Authorization: `Bearer ${SUBGRAPH_KEY}` }
    : undefined;
  try { return new GraphQLClient(url, headers ? { headers } : undefined); } catch { return null; }
}
const client = makeClient(SLIP_URL);

/** ========= Utils ========= */
type Try<T> = { ok: true; data: T } | { ok: false; err: string };
async function q<T>(c: GraphQLClient | null, query: any, vars?: any): Promise<Try<T>> {
  if (!c) return { ok: false, err: "no client" };
  try { return { ok: true, data: await c.request<T>(query, vars) }; }
  catch (e: any) {
    const msg = e?.response?.errors?.map((x: any) => x.message).join("; ") || e?.message || "unknown";
    return { ok: false, err: msg };
  }
}

/** ========= Schemas ========= */
// 1) stakers/gauges (any one of these usually exists)
const STAKERS_CANDIDATES = [
  gql`{ clGauges { id } }`,
  gql`{ gauges { id } }`,
  gql`{ positionStakers { id } }`,
  gql`{ nonfungiblePositionStakers { id } }`,
];

// 2) positions by owner (tick field fallbacks)
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

// 3) latest transfers to a staker (we’ll use 'from' as depositor)
// we try multiple common entity names
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

// 4) positions by ids (rehydrate gauge-owned items)
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

/** ========= Helpers ========= */
async function discoverStakers(c: GraphQLClient | null): Promise<Set<string>> {
  const set = new Set<string>();
  if (STAKERS_FROM_ENV.length) STAKERS_FROM_ENV.forEach(s => set.add(s));
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
    if (set.size) break; // first working schema is enough
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

/** ========= API ========= */
export async function GET(req: NextRequest) {
  const addrs = req.nextUrl.searchParams.getAll("addresses[]").map(a => a.toLowerCase()).filter(Boolean);
  if (!addrs.length) return NextResponse.json({ items: [], notes: ["Pass addresses[]=0x..."] });

  const items: any[] = [];
  const notes: string[] = [];

  if (!client) return NextResponse.json({ items, notes: ["AERO_SLIPSTREAM_SUBGRAPH missing."] });

  // 1) Wallet-owned positions (unstaked)
  let walletPositions: any[] = [];
  {
    let r = await q<any>(client, POSITIONS_BY_OWNER_V1, { owners: addrs });
    if (!r.ok) r = await q<any>(client, POSITIONS_BY_OWNER_V2, { owners: addrs });
    if (r.ok) walletPositions = (r.data as any).positions ?? [];
    else notes.push(`Wallet positions query failed: ${r.err}`);
  }

  // 2) Discover all staker/gauge addresses (cross-pool)
  const stakers = await discoverStakers(client);
  if (STAKERS_FROM_ENV.length) notes.push(`Merged ${STAKERS_FROM_ENV.length} staker(s) from env.`);
  if (!stakers.size) notes.push("No stakers found in subgraph. (Set SLIPSTREAM_STAKERS=0xGaugeA,0xGaugeB to include gauge-owned NFTs.)");

  // 3) Latest transfers where from ∈ wallets AND to ∈ stakers (covers ALL pools)
  const depositorOf: Map<string,string> = new Map(); // tokenId -> depositor(lowercased)
  if (stakers.size) {
    const tos = Array.from(stakers);
    for (const qy of TRANSFERS_TO_STAKER) {
      const r = await q<any>(client, qy, { froms: addrs, tos });
      if (!r.ok) continue;
      const rows = (r.data as any).positionTransfers ??
                   (r.data as any).nonfungiblePositionTransfers ??
                   (r.data as any).transfers ??
                   (r.data as any).transferEvents ?? [];
      // rows are newest first; keep first depositor per tokenId
      for (const tr of rows) {
        const tid = String(tr.tokenId ?? "");
        const from = tr.from?.id ?? tr.from;
        if (tid && from && !depositorOf.has(tid)) {
          depositorOf.set(tid, String(from).toLowerCase());
        }
      }
      if (depositorOf.size) break; // first working entity is enough
    }
    if (!depositorOf.size) notes.push("No wallet→staker transfers found in subgraph (schema may differ).");
  }

  // 4) Rehydrate these staked tokenIds via positions-by-ids
  let stakedPositions: any[] = [];
  const stakedIds = Array.from(depositorOf.keys());
  if (stakedIds.length) {
    const r = await q<any>(client, POSITIONS_BY_IDS, { ids: stakedIds });
    if (r.ok) stakedPositions = (r.data as any).positions ?? [];
    else notes.push(`Positions-by-ids failed: ${r.err}`);
  }

  // 5) Emit: wallet-owned (staked:false)
  for (const p of walletPositions) {
    const owner = p.owner?.id ?? p.owner;
    items.push({
      kind: "SLIPSTREAM",
      owner,
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

  // 6) Emit: your staked (owner shown as your wallet)
  for (const p of stakedPositions) {
    const tid = String(p.id);
    const depositor = depositorOf.get(tid);
    if (!depositor || !addrs.includes(depositor)) continue; // safety
    items.push({
      kind: "SLIPSTREAM",
      owner: depositor, // show depositor (your wallet), even though actual owner is staker
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

  notes.push(`Slipstream (subgraph-only): positions loaded ✅ (${items.length} rows).`);
  return NextResponse.json({ items, notes });
}
