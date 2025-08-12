import { NextRequest, NextResponse } from "next/server";
import { GraphQLClient, gql } from "graphql-request";

export const revalidate = 30;

// ------- Env -------
const SLIP_URL = process.env.AERO_SLIPSTREAM_SUBGRAPH || "";
const SOLID_URL = process.env.AERO_SOLIDLY_SUBGRAPH || ""; // kept as-is; may not be supported by your subgraph yet

// Optional headers (harmless for The Graph; useful on other hosts)
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
  gql`{ clGauges { id } }`,
  gql`{ gauges { id } }`,
  gql`{ positionStakers { id } }`,
  gql`{ nonfungiblePositionStakers { id } }`,
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
      break; // stop at first successful schema
    }
  }
  for (const s of STAKERS_FROM_ENV) found.add(s);
  return found;
}

// ------- Slipstream (positions) variants -------
const SLIP_POSITIONS_CANDIDATES = [
  gql`query($owners:[String!]!){
    positions(where:{ owner_in:$owners }) {
      id owner
      liquidity tickLower tickUpper
      collectedFeesToken0 collectedFeesToken1
      depositedToken0 depositedToken1
      withdrawnToken0 withdrawnToken1
      pool { id feeTier token0{ id symbol decimals } token1{ id symbol decimals } tick }
    }
  }`,
  gql`query($owners:[String!]!){
    positions(where:{ owner_in:$owners }) {
      id owner
      liquidity tickLower tickUpper
      collectedFeesToken0 collectedFeesToken1
      pool { id feeTier token0{ id symbol decimals } token1{ id symbol decimals } tick }
    }
  }`,
];

// ------- Slipstream (depositor mapping) variants -------
// Try common entity names that relate tokenId -> depositor (user/account/owner).
const STAKED_OWNER_CANDIDATES = [
  // stakedPositions by tokenId
  gql`query($tokenIds:[String!]!){
    stakedPositions(where:{ tokenId_in:$tokenIds }) { tokenId user { id } }
  }`,
  // stakedPositions by id (id == tokenId as string on some subs)
  gql`query($tokenIds:[String!]!){
    stakedPositions(where:{ id_in:$tokenIds }) { id user { id } }
  }`,
  // positionStakings
  gql`query($tokenIds:[String!]!){
    positionStakings(where:{ tokenId_in:$tokenIds }) { tokenId user { id } }
  }`,
  // stakes (owner field)
  gql`query($tokenIds:[String!]!){
    stakes(where:{ tokenId_in:$tokenIds }) { tokenId owner { id } }
  }`,
  // stakedNonFungiblePositions
  gql`query($tokenIds:[String!]!){
    stakedNonFungiblePositions(where:{ tokenId_in:$tokenIds }) { tokenId account { id } }
  }`,
];

async function mapDepositorsBySubgraph(client: GraphQLClient, tokenIds: string[]) {
  const map = new Map<string, string>();
  if (!tokenIds.length) return map;
  for (const q of STAKED_OWNER_CANDIDATES) {
    const r = await tryQuery<any>(client, q, { tokenIds });
    if (!r.ok) continue;
    const data = r.data as any;

    const push = (tid: any, ownerObj: any) => {
      const tokenId = String(tid ?? "").toString();
      const owner = ownerObj?.id ?? ownerObj;
      if (tokenId && owner) map.set(tokenId, String(owner));
    };

    if (Array.isArray(data.stakedPositions)) {
      for (const row of data.stakedPositions) {
        push(row.tokenId ?? row.id, row.user);
      }
      break;
    }
    if (Array.isArray(data.positionStakings)) {
      for (const row of data.positionStakings) push(row.tokenId, row.user);
      break;
    }
    if (Array.isArray(data.stakes)) {
      for (const row of data.stakes) push(row.tokenId, row.owner);
      break;
    }
    if (Array.isArray(data.stakedNonFungiblePositions)) {
      for (const row of data.stakedNonFungiblePositions) push(row.tokenId, row.account);
      break;
    }
  }
  return map;
}

// ------- Solidly (classic) variants (kept; may not match your subgraph yet) -------
const SOLID_CANDIDATES = [
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

export async function GET(req: NextRequest) {
  const addrs = req.nextUrl.searchParams.getAll("addresses[]").map(a => a.toLowerCase()).filter(Boolean) as Address[];
  if (!addrs.length) {
    return NextResponse.json({ items: [], notes: ["Pass addresses[]=0x... in the query string."] });
  }

  const items: any[] = [];
  const notes: string[] = [];

  // ---- Slipstream (CL) with staker discovery + depositor mapping ----
  if (slipClient) {
    const stakers = await discoverStakers(slipClient);
    if (stakers.size) notes.push(`Slipstream: discovered ${stakers.size} staker(s).`);
    if (STAKERS_FROM_ENV.length) notes.push(`Slipstream: ${STAKERS_FROM_ENV.length} staker(s) from env merged.`);
    const ownersOrStakers = Array.from(new Set([...addrs, ...Array.from(stakers)]));

    // Fetch positions (wallets + stakers)
    let slipOk = false, slipErrs: string[] = [];
    let slipPositions: any[] = [];
    for (const q of SLIP_POSITIONS_CANDIDATES) {
      const r = await tryQuery<any>(slipClient, q, { owners: ownersOrStakers });
      if (r.ok) {
        slipPositions = (r.data as any).positions ?? [];
        slipOk = true;
        break;
      } else {
        slipErrs.push(r.err);
      }
    }
    if (!slipOk) {
      notes.push(`Slipstream query failed. Tried ${SLIP_POSITIONS_CANDIDATES.length} variants. Last error: ${slipErrs.at(-1)}`);
    }

    // Identify which tokenIds are staked (owner == staker)
    const stakedTokenIds: string[] = [];
    for (const p of slipPositions) {
      const ownerRaw = p.owner?.id ?? p.owner;
      const ownerLc = String(ownerRaw || "").toLowerCase();
      if (stakers.has(ownerLc)) stakedTokenIds.push(String(p.id));
    }

    // Map staked tokenIds back to depositor via subgraph
    const depositorMap = await mapDepositorsBySubgraph(slipClient, stakedTokenIds);

    // Normalize rows (replace owner with depositor when staked)
    for (const p of slipPositions) {
      const ownerRaw = p.owner?.id ?? p.owner;
      const ownerLc = String(ownerRaw || "").toLowerCase();
      const isStaked = stakers.has(ownerLc);
      const mappedDepositor = isStaked ? depositorMap.get(String(p.id)) : undefined;

      const currentTick = Number(p.pool?.tick ?? 0);
      const tickLower = Number(p.tickLower), tickUpper = Number(p.tickUpper);
      const inRange = currentTick >= tickLower && currentTick <= tickUpper;

      items.push({
        kind: "SLIPSTREAM",
        owner: mappedDepositor ?? ownerRaw,           // <-- show original depositor if staked
        tokenId: p.id,
        token0: p.pool?.token0, token1: p.pool?.token1,
        deposited: { token0: p.depositedToken0 ?? "0", token1: p.depositedToken1 ?? "0" },
        current: null,
        fees: { token0: p.collectedFeesToken0 ?? "0", token1: p.collectedFeesToken1 ?? "0" },
        emissions: null,
        range: { tickLower, tickUpper, currentTick, status: inRange ? "IN" : "OUT" },
        staked: isStaked,
      });
    }

    if (slipOk) notes.push(`Slipstream: positions loaded ✅ (${items.filter(i=>i.kind==='SLIPSTREAM').length} rows).`);
    if (stakedTokenIds.length && depositorMap.size === 0) {
      notes.push("Slipstream: staked NFTs found but could not resolve depositor from subgraph (schema doesn’t expose a stake mapping).");
      notes.push("Tip: provide SLIPSTREAM_STAKERS and/or share the subgraph's stake entity name to add a precise mapping.");
    }
  } else {
    notes.push("AERO_SLIPSTREAM_SUBGRAPH missing; skipping CL positions.");
  }

  // ---- Solidly (Classic) — attempt, but may not be supported by your subgraph ----
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
