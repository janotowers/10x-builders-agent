"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * Remounts children when the page is restored from the browser back/forward
 * cache. Without this, React client state can desync and stop handling clicks.
 */
export function BfcacheRecoveryBoundary({ children }: { children: ReactNode }) {
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setEpoch((value) => value + 1);
      }
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  return <div key={epoch}>{children}</div>;
}
