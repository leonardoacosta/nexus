import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { NavBar } from "~/components/NavBar";

export const metadata: Metadata = {
  title: "Nexus Web",
  description: "Attach to Nexus agent terminal sessions from the browser",
};

/**
 * Without an explicit viewport meta, mobile browsers lay the page out at a
 * 980px virtual desktop width and then shrink — making the terminal chrome and
 * session list render at a desktop scale on a phone. `width=device-width` makes
 * the layout honest at the real phone width. We intentionally allow the browser
 * to set `initial-scale=1` but do NOT lock `maximum-scale`/`user-scalable`: the
 * attach view ships its OWN pinch-zoom/pan over the terminal transform layer,
 * and the rest of the UI (list, header) should stay accessibly zoomable.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: "#0b0e14",
          color: "#c5c8c6",
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        }}
      >
        <NavBar />
        {children}
      </body>
    </html>
  );
}
