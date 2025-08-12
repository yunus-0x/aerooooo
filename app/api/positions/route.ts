import { NextRequest, NextResponse } from "next/server";
import { GraphQLClient, gql } from "graphql-request";

export const revalidate = 30;

// Env
const SLIP_URL = process.env.AERO_SLIPSTREAM_SUBGRAPH || "";
const SOLID_URL = process.env.AERO_SOLIDLY_SUBGRAPH || "";

// Optional headers (harmless for The Graph)
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

// --- helpers ---
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

// ---------------- SLIPSTREAM (CL) candidates ----------------
const SLIP_CANDIDATES = [
  gql`query($owners:[String!]!){
    positions(where:{ owner_in:$owners }) {
      id owner liquidity tickLower tickUpper
      tokensOwed0 tokensOwed1
      pool { id feeTier token0{ id symbol decimals } token1{ id symbol decimals } tick }
    }
  }`,
  gql`query($owners:[String!]!){
    positions(where:{ owner_in:$owners }) {
      id owner liquidity tickLower tickUpper
      owedToken0: tokensOwed0 owedToken1: tokensOwed1
      pool { id feeTier token0{ id symbol decimals } token1{ id symbol decimals } currentTick: tick }
    }
  }`,
  gql`query($owners:[String!]!){
    positions(where:{ account_in:$owners }) {
      id owner:account liquidity tickLower tickUpper
      tokensOwed0 tokensOwed1
      pool { id feeTier token0{ id symbol decimals } token1{ id symbol decimals } tick }
    }
  }`,
];

// ---------------- SOLIDLY (classic) candidates ----------------
const SOLID_CANDIDATES = [
  // common in Aerodrome/Velo-style subs
  gql`query($owners:[String!]!){
    liquidityPositions(where:{ user_in:$owners, liquidity_gt:0 }) {
      user { id }
      pair {
        id stable
        token0{ id symbol decimals } token1{ id symbol decimals }
        reserve0 reserve1 totalSupply
      }
      liquidity
    }
  }`,
  // alt key field
  gql`query($owners:[String!]!){
    liquidityPositions(where:{ account_in:$owners, liquidity_gt:0 }) {
      user: account
      pair {
        id stable
        token0{ id symbol decimals } token1{ id symbol decimals }
        reserve0 reserve1 totalSupply
      }
      liquidity
    }
  }`,
  // some indexers expose userBalances
  gql`query($owners:[String!]!){
    userBalances(where:{ user_in:$owners, balance_gt:0 }) {
      user balance
      pair {
        id stable
        token0{ id symbol decimals } token1{ id symbol decimals }
        reserve0 reserve1 totalSupply
      }
      gauge { id }
    }
  }`,
  gql`query($owners:[String!]!){
    userBalances(where:{ account_in:$owners, balance_gt:0 }) {
      user: account balance
      pair {
        id stable
        token0{ id symbol decimals } token1{ id symbol decimals }
        reserve0 reserve1 totalSupply
      }
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

  // ---- Slipstream: try candidates until one works
  if (slipClient) {
    let slipOk = false, slipErrs: string[] = [];
    for (const q of SLIP_CANDIDATES) {
      const r = await tryQuery<any>(slipClient, q, { owners: addrs });
      if (r.ok) {
        const positions = (r.data as any).positions ?? [];
        for (const p of positions) {
          const currentTick = Number(p.pool?.tick ?? p.pool?.currentTick ?? 0);
          const tickLower = Number(p.tickLower), tickUpper = Number(p.tickUpper);
          const inRange = currentTick >= tickLower && currentTick <= tickUpper;
          items.push({
            kind: "SLIPSTREAM",
            owner: p.owner,
            tokenId: p.id,
            token0: p.pool?.token0, token1: p.pool?.token1,
            deposited: null, current: null,
            fees: { token0: p.tokensOwed0 ?? p.owedToken0 ?? "0", token1: p.tokensOwed1 ?? p.owedToken1 ?? "0" },
            emissions: null,
            range: { tickLower, tickUpper, currentTick, status: inRange ? "IN" : "OUT" },
            staked: false,
          });
        }
        slipOk = true;
        notes.push("Slipstream: matched schema variant ✅");
        break;
      } else {
        slipErrs.push(r.err);
      }
    }
    if (!slipOk) notes.push(`Slipstream query failed. Tried ${SLIP_CANDIDATES.length} variants. Last error: ${slipErrs.at(-1)}`);
  } else {
    notes.push("AERO_SLIPSTREAM_SUBGRAPH missing; skipping CL positions.");
  }

  // ---- Solidly: try candidates until one works
  if (solidClient) {
    let solidOk = false, solidErrs: string[] = [];
    for (const q of SOLID_CANDIDATES) {
      const r = await tryQuery<any>(solidClient, q, { owners: addrs });
      if (r.ok) {
        const lpA = (r.data as any).liquidityPositions ?? [];
        const ubA = (r.data as any).userBalances ?? [];
        const rows = lpA.length ? lpA.map((x: any) => ({ kind: "LP", ...x })) : ubA.map((x: any) => ({ kind: "UB", ...x }));

        for (const b of rows) {
          const pair = b.pair;
          const user = b.user?.id ?? b.user;
          const balance = b.kind === "LP" ? Number(b.liquidity) : Number(b.balance);
          const totalSupply = Number(pair?.totalSupply ?? 0);
          const share = totalSupply > 0 ? balance / totalSupply : 0;
          const amt0 = share * Number(pair?.reserve0 ?? 0);
          const amt1 = share * Number(pair?.reserve1 ?? 0);

          items.push({
            kind: "SOLIDLY",
            owner: user,
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
        solidOk = true;
        notes.push("Solidly: matched schema variant ✅");
        break;
      } else {
        solidErrs.push(r.err);
      }
    }
    if (!solidOk) notes.push(`Solidly query failed. Tried ${SOLID_CANDIDATES.length} variants. Last error: ${solidErrs.at(-1)}`);
  } else {
    notes.push("AERO_SOLIDLY_SUBGRAPH missing; skipping Classic LP balances.");
  }

  return NextResponse.json({ items, notes });
}
