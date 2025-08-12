import { NextRequest, NextResponse } from "next/server";
import { GraphQLClient, gql } from "graphql-request";

export const revalidate = 30;

// ----- ENV -----
const SLIP_URL = process.env.AERO_SLIPSTREAM_SUBGRAPH || "";
const SOLID_URL = process.env.AERO_SOLIDLY_SUBGRAPH || ""; // optional
const SUBGRAPH_KEY = process.env.SUBGRAPH_API_KEY || "";
const BASE_RPC_URL = process.env.BASE_RPC_URL || "";

// Aerodrome Voter (Base) + Slipstream NFPM (Base)
const AERO_VOTER = (process.env.AERO_VOTER || "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5").toLowerCase();
const SLIPSTREAM_NFPM = (process.env.SLIPSTREAM_NFPM || "0x827922686190790b37229fd06084350E74485b72").toLowerCase();

// ----- Graph clients -----
function makeClient(url: string | undefined) {
  if (!url) return null;
  const headers = SUBGRAPH_KEY
    ? { "x-api-key": SUBGRAPH_KEY, "api-key": SUBGRAPH_API_KEY, Authorization: `Bearer ${SUBGRAPH_KEY}` }
    : undefined;
  try { return new GraphQLClient(url!, headers ? { headers } : undefined); } catch { return null; }
}
const slipClient = makeClient(SLIP_URL);
const solidClient = makeClient(SOLID_URL);

// ----- Helpers -----
type Address = `0x${string}`;
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

// --- Minimal JSON-RPC helper ---
async function rpc(method: string, params: any[]) {
  if (!BASE_RPC_URL) throw new Error("BASE_RPC_URL missing");
  const res = await fetch(BASE_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "rpc error");
  return json.result;
}

// ERC-721 Transfer topic
const ERC721_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
function toTopicAddress(addr: string) {
  const a = addr.toLowerCase().replace(/^0x/, "");
  return "0x" + "0".repeat(24) + a;
}
function tokenIdToTopic(id: string | number | bigint) {
  const n = BigInt(id);
  let hex = n.toString(16);
  hex = hex.padStart(64, "0");
  return "0x" + hex;
}

// Voter.gauges(address pool) => address gauge
const VOTER_GAUGES_SEL = "0x1f9a1d3f"; // bytes4(keccak256("gauges(address)"))
function encGauges(pool: string) {
  const p = pool.toLowerCase().replace(/^0x/, "");
  return VOTER_GAUGES_SEL + ("0".repeat(24) + p);
}
async function gaugeForPool(pool: string): Promise<string | null> {
  try {
    const data = encGauges(pool);
    const out = await rpc("eth_call", [{ to: AERO_VOTER, data }, "latest"]);
    if (!out || out === "0x") return null;
    const addr = "0x" + out.slice(-40);
    return addr.toLowerCase() === "0x0000000000000000000000000000000000000000" ? null : addr.toLowerCase();
  } catch { return null; }
}

// find depositor: last Transfer(to=gauge or staker, tokenId=...) on NFPM
async function depositorFromLogs(tokenId: string, toAddress: string): Promise<string | null> {
  try {
    const logs = await rpc("eth_getLogs", [{
      address: SLIPSTREAM_NFPM,
      topics: [ ERC721_TRANSFER_TOPIC, null, toTopicAddress(toAddress), tokenIdToTopic(tokenId) ],
      fromBlock: "0x1",
      toBlock: "latest",
    }]);
    if (!Array.isArray(logs) || logs.length === 0) return null;
    logs.sort((a: any, b: any) => (BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1 : -1));
    const last = logs[logs.length - 1];
    const fromTopic = last.topics?.[1];
    return fromTopic ? ("0x" + fromTopic.slice(-40)).toLowerCase() : null;
  } catch { return null; }
}

// ----- Discover ALL staker/gauges from subgraph -----
const GAUGE_CANDIDATES = [
  gql`{ clGauges { id } }`,
  gql`{ gauges { id } }`,
  gql`{ positionStakers { id } }`,
  gql`{ nonfungiblePositionStakers { id } }`,
];
async function discoverAllStakers(client: GraphQLClient | null): Promise<Set<string>> {
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
      break; // first successful schema is enough
    }
  }
  return set;
}

// ----- Slipstream position query (with field fallbacks) -----
const SLIP_POSITIONS_V1 = gql`query($owners:[String!]!){
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
const SLIP_POSITIONS_V2 = gql`query($owners:[String!]!){
  positions(where:{ owner_in:$owners }) {
    id owner
    liquidity
    lowerTick: tickLower
    upperTick: tickUpper
    collectedFeesToken0 collectedFeesToken1
    pool { id feeTier token0{ id symbol decimals } token1{ id symbol decimals } currentTick: tick }
  }
}`;

// stake mappings (tokenIds by user)
const STAKED_BY_USER_CANDIDATES = [
  gql`query($owners:[String!]!){ stakedPositions(where:{ user_in:$owners }) { tokenId user{ id } } }`,
  gql`query($owners:[String!]!){ positionStakings(where:{ user_in:$owners }) { tokenId user{ id } } }`,
  gql`query($owners:[String!]!){ stakes(where:{ owner_in:$owners }) { tokenId owner{ id } } }`,
  gql`query($owners:[String!]!){ stakedNonFungiblePositions(where:{ account_in:$owners }) { tokenId account{ id } } }`,
];
async function getStakedTokenIdsForOwners(client: GraphQLClient, owners: string[]): Promise<Set<string>> {
  const set = new Set<string>();
  for (const q of STAKED_BY_USER_CANDIDATES) {
    const r = await tryQuery<any>(client, q, { owners });
    if (r.ok) {
      const d: any = r.data;
      const rows = d.stakedPositions ?? d.positionStakings ?? d.stakes ?? d.stakedNonFungiblePositions ?? [];
      for (const row of rows) {
        const tid = String(row.tokenId ?? row.id ?? "");
        if (tid) set.add(tid);
      }
      if (set.size) break;
    }
  }
  return set;
}

const SLIP_POSITIONS_BY_IDS = gql`query($ids:[String!]!){
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

// optional classic
const SOLID_USERS_LP = gql`query($owners:[String!]!){
  users(where:{ id_in:$owners }){
    id
    liquidityPositions {
      pair { id stable token0{ id symbol decimals } token1{ id symbol decimals } reserve0 reserve1 totalSupply }
      liquidityTokenBalance
      gauge { id }
    }
  }
}`;

function getTicksFromRow(p: any) {
  const tl = p.tickLower ?? p.lowerTick ?? null;
  const tu = p.tickUpper ?? p.upperTick ?? null;
  const ct = p.pool?.tick ?? p.pool?.currentTick ?? null;
  return { tickLower: tl !== null ? Number(tl) : null, tickUpper: tu !== null ? Number(tu) : null, currentTick: ct !== null ? Number(ct) : null };
}

// on-chain NFPM positions(tokenId) -> ticks
const NFPM_POSITIONS_SEL = "0x514ea4bf";
function encPositionsCall(tokenId: string) { return NFPM_POSITIONS_SEL + tokenIdToTopic(tokenId).slice(2); }
function wordAt(hex: string, i: number) { return "0x" + hex.slice(2 + i * 64, 2 + (i + 1) * 64); }
function parseInt24(wordHex: string) {
  const x = BigInt(wordHex), mask = (1n << 24n) - 1n;
  let val = x & mask;
  if (val >> 23n) val = val - (1n << 24n);
  return Number(val);
}
async function fetchTicksFromNFPM(tokenId: string): Promise<{tickLower:number|null; tickUpper:number|null}> {
  try {
    const out: string = await rpc("eth_call", [{ to: SLIPSTREAM_NFPM, data: encPositionsCall(tokenId) }, "latest"]);
    if (!out || out.length < 2 + 64 * 12) return { tickLower: null, tickUpper: null };
    return { tickLower: parseInt24(wordAt(out, 5)), tickUpper: parseInt24(wordAt(out, 6)) };
  } catch { return { tickLower: null, tickUpper: null }; }
}

export async function GET(req: NextRequest) {
  const addrs = req.nextUrl.searchParams.getAll("addresses[]").map(a => a.toLowerCase()).filter(Boolean) as Address[];
  if (!addrs.length) return NextResponse.json({ items: [], notes: ["Pass addresses[]=0x..."] });

  const items: any[] = [];
  const notes: string[] = [];

  // ---------- SLIPSTREAM ----------
  let slipPositions: any[] = [];

  if (!slipClient) {
    notes.push("AERO_SLIPSTREAM_SUBGRAPH missing; skipping CL positions.");
  } else {
    // A) Wallet-owned pass
    let r = await tryQuery<any>(slipClient, SLIP_POSITIONS_V1, { owners: addrs });
    if (!r.ok) r = await tryQuery<any>(slipClient, SLIP_POSITIONS_V2, { owners: addrs });
    if (r.ok) slipPositions = (r.data as any).positions ?? []; else notes.push(`Slipstream (wallet) failed: ${r.err}`);

    // B) Stake-mapped tokenIds for your wallets (subgraph)
    const stakedIds = await getStakedTokenIdsForOwners(slipClient, addrs);
    if (stakedIds.size) {
      const s = await tryQuery<any>(slipClient, SLIP_POSITIONS_BY_IDS, { ids: Array.from(stakedIds) });
      if (s.ok) {
        const byIds = (s.data as any).positions ?? [];
        for (const p of byIds) {
          p.owner = (p.owner?.id ?? p.owner);
          (p as any).__forceDepositor = true;
          slipPositions.push(p);
        }
        notes.push(`Slipstream: added ${byIds.length} staked position(s) via stake-mapping.`);
      }
    }

    // C) Discover all stakers/gauges, query their owned NFTs, map back to wallet via logs
    const stakers = await discoverAllStakers(slipClient);
    if (stakers.size) {
      const list = Array.from(stakers);
      let r2 = await tryQuery<any>(slipClient, SLIP_POSITIONS_V1, { owners: list });
      if (!r2.ok) r2 = await tryQuery<any>(slipClient, SLIP_POSITIONS_V2, { owners: list });
      if (r2.ok) {
        const gaugePositions = (r2.data as any).positions ?? [];
        for (const gp of gaugePositions) {
          // FIX: no ?? with || without parens — split into two steps
          const stakerRaw = (gp.owner?.id ?? gp.owner) ?? "";
          const stakerAddr = String(stakerRaw).toLowerCase();
          if (!stakerAddr) continue;
          const depositor = await depositorFromLogs(String(gp.id), stakerAddr);
          if (depositor && addrs.some(a => a.toLowerCase() === depositor.toLowerCase())) {
            gp.owner = depositor;
            (gp as any).__fromGauge = true;
            slipPositions.push(gp);
          }
        }
        notes.push(`Slipstream: scanned ${gaugePositions.length} gauge-owned position(s).`);
      }
    } else {
      notes.push("Slipstream: no staker/gauge list in subgraph.");
    }

    // D) Resolve gauges (for staked flag) for any pools we saw
    const pools = Array.from(new Set(slipPositions.map((p: any) => String(p.pool?.id || "").toLowerCase()).filter(Boolean)));
    const poolGauge = new Map<string, string>();
    for (const pid of pools) { const g = await gaugeForPool(pid); if (g) poolGauge.set(pid, g); }

    // E) Normalize & compute range; fall back to on-chain ticks if missing
    for (const p of slipPositions) {
      const ownerRaw = p.owner?.id ?? p.owner;
      const ownerLc = String(ownerRaw || "").toLowerCase();
      const poolId = String(p.pool?.id || "").toLowerCase();
      const gauge = poolGauge.get(poolId);

      let { tickLower, tickUpper, currentTick } = getTicksFromRow(p);
      if ((tickLower === null || tickUpper === null) && String(p.id)) {
        const t = await fetchTicksFromNFPM(String(p.id));
        if (t.tickLower !== null) tickLower = t.tickLower;
        if (t.tickUpper !== null) tickUpper = t.tickUpper;
      }
      const inRange = (tickLower !== null && tickUpper !== null && currentTick !== null)
        ? (currentTick >= tickLower && currentTick <= tickUpper)
        : null;

      const staked = !!gauge && (ownerLc === gauge || !!(p as any).__fromGauge || !!(p as any).__forceDepositor);

      items.push({
        kind: "SLIPSTREAM",
        owner: ownerRaw,
        tokenId: p.id,
        poolId: p.pool?.id,
        token0: p.pool?.token0, token1: p.pool?.token1,
        deposited: { token0: p.depositedToken0 ?? "0", token1: p.depositedToken1 ?? "0" },
        current: null,
        fees: { token0: p.collectedFeesToken0 ?? "0", token1: p.collectedFeesToken1 ?? "0" },
        emissions: null,
        range: { tickLower, tickUpper, currentTick, status: inRange === null ? "-" : (inRange ? "IN" : "OUT") },
        staked,
      });
    }
    notes.push(`Slipstream: positions loaded ✅ (${items.filter(i => i.kind==='SLIPSTREAM').length} rows).`);
  }

  // ---------- (optional) SOLIDLY ----------
  if (solidClient) {
    const r = await tryQuery<any>(solidClient, SOLID_USERS_LP, { owners: addrs });
    if (r.ok) {
      const users = (r.data as any).users ?? [];
      for (const u of users) {
        for (const lp of (u.liquidityPositions ?? [])) {
          const pair = lp.pair;
          const owner = u.id;
          const balance = Number(lp.liquidityTokenBalance ?? 0);
          const totalSupply = Number(pair?.totalSupply ?? 0);
          const share = totalSupply > 0 ? balance / totalSupply : 0;
          const amt0 = share * Number(pair?.reserve0 ?? 0);
          const amt1 = share * Number(pair?.reserve1 ?? 0);
          items.push({
            kind: "SOLIDLY",
            owner,
            lpToken: pair?.id,
            token0: pair?.token0, token1: pair?.token1,
            deposited: { token0: amt0.toString(), token1: amt1.toString() },
            current: { token0: amt0.toString(), token1: amt1.toString() },
            fees: null, emissions: null, range: null, staked: !!lp.gauge,
          });
        }
      }
    }
  }

  return NextResponse.json({ items, notes });
}
