import { NextRequest, NextResponse } from "next/server";
import { GraphQLClient, gql } from "graphql-request";

export const revalidate = 30;

// Env
const SLIP_URL = process.env.AERO_SLIPSTREAM_SUBGRAPH || "";
const SOLID_URL = process.env.AERO_SOLIDLY_SUBGRAPH || "";

// Optional auth headers (useful for Goldsky, harmless for The Graph)
const SUBGRAPH_KEY = process.env.SUBGRAPH_API_KEY;
const AUTH_HEADERS: Record<string, string> | undefined = SUBGRAPH_KEY
  ? {
      "x-api-key": SUBGRAPH_KEY,
      "api-key": SUBGRAPH_KEY,
      Authorization: `Bearer ${SUBGRAPH_KEY}`,
    }
  : undefined;

function makeClient(url: string | undefined) {
  if (!url) return null;
  try {
    return new GraphQLClient(url, AUTH_HEADERS ? { headers: AUTH_HEADERS } : undefined);
  } catch {
    return null;
  }
}

const slipClient = makeClient(SLIP_URL);
const solidClient = makeClient(SOLID_URL);

// ---------- TEMPLATE QUERIES (adjust to your schema) ----------
const SLIP_POSITIONS = gql`
  query SlipPositions($owners: [String!]!) {
    positions(where: { owner_in: $owners }) {
      id
      owner
      liquidity
      tickLower
      tickUpper
      tokensOwed0
      tokensOwed1
      pool {
        id
        feeTier
        token0 { id symbol decimals }
        token1 { id symbol decimals }
        tick
      }
    }
  }
`;

const SOLID_LPS = gql`
  query SolidBalances($owners: [String!]!] {
    userBalances(where: { user_in: $owners, balance_gt: 0 }) {
      user
      balance
      pair {
        id
        stable
        token0 { id symbol decimals }
        token1 { id symbol decimals }
        reserve0
        reserve1
        totalSupply
      }
      gauge { id }
    }
  }
`;
// ---------------------------------------------------------------

type Address = `0x${string}`;

export async function GET(req: NextRequest) {
  const addrs = req.nextUrl.searchParams
    .getAll("addresses[]")
    .map((a) => a.toLowerCase())
    .filter(Boolean) as Address[];

  if (!addrs.length) {
    return NextResponse.json({
      items: [],
      notes: ["Pass addresses[]=0x... in the query string."],
    });
  }

  const items: any[] = [];
  const notes: string[] = [];

  // Slipstream CL positions
  let slip: any[] = [];
  if (slipClient) {
    try {
      const r = await slipClient.request(SLIP_POSITIONS, { owners: addrs });
      slip = (r as any)?.positions || [];
    } catch (e) {
      notes.push("Slipstream subgraph query failed; check AERO_SLIPSTREAM_SUBGRAPH.");
    }
  } else {
    notes.push("AERO_SLIPSTREAM_SUBGRAPH missing; skipping CL positions.");
  }

  // Solidly (classic) LP balances
  let solid: any[] = [];
  if (solidClient) {
    try {
      const r = await solidClient.request(SOLID_LPS, { owners: addrs });
      solid = (r as any)?.userBalances || [];
    } catch (e) {
      notes.push("Solidly subgraph query failed; check AERO_SOLIDLY_SUBGRAPH.");
    }
  } else {
    notes.push("AERO_SOLIDLY_SUBGRAPH missing; skipping Classic LP balances.");
  }

  // Normalize Slipstream
  for (const p of slip) {
    const currentTick = Number(p.pool?.tick ?? 0);
    const tickLower = Number(p.tickLower);
    const tickUpper = Number(p.tickUpper);
    const inRange = currentTick >= tickLower && currentTick <= tickUpper;

    items.push({
      kind: "SLIPSTREAM",
      owner: p.owner,
      tokenId: p.id,
      token0: p.pool?.token0,
      token1: p.pool?.token1,
      deposited: null, // requires indexer support
      current: null, // could be computed on-chain from liquidity & ticks
      fees: { token0: p.tokensOwed0, token1: p.tokensOwed1 },
      emissions: null, // add via gauge earned() or indexer
      range: { tickLower, tickUpper, currentTick, status: inRange ? "IN" : "OUT" },
      staked: false, // set true if your indexer exposes it
    });
  }

  // Normalize Solidly
  for (const b of solid) {
    const pair = b.pair;
    const balance = Number(b.balance);
    const totalSupply = Number(pair.totalSupply || 0);
    const share = totalSupply > 0 ? balance / totalSupply : 0;
    const amt0 = share * Number(pair.reserve0 || 0);
    const amt1 = share * Number(pair.reserve1 || 0);

    items.push({
      kind: "SOLIDLY",
      owner: b.user,
      lpToken: pair.id,
      token0: pair.token0,
      token1: pair.token1,
      deposited: { token0: amt0.toString(), token1: amt1.toString() },
      current: { token0: amt0.toString(), token1: amt1.toString() },
      fees: null,
      emissions: null,
      range: null,
      staked: !!b.gauge,
    });
  }

  return NextResponse.json({ items, notes });
}
