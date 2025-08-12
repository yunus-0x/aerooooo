import { NextRequest, NextResponse } from "next/server";
import { GraphQLClient, gql } from "graphql-request";

export const revalidate = 30;

// ----- ENV -----
const SLIP_URL = process.env.AERO_SLIPSTREAM_SUBGRAPH || "";
const SOLID_URL = process.env.AERO_SOLIDLY_SUBGRAPH || "";
const SUBGRAPH_KEY = process.env.SUBGRAPH_API_KEY || "";
const BASE_RPC_URL = process.env.BASE_RPC_URL || "";
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

// --- Minimal JSON-RPC helper (no extra deps) ---
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

// keccak256("Transfer(address,address,uint256)") for ERC-721
const ERC721_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// topic helpers
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

// Voter.gauges(pool) => gauge
const VOTER_GAUGES_ABI_SELECTOR = "0x1f9a1d3f"; // bytes4(keccak256("gauges(address)"))
// encode call data: 0x1f9a1d3f + left-padded pool address
function encodeGaugesCall(pool: string) {
  const p = pool.toLowerCase().replace(/^0x/, "");
  return VOTER_GAUGES_ABI_SELECTOR + ("0".repeat(24) + p);
}
async function voterGaugeForPool(pool: string): Promise<string | null> {
  try {
    const data = encodeGaugesCall(pool);
    const out = await rpc("eth_call", [{ to: AERO_VOTER, data }, "latest"]);
    if (!out || out === "0x") return null;
    // decode one address from 32-byte return
    const addr = "0x" + out.slice(-40);
    return addr.toLowerCase() === "0x0000000000000000000000000000000000000000" ? null : addr;
  } catch {
    return null;
  }
}

// find depositor: last Transfer(to=gauge, tokenId=...) on NFPM
async function findDepositorByLogs(tokenId: string, gauge: string): Promise<string | null> {
  try {
    const logs = await rpc("eth_getLogs", [{
      address: SLIPSTREAM_NFPM,
      topics: [
        ERC721_TRANSFER_TOPIC,
        null,
        toTopicAddress(gauge),
        tokenIdToTopic(tokenId),
      ],
      fromBlock: "0x1",
      toBlock: "latest",
    }]);
    if (!Array.isArray(logs) || logs.length === 0) return null;
    // take the latest by blockNumber
    logs.sort((a: any, b: any) => BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1 : -1);
    const last = logs[logs.length - 1];
    const fromTopic = last.topics?.[1];
    if (!fromTopic) return null;
    return ("0x" + fromTopic.slice(-40)).toLowerCase();
  } catch {
    return null;
  }
}

// ----- Queries -----
const SLIP_POSITIONS = gql`query($owners:[String!]!){
  positions(where:{ owner_in:$owners }) {
    id owner
    liquidity tickLower tickUpper
    collectedFeesToken0 collectedFeesToken1
    depositedToken0 depositedToken1
    withdrawnToken0 withdrawnToken1
    pool { id feeTier token0{ id symbol decimals } token1{ id symbol decimals } tick }
  }
}`;

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

// ----- Handler -----
export async function GET(req: NextRequest) {
  const addrs = req.nextUrl.searchParams.getAll("addresses[]").map(a => a.toLowerCase()).filter(Boolean) as Address[];
  if (!addrs.length) {
    return NextResponse.json({ items: [], notes: ["Pass addresses[]=0x... in the query string."] });
  }

  const items: any[] = [];
  const notes: string[] = [];

  // ---- Slipstream (CL): include staked via on-chain Voter + logs mapping ----
  if (slipClient) {
    // Query both wallets and (later) gauge owners — we’ll add gauges as we discover them
    const owners = new Set<string>(addrs);

    // First pull positions owned by wallets (unstaked) — and by any existing owners set (wallets only here)
    const r = await tryQuery<any>(slipClient, SLIP_POSITIONS, { owners: Array.from(owners) });
    if (!r.ok) {
      notes.push(`Slipstream query failed: ${r.err}`);
    } else {
      let positions = (r.data as any).positions ?? [];

      // Collect unique pools we see to compute gauges
      const pools = new Set<string>(positions.map((p: any) => (p.pool?.id || "").toLowerCase()).filter(Boolean));

      // For each pool, resolve gauge via Voter
      const poolGauge = new Map<string, string>();
      for (const pool of pools) {
        const g = await voterGaugeForPool(pool);
        if (g) poolGauge.set(pool, g.toLowerCase());
      }
      if (poolGauge.size) notes.push(`Slipstream: resolved ${poolGauge.size} gauge(s) via Voter.`);

      // If any position is actually staked (owner == gauge), we’ll map depositor via logs.
      const toResolve: Array<{ tokenId: string; gauge: string }> = [];

      for (const p of positions) {
        const ownerRaw = p.owner?.id ?? p.owner;
        const poolId = (p.pool?.id || "").toLowerCase();
        const gauge = poolGauge.get(poolId);
        const isStaked = !!gauge && String(ownerRaw || "").toLowerCase() === gauge;

        // try to map depositor if staked
        let depositor: string | null = null;
        if (isStaked) {
          if (!BASE_RPC_URL) {
            notes.push("BASE_RPC_URL missing: cannot resolve depositor for staked NFTs.");
          } else {
            toResolve.push({ tokenId: String(p.id), gauge });
          }
        }

        const currentTick = Number(p.pool?.tick ?? 0);
        const tickLower = Number(p.tickLower), tickUpper = Number(p.tickUpper);
        const inRange = currentTick >= tickLower && currentTick <= tickUpper;

        items.push({
          kind: "SLIPSTREAM",
          owner: ownerRaw, // will replace with depositor after logs step if staked
          tokenId: p.id,
          poolId: p.pool?.id,
          token0: p.pool?.token0, token1: p.pool?.token1,
          deposited: { token0: p.depositedToken0 ?? "0", token1: p.depositedToken1 ?? "0" },
          current: null,
          fees: { token0: p.collectedFeesToken0 ?? "0", token1: p.collectedFeesToken1 ?? "0" },
          emissions: null,
          range: { tickLower, tickUpper, currentTick, status: inRange ? "IN" : "OUT" },
          staked: isStaked,
        });
      }

      // Resolve depositors via logs (batch)
      if (toResolve.length && BASE_RPC_URL) {
        let success = 0;
        for (const { tokenId, gauge } of toResolve) {
          const dep = await findDepositorByLogs(tokenId, gauge);
          if (dep) {
            // patch the item
            const it = items.find((x) => x.kind === "SLIPSTREAM" && String(x.tokenId) === String(tokenId));
            if (it) { it.owner = dep; success++; }
          }
        }
        notes.push(`Slipstream: mapped ${success}/${toResolve.length} staked NFT(s) back to depositor via logs.`);
      }

      notes.push(`Slipstream: positions loaded ✅ (${items.filter(i => i.kind === "SLIPSTREAM").length} rows).`);
    }
  } else {
    notes.push("AERO_SLIPSTREAM_SUBGRAPH missing; skipping CL positions.");
  }

  // ---- Solidly (Classic) optional; your subgraph may not support it yet ----
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
      if (!users.length) notes.push("Solidly: users[] empty (schema may differ).");
      else notes.push("Solidly: matched users→liquidityPositions ✅");
    } else {
      notes.push(`Solidly query failed: ${r.err}`);
    }
  } else {
    notes.push("AERO_SOLIDLY_SUBGRAPH missing; skipping Classic LP balances.");
  }

  return NextResponse.json({ items, notes });
}
