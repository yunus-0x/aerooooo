import { NextRequest, NextResponse } from "next/server";
import { GraphQLClient, gql } from "graphql-request";

export const revalidate = 30;

// ------- Env -------
const SLIP_URL = process.env.AERO_SLIPSTREAM_SUBGRAPH || "";
const SOLID_URL = process.env.AERO_SOLIDLY_SUBGRAPH || "";

// Optional headers (harmless for The Graph; useful for other hosts)
const SUBGRAPH_KEY = process.env.SUBGRAPH_API_KEY;
const AUTH_HEADERS: Record<string, string> | undefined = SUBGRAPH_KEY
  ? { "x-api-key": SUBGRAPH_KEY, "api-key": SUBGRAPH_KEY, Authorization: `Bearer ${SUBGRAPH_KEY}` }
  : undefined;

// Optional manual CSV of known staker/gauge addresses (lowercased)
const STAKERS_FROM_ENV = (process.env.SLIPSTREAM_STAKERS || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// ------- Clients -------
function makeClient(url: string | undefined) {
  if (!url) return null;
  try { return new GraphQLClient(url, AUTH_HEADERS ? { headers: AUTH_HEADERS } : undefined); } catch { return null; }
}
const slipClient = makeClient(SLIP_URL);
const solidClient = makeClient(SOLID_URL);

// ------- Helpers -------
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

// ------- Discover Slipstream staker/gauges from subgraph -------
const GAUGE_CANDIDATES = [
  gql`{ clGauges { id } }`,                       // common CL gauge entity
  gql`{ gauges { id } }`,                         // generic gauges
  gql`{ positionStakers { id } }`,                // some subs use this name
  gql`{ nonfungiblePositionStakers { id } }`,     // another variant
];

async function discoverStakers(client: GraphQLClient | null): Promise<Set<string>> {
  const found = new Set<string>();
  if (!client) return found;
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
        if (id) found.add(id);
      }
      // stop at first success
      break;
    }
  }
  // merge env-provided stakers
  for (const s of STAKERS_FROM_ENV) found.add(s);
  return found;
}

// ------- Queries (match your working Slipstream variant; try fallbacks) -------
const SLIP_CANDIDATES = [
  // Works on many Aerodrome/UniV3-like subs that track collected fees & deposits
  gql`query($owners:[String!]!){
    positions(where:{ owner_in:$owners }) {
      id owner liquidity tickLower tickUpper
      collectedFeesToken0 collectedFeesToken1
      depositedToken0 depositedToken1
      withdrawnToken0 withdrawnToken1
      pool { id feeTier token0{ id symbol decimals } token1{ id symbol decimals } tick }
    }
  }`,
  // Slightly slimmer variant
  gql`query($owners:[String!]!){
    positions(where:{ owner_in:$owners }) {
      id owner liquidity tickLower tickUpper
      collectedFeesToken0 collectedFeesToken1
      pool { id feeTier token0{ id symbol decimals } token1{ id symbol decimals } tick }
    }
  }`,
];

// Classic (Solidly) variants — your subgraph may not support these; we try politely.
const SOLID_CANDIDATES = [
  // 1) users -> liquidityPositions (most common)
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
  // 2) direct filter
  gql`query($owners:[String!]!){
    liquidityPositions(where:{ user_in:$owners, liquidityTokenBalance_gt:"0" }) {
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

// ------- Handler -------
export async function GET(req: NextRequest) {
  const addrs = req.nextUrl.searchParams.getAll("addresses[]").map(a => a.toLowerCase()).filter(Boolean) as Address[];
  if (!addrs.length) {
    return NextResponse.json({ items: [], notes: ["Pass addresses[]=0x... in the query string."] });
  }

  const items: any[] = [];
  const notes: string[] = [];

  // ---- Slipstream (CL) with staker discovery ----
  if (slipClient) {
    const stakers = await discoverStakers(slipClient);
    if (stakers.size) notes.push(`Slipstream: discovered ${stakers.size} staker(s).`);
    if (STAKERS_FROM_ENV.length) notes.push(`Slipstream: ${STAKERS_FROM_ENV.length} staker(s) from env merged.`);

    const ownersOrStakers = Array.from(new Set([...addrs, ...Array.from(stakers)]));

    let ok = false, errs: string[] = [];
    for (const q of SLIP_CANDIDATES) {
      const r = await tryQuery<any>(slipClient, q, { owners: ownersOrStakers });
      if (r.ok) {
        const positions = (r.data as any).positions ?? [];
        for (const p of positions) {
          const ownerRaw = p.owner?.id ?? p.owner;
          const ownerLc = String(ownerRaw || "").toLowerCase();
          const isStaked = stakers.has(ownerLc);

          const currentTick = Number(p.pool?.tick ?? 0);
          const tickLower = Number(p.tickLower), tickUpper = Number(p.tickUpper);
          const inRange = currentTick >= tickLower && currentTick <= tickUpper;

          items.push({
            kind: "SLIPSTREAM",
            owner: ownerRaw,
            tokenId: p.id,
            token0: p.pool?.token0, token1: p.pool?.token1,
            deposited: { token0: p.depositedToken0 ?? "0", token1: p.depositedToken1 ?? "0" },
            current: null, // on-chain math from liquidity + ticks if you want live composition
            fees: { token0: p.collectedFeesToken0 ?? "0", token1: p.collectedFeesToken1 ?? "0" },
            emissions: null, // fill from gauge earned() if you have gauge ABI/addresses
            range: { tickLower, tickUpper, currentTick, status: inRange ? "IN" : "OUT" },
            staked: isStaked,
          });
        }
        notes.push("Slipstream: positions loaded ✅ (including staked via gauge owners).");
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

  // ---- Solidly (Classic) — try common variants, but your subgraph may not support it ----
  if (solidClient) {
    let ok = false, errs: string[] = [];

    // 1) users -> liquidityPositions
    {
      const r = await tryQuery<any>(solidClient, SOLID_CANDIDATES[0], { owners: addrs });
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
          errs.push("users[] query returned empty or unsupported.");
        }
      } else {
        errs.push(r.err);
      }
    }

    // 2) direct liquidityPositions
    if (!ok) {
      const r = await tryQuery<any>(solidClient, SOLID_CANDIDATES[1], { owners: addrs });
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
