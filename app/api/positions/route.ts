import { NextRequest, NextResponse } from "next/server";
import { GraphQLClient, gql } from "graphql-request";

export const revalidate = 30;

/* ========= ENV ========= */
const SLIP_URL = process.env.AERO_SLIPSTREAM_SUBGRAPH || "";
const SUBGRAPH_KEY = process.env.SUBGRAPH_API_KEY || "";
const STAKERS_FROM_ENV = (process.env.SLIPSTREAM_STAKERS || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

// RPC only for mapping depositor when subgraph lacks transfers
const BASE_RPC_URL = process.env.BASE_RPC_URL || "";
const SLIPSTREAM_NFPM = (process.env.SLIPSTREAM_NFPM || "0x827922686190790b37229fd06084350E74485b72").toLowerCase();
const RPC_START_BLOCK_ENV = process.env.RPC_START_BLOCK || ""; // optional

/* ========= Graph client ========= */
function makeClient(url?: string) {
  if (!url) return null;
  const headers = SUBGRAPH_KEY
    ? { "x-api-key": SUBGRAPH_KEY, "api-key": SUBGRAPH_KEY, Authorization: `Bearer ${SUBGRAPH_KEY}` }
    : undefined;
  try { return new GraphQLClient(url, headers ? { headers } : undefined); } catch { return null; }
}
const client = makeClient(SLIP_URL);

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
const STAKERS_CANDIDATES = [
  gql`{ clGauges { id } }`,
  gql`{ gauges { id } }`,
  gql`{ positionStakers { id } }`,
  gql`{ nonfungiblePositionStakers { id } }`,
];

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

const STAKED_BY_USER_CANDIDATES = [
  gql`query($owners:[String!]!){ stakedPositions(where:{ user_in:$owners }) { tokenId user{ id } } }`,
  gql`query($owners:[String!]!){ positionStakings(where:{ user_in:$owners }) { tokenId user{ id } } }`,
  gql`query($owners:[String!]!){ stakes(where:{ owner_in:$owners }) { tokenId owner{ id } } }`,
  gql`query($owners:[String!]!){ stakedNonFungiblePositions(where:{ account_in:$owners }) { tokenId account{ id } } }`,
];

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

/* ========= RPC helpers ========= */
const ERC721_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
function toTopicAddress(addr: string) { return "0x" + "0".repeat(24) + addr.toLowerCase().replace(/^0x/,""); }
function tokenIdToTopic(id: string | number | bigint) { return "0x" + BigInt(id).toString(16).padStart(64, "0"); }
async function rpc(method: string, params: any[]) {
  if (!BASE_RPC_URL) throw new Error("BASE_RPC_URL missing");
  const res = await fetch(BASE_RPC_URL, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
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

/** windowed scan: ERC721 Transfer(from=wallet, to=staker) → tokenIds */
async function scanWalletToStaker(
  wallet: string, staker: string, startBlock: number | null, window: number, maxLookback: number
): Promise<Set<string>> {
  const found = new Set<string>();
  const headHex: string = await rpc("eth_blockNumber", []);
  const head = Number(BigInt(headHex));
  let end = head, scanned = 0;
  const minStart = startBlock ?? 0;
  while (end > minStart && scanned < maxLookback) {
    const start = Math.max(minStart, end - window);
    const filter = {
      address: SLIPSTREAM_NFPM,
      topics: [ ERC721_TRANSFER_TOPIC, toTopicAddress(wallet), toTopicAddress(staker) ],
      fromBlock: toHex(start), toBlock: toHex(end),
    };
    try {
      const logs: any[] = await rpc("eth_getLogs", [filter as any]);
      for (const l of logs) {
        const tidTopic = l.topics?.[3];
        if (tidTopic) found.add(BigInt(tidTopic).toString());
      }
    } catch { /* chunk too large? continue */ }
    scanned += window; end = start;
    if (found.size >= 500) break;
  }
  return found;
}

/** exact scan: same as above but pin the tokenId in topics[3] */
async function scanExactToken(
  wallet: string, staker: string, tokenId: string, startBlock: number | null, window: number, maxLookback: number
): Promise<boolean> {
  const headHex: string = await rpc("eth_blockNumber", []);
  const head = Number(BigInt(headHex));
  let end = head, scanned = 0;
  const minStart = startBlock ?? 0;
  const tidTopic = tokenIdToTopic(tokenId);

  while (end > minStart && scanned < maxLookback) {
    const start = Math.max(minStart, end - window);
    const filter = {
      address: SLIPSTREAM_NFPM,
      topics: [ ERC721_TRANSFER_TOPIC, toTopicAddress(wallet), toTopicAddress(staker), tidTopic ],
      fromBlock: toHex(start), toBlock: toHex(end),
    };
    try {
      const logs: any[] = await rpc("eth_getLogs", [filter as any]);
      if (Array.isArray(logs) && logs.length > 0) return true;
    } catch { /* ignore */ }
    scanned += window; end = start;
  }
  return false;
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
      const id = String(g.id || "").toLowerCase();
      if (id) set.add(id);
    }
    if (set.size) break;
  }
  return set;
}

/* ========= Route ========= */
export async function GET(req: NextRequest) {
  const qp = req.nextUrl.searchParams;
  const addrs = qp.getAll("addresses[]").map(a => a.toLowerCase()).filter(Boolean);
  const forcedIds = qp.getAll("tokenIds[]").map(s => s.trim()).filter(Boolean); // NEW: allow manual tokenIds
  if (!addrs.length && !forcedIds.length) {
    return NextResponse.json({ items: [], notes: ["Pass addresses[]=0x... (and optionally tokenIds[]=<id>)"] });
  }

  const items: any[] = [];
  const notes: string[] = [];

  if (!client) return NextResponse.json({ items, notes: ["AERO_SLIPSTREAM_SUBGRAPH missing."] });

  // 1) wallet-owned
  let walletPositions: any[] = [];
  {
    let r = await q<any>(client, POSITIONS_BY_OWNER_V1, { owners: addrs });
    if (!r.ok) r = await q<any>(client, POSITIONS_BY_OWNER_V2, { owners: addrs });
    if (r.ok) walletPositions = (r.data as any).positions ?? [];
    else notes.push(`Wallet positions failed: ${r.err}`);
  }

  // 2) stakers (cross-pool)
  const stakers = await discoverStakers(client);
  if (STAKERS_FROM_ENV.length) notes.push(`Merged ${STAKERS_FROM_ENV.length} staker(s) from env.`);
  if (!stakers.size) notes.push("No stakers found in subgraph (set SLIPSTREAM_STAKERS=0xGaugeA,0xGaugeB).");
  const stakerList = Array.from(stakers);
  const stakerSet = new Set(stakerList);

  // 3) gauge-owned (owner ∈ stakers)
  let gaugePositions: any[] = [];
  if (stakers.size) {
    let r = await q<any>(client, POSITIONS_BY_OWNER_V1, { owners: stakerList });
    if (!r.ok) r = await q<any>(client, POSITIONS_BY_OWNER_V2, { owners: stakerList });
    if (r.ok) gaugePositions = (r.data as any).positions ?? [];
    else notes.push(`Gauge-owned positions failed: ${r.err}`);
  }

  // 3b) force include any tokenIds[] you pass (rehydrate; keep only those currently owned by a staker)
  if (forcedIds.length) {
    const r = await q<any>(client, POSITIONS_BY_IDS, { ids: forcedIds });
    if (r.ok) {
      const extra = ((r.data as any).positions ?? []).filter((p: any) => {
        const ownerRaw = (p?.owner?.id !== undefined && p?.owner?.id !== null) ? p.owner.id : p?.owner;
        const owner = String(ownerRaw || "").toLowerCase();
        return stakerSet.has(owner); // only add if truly gauge-owned now
      });
      if (extra.length) {
        gaugePositions = [...gaugePositions, ...extra];
        notes.push(`Injected ${extra.length} position(s) from tokenIds[].`);
      } else {
        notes.push(`tokenIds[] provided, but none are currently gauge-owned.`);
      }
    } else {
      notes.push(`tokenIds[] rehydrate failed: ${r.err}`);
    }
  }

  // 4) depositor mapping
  const depositorOf = new Map<string,string>(); // tokenId -> depositor

  // 4A) stake tables
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

  // 4B) subgraph transfers
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
  }

  // 4C) RPC mapping (chunked wallet→staker scan)
  if (BASE_RPC_URL && gaugePositions.length && addrs.length && stakerList.length) {
    const startBlockFromQP = parseBlockParam(qp.get("startBlock"));
    const windowFromQP = parseBlockParam(qp.get("window"));
    const lookbackFromQP = parseBlockParam(qp.get("maxLookback"));
    const startBlockFromEnv = parseBlockParam(RPC_START_BLOCK_ENV || null);
    const startBlock = startBlockFromQP ?? startBlockFromEnv ?? null;
    const window = windowFromQP ?? 50_000;
    const maxLookback = lookbackFromQP ?? 150_000_000;

    const gaugeIds = new Set<string>(gaugePositions.map((p: any) => String(p.id)));
    let rpcHits = 0;

    // broad scan (fast): get all tokenIds you deposited into any staker
    for (const w of addrs) {
      for (const s of stakerList) {
        const tokenIds = await scanWalletToStaker(w, s, startBlock, window, maxLookback);
        for (const tid of tokenIds) {
          if (gaugeIds.has(tid) && !depositorOf.has(tid)) { depositorOf.set(tid, w.toLowerCase()); rpcHits++; }
        }
      }
    }

    // exact scan for any still-missing forcedIds (super-targeted)
    const missingForced = forcedIds.filter(id => gaugeIds.has(id) && !depositorOf.has(id));
    let exactHits = 0;
    for (const id of missingForced) {
      for (const w of addrs) {
        for (const s of stakerList) {
          const ok = await scanExactToken(w, s, id, startBlock, window, maxLookback);
          if (ok) { depositorOf.set(id, w.toLowerCase()); exactHits++; break; }
        }
        if (depositorOf.has(id)) break;
      }
    }
    if (rpcHits || exactHits) notes.push(`RPC depositor mapping matched ${rpcHits + exactHits} tokenId(s).`);
    else notes.push(`RPC depositor mapping matched 0 — try &startBlock= or bigger &maxLookback.`);
  } else if (!BASE_RPC_URL && gaugePositions.length) {
    notes.push("Set BASE_RPC_URL (and optional RPC_START_BLOCK) to enable depositor mapping when the subgraph has no transfers.");
  }
  // 4Z) As-last-resort: if caller passed tokenIds[] and either ?assume=1 (or there is exactly one wallet),
// force-map those tokenIds (that are currently gauge-owned) to the chosen wallet so they show up.
{
  const qp = req.nextUrl.searchParams;
  const assumeFlag = qp.get("assume") === "1";
  const assumeOwnerParam = (qp.get("assumeOwner") || "").toLowerCase(); // optional explicit wallet
  const chosen =
    assumeOwnerParam ||
    (assumeFlag && addrs.length >= 1 ? addrs[0] : (addrs.length === 1 ? addrs[0] : ""));

  if (chosen && forcedIds.length && gaugePositions.length) {
    const gaugeIdSet = new Set<string>(gaugePositions.map((p: any) => String(p.id)));
    let assumed = 0;
    for (const id of forcedIds) {
      if (gaugeIdSet.has(id) && !depositorOf.has(id)) {
        depositorOf.set(id, chosen);
        assumed++;
      }
    }
    if (assumed) {
      notes.push(`Assumed depositor=${chosen} for ${assumed} tokenId(s) from tokenIds[].`);
    }
  }
}
  // 5) your staked = gauge-owned filtered to depositor ∈ wallets
  const yourStakedIds = Array.from(new Set(
    gaugePositions.map((p: any) => String(p.id)).filter(tid => addrs.includes(depositorOf.get(tid) || ""))
  ));
  let yourStaked: any[] = [];
  if (yourStakedIds.length) {
    const r = await q<any>(client, POSITIONS_BY_IDS, { ids: yourStakedIds });
    yourStaked = r.ok ? ((r.data as any).positions ?? []) : [];
    if (!r.ok) notes.push(`Positions-by-ids failed: ${r.err}`);
  } else {
    notes.push("No gauge-owned token mapped to your wallets yet.");
  }

  // 6) emit
  const seen = new Set<string>();
  for (const p of walletPositions) {
    const tid = String(p.id); if (seen.has(tid)) continue; seen.add(tid);
    const owner = (p.owner?.id !== undefined && p.owner?.id !== null) ? p.owner.id : p.owner;
    items.push({
      kind: "SLIPSTREAM",
      owner, tokenId: p.id, poolId: p.pool?.id,
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
      owner: depositor || ((p.owner?.id !== undefined && p.owner?.id !== null) ? p.owner.id : p.owner),
      tokenId: p.id, poolId: p.pool?.id,
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
