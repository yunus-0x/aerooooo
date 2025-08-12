'use client';

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

type Token = { id: string; symbol: string; decimals: number };
type PositionItem = {
  kind: "SLIPSTREAM" | "SOLIDLY";
  owner: string;
  staked: boolean;
  tokenId?: string; // slipstream
  lpToken?: string; // solidly
  token0: Token;
  token1: Token;
  deposited: any | null;
  current: any | null;
  fees: any | null;
  emissions: any | null;
  range: null | { tickLower: number; tickUpper: number; currentTick: number; status: "IN" | "OUT" };
};

function usePositions(addresses: string[]) {
  return useQuery({
    queryKey: ["positions", addresses],
    enabled: addresses.length > 0,
    queryFn: async () => {
      const params = new URLSearchParams();
      addresses.forEach(a => params.append("addresses[]", a.toLowerCase()));
      const r = await fetch(`/api/positions?${params.toString()}`, { cache: "no-store" });
      if (!r.ok) throw new Error("positions failed");
      return (await r.json()) as { items: PositionItem[]; notes?: string[] };
    },
  });
}

export default function Page() {
  const [input, setInput] = useState("");
  const addresses = useMemo(
    () => input.split(/[\s,]+/).map(s => s.trim()).filter(Boolean),
    [input]
  );

  const { data, isFetching, error } = usePositions(addresses);
  const items = data?.items ?? [];
  const notes = data?.notes ?? [];

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Aerodrome Positions Monitor (Base)</h1>
        <p className="text-neutral-400">
          Paste wallet addresses (comma/space separated). Shows staked + unstaked, fees, emissions, and in-range status.
        </p>
        <div className="flex items-center gap-2">
          <input
            placeholder="0xabc..., 0xdef..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="flex-1 rounded-xl bg-neutral-900 border border-neutral-800 px-4 py-2 outline-none"
          />
          {isFetching ? <span className="text-sm text-neutral-400">Loading…</span> : null}
        </div>
        {error ? <div className="text-red-400 text-sm">Failed to load positions.</div> : null}
        {notes.length > 0 && (
          <ul className="text-xs text-neutral-500 list-disc pl-5">
            {notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        )}
      </header>

      <section className="rounded-2xl border border-neutral-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-neutral-900">
            <tr className="[&>th]:px-3 [&>th]:py-2 text-left">
              <th>Owner</th>
              <th>Type</th>
              <th>Asset</th>
              <th>Staked</th>
              <th>Deposited</th>
              <th>Current</th>
              <th>Fees</th>
              <th>Emissions</th>
              <th>Range</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i} className="border-t border-neutral-800 [&>td]:px-3 [&>td]:py-2">
                <td className="font-mono text-xs">{short(it.owner)}</td>
                <td>{it.kind === "SLIPSTREAM" ? `Slip#${it.tokenId}` : "Classic LP"}</td>
                <td>{it.token0?.symbol}/{it.token1?.symbol}</td>
                <td>{it.staked ? "Yes" : "No"}</td>
                <td>{fmtPair(it.deposited, it.token0?.symbol, it.token1?.symbol)}</td>
                <td>{fmtPair(it.current, it.token0?.symbol, it.token1?.symbol)}</td>
                <td>{fmtPair(it.fees, it.token0?.symbol, it.token1?.symbol)}</td>
                <td>{fmtEmissions(it.emissions)}</td>
                <td>{it.range ? `${it.range.status} (tick ${it.range.currentTick})` : "-"}</td>
              </tr>
            ))}
            {items.length === 0 && !isFetching && (
              <tr><td colSpan={9} className="text-center text-neutral-500 py-10">No data yet.</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}

function short(a?: string) { return a ? `${a.slice(0,6)}…${a.slice(-4)}` : ""; }
function n(x?: string | number | null) {
  if (x == null) return "-";
  const v = typeof x === "string" ? Number(x) : x;
  if (!Number.isFinite(v)) return "-";
  return Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(v);
}
function fmtPair(p: any, s0?: string, s1?: string) {
  if (!p) return "-";
  const a = "token0" in p ? p.token0 : p[0] ?? null;
  const b = "token1" in p ? p.token1 : p[1] ?? null;
  return `${n(a)} ${s0 ?? ""} / ${n(b)} ${s1 ?? ""}`;
}
function fmtEmissions(e: any) {
  if (!e) return "-";
  return Object.entries(e).map(([k,v]) => `${n(v as any)} ${k}`).join(", ");
}
