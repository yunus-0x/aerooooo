import { NextRequest, NextResponse } from "next/server";

export const revalidate = 60;

export async function GET(req: NextRequest) {
  const ids = req.nextUrl.searchParams.get("ids");
  if (!ids) return NextResponse.json({ error: "ids required" }, { status: 400 });

  const key = process.env.COINGECKO_API_KEY || "";
  const url = new URL("https://api.coingecko.com/api/v3/simple/price");
  url.searchParams.set("ids", ids);
  url.searchParams.set("vs_currencies", "usd");

  const headers: Record<string, string> = {};
  if (key) headers["x-cg-pro-api-key"] = key;

  try {
    const r = await fetch(url, { headers, cache: "no-store" });
    if (!r.ok) {
      return NextResponse.json({ error: "coingecko error", status: r.status }, { status: 502 });
    }
    const data = await r.json();
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: "network error" }, { status: 500 });
  }
}
