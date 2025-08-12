import "./globals.css";
import Providers from "./providers";

export const metadata = {
  title: "Aerodrome Positions Monitor (Base)",
  description: "Staked + unstaked LPs, fees, emissions, in-range, CoinGecko pricing",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
