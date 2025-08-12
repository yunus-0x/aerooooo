import { createPublicClient, http } from "viem";

export function makePublicClient(rpcUrl: string) {
  return createPublicClient({
    chain: {
      id: 8453,
      name: "Base",
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    },
    transport: http(rpcUrl),
  });
}
