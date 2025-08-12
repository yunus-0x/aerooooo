# Aerodrome Positions Monitor (Base)

A minimal, ready-to-deploy web dashboard that shows **staked + unstaked** Aerodrome LP positions on **Base**, with fees/emissions (where available), **in/out of range** for CL (Slipstream) positions, and **USD pricing via CoinGecko** (server-side cached).

> This repo ships with safe fallbacks: if you haven't filled your subgraph URLs yet, it still deploys and returns an empty result with a helpful message.

---

## Quickstart

```bash
# 1) Install deps
npm i

# 2) Run dev
npm run dev
```

Open http://localhost:3000

Paste one or more wallet addresses (comma/space separated).

---

## Environment Variables

Create **.env.local** (or use Vercel "Environment Variables"):

```
BASE_RPC_URL=https://mainnet.base.org

# Put your own indexers here. If left blank, the API returns an empty dataset but the app still runs.
AERO_SOLIDLY_SUBGRAPH=
AERO_SLIPSTREAM_SUBGRAPH=
AERO_GAUGES_SUBGRAPH=

# Optional key (public API works but rate-limited)
COINGECKO_API_KEY=
SUBGRAPH_API_KEY=
```

See **.env.example** for reference.

---

## Deploy to Vercel

1. Push this repo to GitHub:

```bash
git init
git add -A
git commit -m "feat: aerodrome positions monitor (Base)"
git branch -M main
git remote add origin <your-github-remote>
git push -u origin main
```

> If you ever see `fatal: You are not currently on a branch`, run:
> `git switch -c main && git push -u origin main`

2. In Vercel:
   - Import the GitHub repo
   - Add the environment variables from above
   - Deploy

---

## How it works

- **UI**: Next.js App Router + Tailwind + TanStack Query
- **/api/prices**: Server route that calls CoinGecko and caches 60s
- **/api/positions**: Composition layer that queries your Solidly + Slipstream subgraphs (if provided) and normalizes results
- **In-range**: For Slipstream CL, `tickLower ≤ currentTick ≤ tickUpper`

> You can extend `/app/api/positions/route.ts` to call **gauge contracts on-chain** using **viem** for emissions if your indexers don't have it.

---

## Customize (TODOs you might want to fill)

- Fill your subgraph URLs in **.env.local**
- In `/app/api/positions/route.ts`, replace the **GraphQL queries** to match your exact schema
- Add **gauge earned()** on-chain calls if your subgraph doesn't expose them
- Map token addresses → CoinGecko IDs for richer USD breakdowns (see `config/tokens.ts`)

---

## License

MIT


### Subgraph auth

If your indexer requires an API key (e.g., Goldsky, The Graph Studio), set:

```
SUBGRAPH_API_KEY=your_key_here
```

The server will attach this key on GraphQL requests via headers:
- `x-api-key: <key>`
- `api-key: <key>`
- `Authorization: Bearer <key>` (some providers expect bearer auth)
