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
    ? { "x-api-key": SUBGRAPH_KEY, "api-key": SUBGRAPH_KEY, Authorization: `Bearer ${SUBGRAPH_KEY}` }
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

// find depositor: last Transfer(to=gauge, tokenId=...) on NFPM
async function depositorFromLogs(tokenId: string, gauge: string): Promise<string | null> {
  try {
    const logs = await rpc("eth_getLogs", [{
      address: SLIPSTREAM_NFPM,
      topics: [ ERC721_TRANSFER_TOPIC, null, toTopicAddress(gauge), tokenIdToTopic(tokenId) ],
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

// ----- Solidly (optional; may not match your subgraph) -----
const SOLID_USERS_LP = gql`query($owners:[String!]!){
  users(where:{ id_in:$owners }){
    id
    liquidityPositions {
      pair {
        id stable
        token0{ id symbol decimals } token1{ id symbol decimals }
        reserve0 reserve1 totalSupply
      }
      liquidityTokenBalance
      gauge { id }
    }
  }
}`;

// normalize ticks
function getTicks(p: any) {
  const tl = p.tickLower ?? p.lowerTick ?? null;
  const tu = p.tickUpper ?? p.upperTick ?? null;
  const ct = p.pool?.tick ?? p.pool?.currentTick ?? null;
  return {
    tickLower: tl !== null ? Number(tl) : null,
    tickUpper: tu !== null ? Number(tu) : null,
    currentTick: ct !== null ? Number(ct) : null,
  };
}

export async function GET(req: NextRequest) {
  const addrs = req.nextUrl.searchParams.getAll("addresses[]").map(a => a.toLowerCase()).filter(Boolean) as Address[];
  if (!addrs.length) {
    return NextResponse.json({ items: [], notes: ["Pass addresses[]=0x... in the query string."] });
  }

  const items: any[] = [];
  const notes: string[] = [];

  // -------- SLIPSTREAM --------
  let slipPositions: any[] = [];

  if (!slipClient) {
    notes.push("AERO_SLIPSTREAM_SUBGRAPH missing; skipping CL positions.");
  } else {
    // 0) Discover ALL stakers/gauges from subgraph
    const allStakers = await discoverAllStakers(slipClient);
    if (allStakers.size) notes.push(`Slipstream: discovered ${allStakers.size} staker(s) from subgraph.`);

    // 1) Wallet-owned positions (pass owners = wallets)
    let r = await tryQuery<any>(slipClient, SLIP_POSITIONS_V1, { owners: addrs });
    if (!r.ok) r = await tryQuery<any>(slipClient, SLIP_POSITIONS_V2, { owners: addrs });
    if (!r.ok) {
      notes.push(`Slipstream (wallet) query failed: ${r.err}`);
    } else {
      slipPositions = (r.data as any).positions ?? [];
    }

    // resolve gauges for pools seen (used for staked flag)
    const poolIds = Array.from(new Set(slipPositions.map((p: any) => String(p.pool?.id || "").toLowerCase()).filter(Boolean)));
    const poolGauge = new Map<string, string>();
    for (const pid of poolIds) {
      const g = await gaugeForPool(pid);
      if (g) poolGauge.set(pid, g);
    }
    if (poolGauge.size) notes.push(`Slipstream: resolved ${poolGauge.size} gauge(s) via Voter.`);

    // 2) Gauge-owned positions (owner = ANY discovered staker)
    if (allStakers.size) {
      const gaugeList = Array.from(allStakers);
      let r2 = await tryQuery<any>(slipClient, SLIP_POSITIONS_V1, { owners: gaugeList });
      if (!r2.ok) r2 = await tryQuery<any>(slipClient, SLIP_POSITIONS_V2, { owners: gaugeList });
      if (r2.ok) {
        const gaugePositions = (r2.data as any).positions ?? [];

        // Map depositor via logs and keep only those whose depositor is in addrs
        for (const gp of gaugePositions) {
          const poolId = String(gp.pool?.id || "").toLowerCase();
          // for staked flag & in-range we also want the gauge address; try voter if not known
          let gauge = poolGauge.get(poolId);
          if (!gauge) {
            const g = await gaugeForPool(poolId);
            if (g) {
              gauge = g;
              poolGauge.set(poolId, g);
            }
          }
          if (!gauge) continue;

          const depositor = await depositorFromLogs(String(gp.id), gauge);
          if (depositor && addrs.some(a => a.toLowerCase() === depositor.toLowerCase())) {
            gp.owner = depositor;            // rewrite to wallet
            (gp as any).__fromGauge = true;  // mark as staked
            slipPositions.push(gp);
          }
        }
      } else {
        notes.push(`Slipstream (gauge) query failed: ${r2.err}`);
      }
    } else {
      notes.push("Slipstream: no stakers found in subgraph (cannot pull gauge-owned NFTs).");
    }

    // 3) Normalize (wallet + matched gauge)
    for (const p of slipPositions) {
      const ownerRaw = p.owner?.id ?? p.owner;
      const ownerLc = String(ownerRaw || "").toLowerCase();

      const poolId = String(p.pool?.id || "").toLowerCase();
      const gauge = poolGauge.get(poolId);
      const staked = !!gauge && ownerLc === gauge && !(p as any).__fromGauge;

      const { tickLower, tickUpper, currentTick } = getTicks(p);
      const inRange = tickLower !== null && tickUpper !== null && currentTick !== null
        ? currentTick >= tickLower && currentTick <= tickUpper
        : null;

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
        range: {
          tickLower,
          tickUpper,
          currentTick,
          status: inRange === null ? "-" : (inRange ? "IN" : "OUT"),
        },
        staked: staked || !!(p as any).__fromGauge,
      });
    }
    if (items.some(i => i.kind === "SLIPSTREAM")) {
      notes.push(`Slipstream: positions loaded ✅ (${items.filter(i => i.kind==='SLIPSTREAM').length} rows).`);
    }
  }

  // -------- Solidly (optional) --------
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
            fees: null,
            emissions: null,
            range: null,
            staked: !!lp.gauge,
          });
        }
      }
    }
  }

  return NextResponse.json({ items, notes });
}
