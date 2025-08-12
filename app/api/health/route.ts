import { NextResponse } from "next/server";
export async function GET() {
  return NextResponse.json({
    hasSolidly: !!process.env.AERO_SOLIDLY_SUBGRAPH,
    hasSlipstream: !!process.env.AERO_SLIPSTREAM_SUBGRAPH,
    hasGauges: !!process.env.AERO_GAUGES_SUBGRAPH,
    hasKey: !!process.env.SUBGRAPH_API_KEY,
    rpc: process.env.BASE_RPC_URL?.slice(0, 30) + "..."
  });
}
