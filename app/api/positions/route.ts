import { NextRequest, NextResponse } from "next/server";
import { GraphQLClient, gql } from "graphql-request";

export const revalidate = 30;

/** ============ ENV ============ */
const SLIP_URL = process.env.AERO_SLIPSTREAM_SUBGRAPH || "";
const SUBGRAPH_KEY = process.env.SUBGRAPH_API_KEY || "";
const STAKERS_FROM_ENV = (process.env.SLIPSTREAM_STAKERS || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

/** ============ GraphQL client ============ */
function makeClient(url: string | undefined) {
  if (!url) return null;
  const headers = SUBGRAPH_KEY
    ? { "x-api-key": SUBGRAPH_KEY, "api-key": SUBGRAPH_KEY, Authorization: `Bearer ${SUBGRAPH_KEY}` }
    : undefined;
  try { return new GraphQLClient(url!, headers ? { headers } : undefined); } catch { return null; }
}
const slipClient = makeClient(SLIP_URL);

/** ============ Helpers ============ */
type TryResult<T> = { ok: true; data: T } | { ok: false; err: string };

async function tryQuery<T>(client: GraphQLClient | null, query: string, variables?: any): Promise<TryResult<T>> {
  if (!client) return { ok: false, err: "no client" };
  try {
    const r = await client.request<T>(query, variables);
    return { ok: true, data: r };
  } catch (e: any) {
    const msg = e?.response?.errors?.map((x: any) => x.message).join("; ") || e?.message || "unknown";
    return { ok: false, err: msg };
  }
}

/** ============ Schema candidates ============ */
/* 1) Discover staker/gauge addresses */
const GAUGE_CANDIDATES = [
  gql`{ clGauges { id } }`,
  gql`{ gauges { id } }`,
  gql`{ positionStakers { id } }`,
  gql`{ nonfungiblePositionStakers { id } }`,
];

/* 2) Positions by owner (with tick field fallbacks) */
const POSITIONS_BY_OWNER_V1 = gql`query($owners:[String!]!){
  positions(where:{ owner_in:$owners }) {
    id owner
    liquidity
    tickLower tickUpper
    collectedFeesToken0 collectedFeesToken1
    depositedToken0 depositedToken1
    withdrawnToken0 withdrawnToken1
    pool { id feeTier token0{ id symbol decimals } token1{ id symbol decimals } tick }
  }
}`;
const POSITIONS_BY_OWNER_V2 = gql`query($owners:[String!]!){
  positions(where:{ owner_in:$owners }) {
    id owner
    liquidity
    lowerTick: tickLower
    upperTick: tickUpper
    collectedFeesToken0 collectedFeesToken1
    pool { id feeTier token0{ id symbol decimals } token1{ id symbol decimals } currentTick: tick }
  }
}`;

/* 3) Stake mapping (tokenId -> user/account/owner) */
const STAKED_BY_USER_CANDIDATES = [
  gql`query($owners:[String!]!){ stakedPositions(where:{ user_in:$owners }) { tokenId user{ id } } }`,
  gql`query($owners:[String!]!){ positionStakings(where:{ user_in:$owners }) { tokenId user{ id } } }`,
  gql`query($owners:[String!]!){ stakes(where:{ owner_in:$owners }) { tokenId owner{ id } } }`,
  gql`query($owners:[String!]!){ stakedNonFungiblePositions(where:{ account_in:$owners }) { tokenId account{ id } } }`,
];

/* 4) Transfers (latest to=staker → from is depositor) */
const TRANSFERS_TO_STAKER_CANDIDATES = [
  // Most common names
  gql`query($tokenIds:[String!]!,$tos:[String!]!){
    positionTransfers(
      where:{ tokenId_in:$tokenIds, to_in:$tos }
      orderBy:blockNumber, orderDirection:desc, first:100
    ){ tokenId from{ id } to{ id } blockNumber }
  }`,
  gql`query($tokenIds:[String!]!,$tos:[String!]!){
    nonfungiblePositionTransfers(
      where:{ tokenId_in:$tokenIds, to_in:$tos }
      orderBy:blockNumber, orderDirection:desc, first:100
    ){ tokenId from{ id } to{ id } blockNumber }
  }`,
  gql`query($tokenIds:[String!]!,$tos:[String!]!){
    transfers(
      where:{ tokenId_in:$tokenIds, to_in:$tos }
      orderBy:blockNumber, orderDirection:desc, first:100
    ){ tokenId from{ id } to{ id } blockNumber }
  }`,
  gql`query($tokenIds:[String!]!,$tos:[String!]!){
    transferEvents(
      where:{ tokenId_in:$tokenIds, to_in:$tos }
      orderBy:blockNumber, orderDirection:desc, first:100
    ){ tokenId from{ id } to{ id } blockNumber }
  }`,
];

/* 5) Positions by id list (to rehydrate staked tokenIds) */
const POSITIONS_BY_IDS = gql`query($ids:[String!]!){
  positions(where:{ id_in:$ids }) {
    id owner
    liquidity
    tickLower tickUpper
    lowerTick: tickLower
    upperTick: tickUpper
    collectedFeesToken0 collectedFeesToken1
    depositedToken0 depositedToken1
    withdrawnToken0 withdrawnToken1
    pool { id feeTier token0{ id symbol decimals } token1{ id symbol decimals } tick currentTick: tick }
  }
}`;

/** ============ Discovery functions ============ */
async function discoverStakers(client: GraphQLClient | null): Promise<Set<string>> {
  const set = new Set<string>();
  if (!client) return set;
  for (const q of GAUGE_CANDIDATES) {
    const r = await tryQuery<any>(client, q);
    if (r.ok) {
      const rows =
        (r.data as any).clGauges ??
        (r.data as any).gauges ??
        (r.data as any).positionStakers ??
        (r.data as any).nonfungiblePositionStakers ??
        [];
      for (const g of rows) {
        const id = String(g.id || "").toLowerCase();
        if (id) set.add(id);
      }
      break; // first schema that works is enough
    }
  }
  // merge manual
  for (const s of STAKERS_FROM_ENV) set.add(s);
  return set;
}

async function getStakeMappedTokenIds(client: GraphQLClient, owners: string[]): Promise<Map<string,string>> {
  const map = new Map<string,string>(); // tokenId -> depositor
  for (const q of STAKED_BY_USER_CANDIDATES) {
    const r = await tryQuery<any>(client, q, { owners });
    if (!r.ok) continue;
    const d = r.data as any;
    const rows = d.stakedPositions ?? d.positionStakings ?? d.stakes ?? d.stakedNonFungiblePositions ?? [];
    for (const row of rows) {
      const tid = String(row.tokenId ?? row.id ?? "");
      const who = row.user?.id ?? row.owner?.id ?? row.account?.id ?? row.user ?? row.owner ?? row.account;
      if (tid && who) map.set(tid, String(who).toLowerCase());
    }
    if (map.size) break; // stop at first working schema
  }
  return map;
}

async function mapDepositorsFromTransfers(client: GraphQLClient, tokenIds: string[], stakers: string[]): Promise<Map<string,string>> {
  const map = new Map<string,string>(); // tokenId -> depositor
  if (!tokenIds.length || !stakers.length) return map;
  for (const q of TRANSFERS_TO_STAKER_CANDIDATES) {
    const r = await tryQuery<any>(client, q, { tokenIds, tos: stakers });
    if (!r.ok) continue;
    const rows = (r.data as any).positionTransfers ??
                 (r.data as any).nonfungiblePositionTransfers ??
                 (r.data as any).transfers ??
                 (r.data as any).transferEvents ?? [];
    // They are already ordered desc; keep first per tokenId
    for (const tr of rows) {
      const tid = String(tr.tokenId ?? "");
      const from = tr.from?.id ?? tr.from;
      if (tid && from && !map.has(tid)) {
        map.set(tid, String(from).toLowerCase());
      }
    }
    if (map.size) break; // stop at first schema that works
  }
  return map;
}

/** ============ Util ============ */
function normalizeTicks(p: any) {
  const tl = p.tickLower ?? p.lowerTick ?? null;
  const tu = p.tickUpper ?? p.upperTick ?? null;
  const ct = p.pool?.tick ?? p.pool?.currentTick ?? null;
  let inRange: boolean | null = null;
  if (tl !== null && tu !== null && ct !== null) {
    const tln = Number(tl), tun = Number(tu), ctn = Number(ct);
    inRange = ctn >= tln && ctn <= tun;
    return { tickLower: tln, tickUpper: tun, currentTick: ctn, status: inRange ? "IN" : "OUT" as const };
  }
  return { tickLower: tl, tickUpper: tu, currentTick: ct, status: "-" as const };
}

/** ============ API Handler ============ */
export async function GET(req: NextRequest) {
  const addrs = req.nextUrl.searchParams.getAll("addresses[]").map(a => a.toLowerCase()).filter(Boolean);
  if (!addrs.length) {
    return NextResponse.json({ items: [], notes: ["Pass addresses[]=0x... in the query string."] });
  }

  const items: any[] = [];
  const notes: string[] = [];

  if (!slipClient) {
    notes.push("AERO_SLIPSTREAM_SUBGRAPH missing.");
    return NextResponse.json({ items, notes });
  }

  /** 1) Wallet-owned positions */
  let walletPositions: any[] = [];
  {
    let r = await tryQuery<any>(slipClient, POSITIONS_BY_OWNER_V1, { owners: addrs });
    if (!r.ok) r = await tryQuery<any>(slipClient, POSITIONS_BY_OWNER_V2, { owners: addrs });
    if (r.ok) walletPositions = (r.data as any).positions ?? [];
    else notes.push(`Wallet positions query failed: ${r.err}`);
  }

  /** 2) Discover stakers/gauges (subgraph only) */
  const stakers = await discoverStakers(slipClient);
  if (STAKERS_FROM_ENV.length) notes.push(`Merged ${STAKERS_FROM_ENV.length} staker(s) from env.`);
  if (!stakers.size) notes.push("No stakers/gauges found in subgraph (set SLIPSTREAM_STAKERS if you know them).");

  /** 3) Gauge-owned positions */
  let gaugePositions: any[] = [];
  if (stakers.size) {
    const owners = Array.from(stakers);
    let r = await tryQuery<any>(slipClient, POSITIONS_BY_OWNER_V1, { owners });
    if (!r.ok) r = await tryQuery<any>(slipClient, POSITIONS_BY_OWNER_V2, { owners });
    if (r.ok) gaugePositions = (r.data as any).positions ?? [];
    else notes.push(`Gauge-owned positions query failed: ${r.err}`);
  }

  /** 4) Map staked tokenIds -> depositor */
  const tokenIdsAtStaker = gaugePositions.map(p => String(p.id));
  const depositorMap = new Map<string,string>();

  // 4a) Prefer stake-mapping entities (exact mapping)
  if (addrs.length) {
    const m1 = await getStakeMappedTokenIds(slipClient, addrs);
    for (const [k,v] of m1) depositorMap.set(k, v);
    if (m1.size) notes.push(`Stake mapping matched ${m1.size} tokenId(s).`);
  }

  // 4b) Fill gaps via latest transfer (to staker; use 'from' as depositor)
  const missingForTransfer = tokenIdsAtStaker.filter(tid => !depositorMap.has(tid));
  if (missingForTransfer.length && stakers.size) {
    const m2 = await mapDepositorsFromTransfers(slipClient, missingForTransfer, Array.from(stakers));
    for (const [k,v] of m2) if (!depositorMap.has(k)) depositorMap.set(k, v);
    if (m2.size) notes.push(`Transfer mapping matched ${m2.size} tokenId(s).`);
  }

  /** 5) Keep only your staked NFTs (depositor in query list) and rehydrate details if needed */
  const yourStakedIds = tokenIdsAtStaker.filter(tid => addrs.includes(depositorMap.get(tid) || ""));
  let yourStakedPositions: any[] = [];
  if (yourStakedIds.length) {
    // We may already have them in gaugePositions; otherwise requery by ids to ensure full fields
    const have = new Set(gaugePositions.map(p => String(p.id)));
    const needIds = yourStakedIds.filter(tid => !have.has(tid));
    const selected = gaugePositions.filter(p => yourStakedIds.includes(String(p.id)));
    if (needIds.length) {
      const r = await tryQuery<any>(slipClient, POSITIONS_BY_IDS, { ids: needIds });
      if (r.ok) {
        yourStakedPositions = [...selected, ...((r.data as any).positions ?? [])];
      } else {
        yourStakedPositions = selected;
        notes.push(`Positions by ids fallback failed: ${r.err}`);
      }
    } else {
      yourStakedPositions = selected;
    }
  }

  /** 6) Normalize + emit */
  // a) wallet-owned (unstaked)
  for (const p of walletPositions) {
    const owner = p.owner?.id ?? p.owner;
    const ticks = normalizeTicks(p);
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
      range: ticks,
      staked: false,
    });
  }

  // b) your staked (gauge-owned but mapped to you). Show your address as 'owner'
  for (const p of yourStakedPositions) {
    const tid = String(p.id);
    const depositor = depositorMap.get(tid);
    // Skip if depositor not in your query (paranoia)
    if (!depositor || !addrs.includes(depositor)) continue;
    const ticks = normalizeTicks(p);
    items.push({
      kind: "SLIPSTREAM",
      owner: depositor,               // show the actual depositor wallet
      tokenId: p.id,
      poolId: p.pool?.id,
      token0: p.pool?.token0, token1: p.pool?.token1,
      deposited: { token0: p.depositedToken0 ?? "0", token1: p.depositedToken1 ?? "0" },
      current: null,
      fees: { token0: p.collectedFeesToken0 ?? "0", token1: p.collectedFeesToken1 ?? "0" },
      emissions: null,
      range: ticks,
      staked: true,
    });
  }

  notes.push(`Slipstream: positions loaded ✅ (${items.length} rows).`);
  if (!stakers.size) notes.push("Note: No stakers discovered — set SLIPSTREAM_STAKERS=0xGaugeA,0xGaugeB to include gauge-owned NFTs.");

  return NextResponse.json({ items, notes });
}
