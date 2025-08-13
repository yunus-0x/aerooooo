'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';

type TokenMeta = { id: string; symbol: string; decimals: string | number };
type RangeInfo = { tickLower: number | null; tickUpper: number | null; currentTick: number | null; status: 'IN'|'OUT'|'-' };
type Item = {
  kind: 'SLIPSTREAM';
  owner: string;
  tokenId: string;
  poolId: string;
  token0: TokenMeta;
  token1: TokenMeta;
  deposited: { token0: string; token1: string } | null;
  current: { token0: string; token1: string } | null;
  fees: { token0: string; token1: string };
  // subgraph route used `emissions: null | string`, Sugar route uses `{ token:'AERO', amount:string }`
  emissions: null | string | { token: string; amount: string };
  range: RangeInfo;
  staked: boolean;
};
type ApiResp = { items: Item[]; notes: string[] };

const DEFAULT_ADDR = '0xf159081d7be28aa9481af8f853e0f6d15473eee6'; // you can replace or leave blank ""

function fmt(n: string | number | null | undefined) {
  if (n === null || n === undefined) return '0';
  const s = typeof n === 'number' ? String(n) : n;
  return s;
}

export default function Page() {
  const [addr, setAddr] = React.useState<string>(DEFAULT_ADDR);
  const [tokenId, setTokenId] = React.useState<string>(''); // optional force-include

  const { data, isFetching, refetch, error } = useQuery<ApiResp>({
    queryKey: ['positions', addr, tokenId],
    enabled: !!addr,
    queryFn: async () => {
      const qs = new URLSearchParams();
      qs.append('addresses[]', addr);
      if (tokenId.trim()) {
        qs.append('tokenIds[]', tokenId.trim());
        // if you use the "assume" last-resort mapping:
        qs.append('assume', '1');
      }
      const res = await fetch(`/api/positions?${qs.toString()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as ApiResp;
    },
  });

  const items = data?.items ?? [];
  const notes = data?.notes ?? [];

  return (
    <main style={{ maxWidth: 1100, margin: '2rem auto', padding: '0 1rem' }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>Aero Positions Monitor</h1>
      <p style={{ color: '#555', marginBottom: 16 }}>
        View Slipstream positions (wallet + staked). Fees/emissions populated when available.
      </p>

      <form
        onSubmit={(e) => { e.preventDefault(); refetch(); }}
        style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}
      >
        <input
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          placeholder="0xYourWallet"
          style={{ flex: '1 1 420px', padding: '8px 10px', border: '1px solid #ddd', borderRadius: 8 }}
        />
        <input
          value={tokenId}
          onChange={(e) => setTokenId(e.target.value)}
          placeholder="(optional) tokenId e.g. 22115149"
          style={{ flex: '1 1 240px', padding: '8px 10px', border: '1px solid #ddd', borderRadius: 8 }}
        />
        <button
          type="submit"
          disabled={!addr || isFetching}
          style={{
            padding: '9px 14px',
            borderRadius: 8,
            border: '1px solid #111',
            background: isFetching ? '#999' : '#111',
            color: '#fff',
            cursor: isFetching ? 'default' : 'pointer'
          }}
        >
          {isFetching ? 'Loading…' : 'Fetch'}
        </button>
      </form>

      {error && (
        <div style={{ background: '#ffecec', color: '#a40000', padding: 12, borderRadius: 8, marginBottom: 12 }}>
          {(error as Error).message}
        </div>
      )}

      {!!notes.length && (
        <details style={{ marginBottom: 12 }}>
          <summary style={{ cursor: 'pointer' }}>Notes ({notes.length})</summary>
          <ul style={{ marginTop: 8 }}>
            {notes.map((n, i) => (<li key={i} style={{ color: '#555' }}>{n}</li>))}
          </ul>
        </details>
      )}

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left' }}>
              <th style={th}>TokenId</th>
              <th style={th}>Pool</th>
              <th style={th}>Owner</th>
              <th style={th}>Status</th>
              <th style={th}>Current (t0/t1)</th>
              <th style={th}>Fees (t0/t1)</th>
              <th style={th}>Emissions</th>
              <th style={th}>Staked</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const em =
                it.emissions == null
                  ? '-'
                  : typeof it.emissions === 'string'
                  ? it.emissions
                  : `${it.emissions.token} ${it.emissions.amount}`;
              return (
                <tr key={`${it.poolId}-${it.tokenId}`} style={{ borderTop: '1px solid #eee' }}>
                  <td style={tdMono}>{it.tokenId}</td>
                  <td style={td}>
                    <div style={{ fontWeight: 600 }}>{it.token0.symbol}/{it.token1.symbol}</div>
                    <div style={{ fontSize: 12, color: '#777' }}>{it.poolId}</div>
                  </td>
                  <td style={tdMono}>{it.owner}</td>
                  <td style={td}>{it.range?.status ?? '-'}</td>
                  <td style={td}>
                    {it.current
                      ? `${fmt(it.current.token0)} / ${fmt(it.current.token1)}`
                      : '—'}
                  </td>
                  <td style={td}>
                    {it.fees
                      ? `${fmt(it.fees.token0)} / ${fmt(it.fees.token1)}`
                      : '—'}
                  </td>
                  <td style={td}>{em}</td>
                  <td style={td}>{it.staked ? '✅' : '—'}</td>
                </tr>
              );
            })}
            {items.length === 0 && (
              <tr>
                <td colSpan={8} style={{ padding: '14px 8px', color: '#777' }}>
                  No positions yet. Enter a wallet and click Fetch.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}

const th: React.CSSProperties = { padding: '10px 8px', borderBottom: '1px solid #ddd', fontSize: 13, color: '#444' };
const td: React.CSSProperties = { padding: '10px 8px', verticalAlign: 'top', fontSize: 13 };
const tdMono: React.CSSProperties = { ...td, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 };
