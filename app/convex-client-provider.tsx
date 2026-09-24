"use client";

import { ConvexProvider, ConvexReactClient } from "convex/react";
import { useState } from "react";

export function ConvexClientProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => {
    const url = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured.");
    return new ConvexReactClient(url);
  });

  return <ConvexProvider client={client}>{children}</ConvexProvider>;
}
