import type { Metadata } from "next";
import "@fontsource/lora/400.css";
import "@fontsource/lora/500.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "./globals.css";
import { ConvexClientProvider } from "./convex-client-provider";

export const metadata: Metadata = {
  title: "NovaMind · Agentic search",
  description: "Compare agentic search across model SDKs.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body><ConvexClientProvider>{children}</ConvexClientProvider></body>
    </html>
  );
}
