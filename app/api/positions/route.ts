import { NextRequest, NextResponse } from "next/server";
import { GraphQLClient, gql } from "graphql-request";

export const revalidate = 30;

// Env
const SLIP_URL = process.env.AERO_SLIPSTREAM_SUBGRAPH || "";
const SOLID_URL = process.env.AERO_SOLIDLY_SUBGRAPH || "";

// Optional headers (harmless for The Graph; useful on some hosts)
const SUBGRAPH_KEY = process.env.SUBGRAPH_API_KEY;
const AUTH_HEADERS: Record<string, string> | undefined = SUBGRAPH_KEY
  ? { "x-api-key": SUBGRAPH_KEY, "api-key": SUBGRAPH_KEY, Authorization: `Bearer ${SUBGRAPH_KEY}` }
  : undefined;

function makeClient(url: string | undefined) {
  if (!url) return null;
  try { return new GraphQLClient(url, AUTH_HEADERS ? { headers: AUTH_HEADERS } : undefined); } catch { return null; }
}

const slipClient = makeClient(SLIP_URL);
const solidClient = makeClient(SOLID_URL);

type Address = `0x${string}`;
type TryResult<T> = { ok: true; data: T } | { ok: false; err: string };

async function tryQuery<T>(client: GraphQLClient | null, query: string, variables: any): Promise<TryResult<T>> {
  if (!client) return { ok: false, err: "no client" };
  try {
    const r = await client.request<T>(query, variables);
    return { ok: true, data: r };
  } catch (e: any) {
    const msg = e?.response?.errors?.map((x: any) => x.message).join("; ") || e?.message || "unknown";
    return { ok: false, err: msg };
  }
}

/** ---------------- SLIPSTREAM (CL) ----------------
 * Many UniV3-style subs DON'T expose tokensOwed*, but DO expose:
 * collectedFeesToken0/1, deposited/withdrawn, etc. We’ll use those.
 */
const SLIP_CANDIDATES = [
  // Owner + collectedFees + pool.tick
  gql`query($owners:[String!]!){
    positions(where:{ owner_in:$owners }) {
      id owner liquidity tickLower tickUpper
      collectedFeesToken0 collectedFeesToken1
      depositedToken0 depositedToken1
      withdrawnToken0 withdrawnToken1
      pool { id feeTier token0{ id symbol decimals } token1{ id symbol decimals } tick }
    }
  }`,
  // Same but sometimes the owner field is 'owner.id'
  gql`query($owners:[String!]!){
    positions(where:{ owner_in:$owners }) {
      id owner
      liquidity tickLower tickUpper
      collectedFeesToken0 collectedFeesToken1
      pool { id feeTier token0{ id symbol decimals } token1{ id symbol decimals } tick }
    }
  }`,
];

/** ---------------- SOLIDLY (Classic V2-like) ----------------
 * Many Aerodrome/Velo forks provide liquidity via liquidityPositions.
 * Some schemas prefer fetching via users{id_in:[]} -> liquidityPositions.
 */
const SOLID_CANDIDATES = [
  // 1) users{id_in} -> liquidityPositions (most robust)
  gql`query($owners:[String!]!){
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
  }`,
  // 2) direct filter on liquidityPositions
  gql`query($owners:[String!]!){
    liquidityPositions(where:{ user_in:$owners, liquidityTokenBalance_gt: "0" }) {
      user { id }
      pair {
        id stable
        token0{ id symbol decimals } token1{ id symbol decimals }
        reserve0 reserve1 totalSupply
      }
      liquidityTokenBalance
      gauge { id }
    }
  }`,
];

export async function GET(req: NextRequest) {
  const addrs = req.nextUrl.searchParams.getAll("addresses[]").map(a => a.toLowerCase()).filter(Boolean) as Address[];
  if (!addrs.length) {
    return NextResponse.json({ items: [], notes: ["Pass addresses[]=0x... in the query string."] });
  }

  const items: any[] = [];
  const notes: string[] = [];

  // ---- Slipstream
  if (slipClient) {
    let ok = false, errs: string[] = [];
    for (const q of SLIP_CANDIDATES) {
      const r = await tryQuery<any>(slipClient, q, { owners: addrs });
      if (r.ok) {
        const positions = (r.data as any).positions ?? [];
        for (const p of positions) {
          const currentTick = Number(p.pool?.tick ?? 0);
          const tickLower = Number(p.tickLower), tickUpper = Number(p.tickUpper);
          const inRange = currentTick >= tickLower && currentTick <= tickUpper;
          items.push({
            kind: "SLIPSTREAM",
            owner: p.owner?.id ?? p.owner,
            tokenId: p.id,
            token0: p.pool?.token0, token1: p.pool?.token1,
            deposited: { token0: p.depositedToken0 ?? "0", token1: p.depositedToken1 ?? "0" },
            current: null, // computing live amounts from liquidity+ticks would be on-chain math
            fees: { token0: p.collectedFeesToken0 ?? "0", token1: p.collectedFeesToken1 ?? "0" },
            emissions: null,
            range: { tickLower, tickUpper, currentTick, status: inRange ? "IN" : "OUT" },
            staked: false,
          });
        }
        notes.push("Slipstream: matched schema variant ✅");
        ok = true;
        break;
      } else {
        errs.push(r.err);
      }
    }
    if (!ok) notes.push(`Slipstream query failed. Tried ${SLIP_CANDIDATES.length} variants. Last error: ${errs.at(-1)}`);
  } else {
    notes.push("AERO_SLIPSTREAM_SUBGRAPH missing; skipping CL positions.");
  }

  // ---- Solidly
  if (solidClient) {
    let ok = false, errs: string[] = [];
    // 1) users -> LPs
    {
      const q = SOLID_CANDIDATES[0];
      const r = await tryQuery<any>(solidClient, q, { owners: addrs });
      if (r.ok) {
        const users = (r.data as any).users ?? [];
        if (users.length) {
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
          notes.push("Solidly: matched users→liquidityPositions variant ✅");
          ok = true;
        } else {
          errs.push("users[] query returned empty or not supported");
        }
      } else {
        errs.push(r.err);
      }
    }
    // 2) direct liquidityPositions filter
    if (!ok) {
      const q = SOLID_CANDIDATES[1];
      const r = await tryQuery<any>(solidClient, q, { owners: addrs });
      if (r.ok) {
        const rows = (r.data as any).liquidityPositions ?? [];
        for (const b of rows) {
          const pair = b.pair;
          const owner = b.user?.id ?? b.user;
          const balance = Number(b.liquidityTokenBalance ?? 0);
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
            staked: !!b.gauge,
          });
        }
        notes.push("Solidly: matched liquidityPositions variant ✅");
        ok = true;
      } else {
        errs.push(r.err);
      }
    }
    if (!ok) notes.push(`Solidly query failed. Tried ${SOLID_CANDIDATES.length} variants. Last error: ${errs.at(-1)}`);
  } else {
    notes.push("AERO_SOLIDLY_SUBGRAPH missing; skipping Classic LP balances.");
  }

  return NextResponse.json({ items, notes });
}
