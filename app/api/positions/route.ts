/* eslint-disable */
import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";

// Force Node runtime (not edge)
export const runtime = "nodejs";

// ========= ENV =========
const BASE_RPC_URL = process.env.BASE_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL || "";
// Default to Sugar (Base) LpSugar v3
const SUGAR_LP_BASE =
  process.env.SUGAR_LP_BASE ||
  "0x68c19e13618c41158fe4baba1b8fb3a9c74bdb0a"; // Aerodrome LpSugar v3 (Base)

// ========= ABIs (minimal) =========
// Position tuple layout mirrors Sugar docs: id, lp, liquidity, staked, amount0, amount1,
// staked0, staked1, unstaked_earned0, unstaked_earned1, emissions_earned,
// tick_lower, tick_upper, sqrt_ratio_lower, sqrt_ratio_upper, alm
const LpSugarAbi = [
  "function positions(uint256 _limit, uint256 _offset, address _account) view returns ((uint256,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,int24,int24,uint160,uint160,address)[])"
];

// Uniswap v3/Slipstream pool basics to compute in-range and fetch token addresses
const SlipstreamPoolAbi = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function token0() view returns (address)",
  "function token1() view returns (address)"
];

const ERC20Abi = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

// ========= helpers =========
function as0x(a: string) {
  return (a || "").toLowerCase() as `0x${string}`;
}
function fmt(amount: bigint, decimals: number) {
  try { return ethers.formatUnits(amount, decimals); } catch { return amount.toString(); }
}

// Fetch ALL positions for one account via paginated Sugar calls
async function loadSugarPositionsFor(
  provider: ethers.Provider,
  lpSugar: ethers.Contract,
  account: `0x${string}`,
  page = 500
) {
  const out: any[] = [];
  let offset = 0n;
  while (true) {
    const rows = await lpSugar.positions(BigInt(page), offset, account);
    if (!rows || rows.length === 0) break;
    out.push(...rows);
    offset += BigInt(rows.length);
    if (rows.length < page) break;
  }
  return out;
}

// Cache pool + token metadata to keep RPC calls low
const poolMetaCache = new Map<string, {
  tick: number,
  token0: `0x${string}`,
  token1: `0x${string}`,
  dec0: number,
  dec1: number,
  sym0: string,
  sym1: string,
}>();

async function getPoolMeta(provider: ethers.Provider, pool: `0x${string}`) {
  const key = pool.toLowerCase();
  if (poolMetaCache.has(key)) return poolMetaCache.get(key)!;

  const poolCtr = new ethers.Contract(pool, SlipstreamPoolAbi, provider);
  const [slot0, t0, t1] = await Promise.all([
    poolCtr.slot0(),
    poolCtr.token0(),
    poolCtr.token1(),
  ]);
  const token0 = as0x(t0);
  const token1 = as0x(t1);

  // Fetch token symbols/decimals
  const erc0 = new ethers.Contract(token0, ERC20Abi, provider);
  const erc1 = new ethers.Contract(token1, ERC20Abi, provider);
  const [dec0, dec1, sym0, sym1] = await Promise.all([
    erc0.decimals().catch(() => 18),
    erc1.decimals().catch(() => 18),
    erc0.symbol().catch(() => "T0"),
    erc1.symbol().catch(() => "T1"),
  ]);

  const meta = {
    tick: Number(slot0.tick),
    token0, token1,
    dec0: Number(dec0), dec1: Number(dec1),
    sym0: String(sym0), sym1: String(sym1),
  };
  poolMetaCache.set(key, meta);
  return meta;
}

type UiItem = {
  kind: "SLIPSTREAM";
  owner: string;
  tokenId: string;
  poolId: string;
  token0: { id: string; symbol: string; decimals: string };
  token1: { id: string; symbol: string; decimals: string };
  deposited: { token0: string; token1: string } | null;
  current: { token0: string; token1: string } | null;
  fees: { token0: string; token1: string };
  emissions: { token: "AERO"; amount: string };
  range: { tickLower: number | null; tickUpper: number | null; currentTick: number | null; status: "IN" | "OUT" | "-" };
  staked: boolean;
};

// ========= handler =========
export async function GET(req: NextRequest) {
  try {
    if (!BASE_RPC_URL) {
      return NextResponse.json(
        { items: [], notes: ["Missing BASE_RPC_URL. Set it in Vercel → Project → Settings → Environment Variables."] },
        { status: 200 }
      );
    }

    const { searchParams } = new URL(req.url);
    const addrs = searchParams.getAll("addresses[]")
      .map(a => as0x(a))
      .filter(Boolean);

    // Allow ?address=0x... as shorthand
    const single = searchParams.get("address");
    if (single) addrs.push(as0x(single));

    if (addrs.length === 0) {
      return NextResponse.json({ items: [], notes: ["Provide addresses via ?addresses[]=0x..."] }, { status: 200 });
    }

    // Provider + Sugar
    const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
    const lpSugar = new ethers.Contract(as0x(SUGAR_LP_BASE), LpSugarAbi, provider);

    const items: UiItem[] = [];
    const notes: string[] = [];

    // Load positions for each wallet
    for (const acct of addrs) {
      const rows: any[] = await loadSugarPositionsFor(provider, lpSugar, acct);
      if (rows.length === 0) {
        notes.push(`No Sugar positions for ${acct.slice(0,6)}…${acct.slice(-4)}.`);
        continue;
      }

      // Collect pool metas in parallel
      const pools = Array.from(new Set(rows.map(r => as0x(r[1])))); // r[1] = lp
      await Promise.all(pools.map(p => getPoolMeta(provider, p as `0x${string}`)));

      for (const r of rows) {
        const id: bigint = r[0];
        const lp: `0x${string}` = as0x(r[1]) as `0x${string}`;
        const liquidity: bigint = r[2];
        const stakedAmt: bigint = r[3];
        const amt0: bigint = r[4];
        const amt1: bigint = r[5];
        const /*staked0*/ _s0: bigint = r[6];
        const /*staked1*/ _s1: bigint = r[7];
        const fees0: bigint = r[8];       // unstaked_earned0
        const fees1: bigint = r[9];       // unstaked_earned1
        const emissions: bigint = r[10];  // emissions_earned
        const tickLower: number = Number(r[11]);
        const tickUpper: number = Number(r[12]);

        const meta = await getPoolMeta(provider, lp);
        const inRange =
          Number.isFinite(tickLower) &&
          Number.isFinite(tickUpper) &&
          meta.tick !== null &&
          meta.tick >= tickLower &&
          meta.tick <= tickUpper;

        items.push({
          kind: "SLIPSTREAM",
          owner: acct,
          tokenId: id.toString(),
          poolId: lp,
          token0: { id: meta.token0, symbol: meta.sym0, decimals: String(meta.dec0) },
          token1: { id: meta.token1, symbol: meta.sym1, decimals: String(meta.dec1) },

          // Sugar doesn't expose original deposit breakdown; keep null,
          // but expose current token sides held by the position (unstaked part).
          deposited: null,
          current: { token0: fmt(amt0, meta.dec0), token1: fmt(amt1, meta.dec1) },

          // Fees from UNSTAKED accrual only (per-position).
          // When staked, these are 0 and earnings come via emissions.
          fees: { token0: fmt(fees0, meta.dec0), token1: fmt(fees1, meta.dec1) },

          // Emissions earned while staked (AERO has 18 decimals on Base).
          emissions: { token: "AERO", amount: ethers.formatUnits(emissions, 18) },

          range: {
            tickLower: Number.isFinite(tickLower) ? tickLower : null,
            tickUpper: Number.isFinite(tickUpper) ? tickUpper : null,
            currentTick: meta.tick ?? null,
            status: Number.isFinite(tickLower) && Number.isFinite(tickUpper)
              ? (inRange ? "IN" : "OUT")
              : "-"
          },

          staked: stakedAmt > 0n || emissions > 0n || _s0 > 0n || _s1 > 0n
        });
      }
    }

    if (items.length === 0) {
      if (!SUGAR_LP_BASE) {
        notes.push("No items and SUGAR_LP_BASE not set — confirm Sugar address.");
      }
      return NextResponse.json({ items, notes }, { status: 200 });
    }

    notes.push("Data source: Sugar (on-chain). No subgraphs needed.");
    return NextResponse.json({ items, notes }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { items: [], notes: ["Sugar handler error", String(err?.message || err)] },
      { status: 200 }
    );
  }
}
