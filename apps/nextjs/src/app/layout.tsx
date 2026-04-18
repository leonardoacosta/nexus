import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Sidebar } from "@/components/Sidebar";
import { CommandPaletteProvider } from "@/components/CommandPaletteProvider";
import PostHogProvider from "@/components/posthog-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nexus Dashboard",
  description: "Nexus session management dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <PostHogProvider>
          <div className="app-shell">
            <Sidebar />
            <main className="main-content">{children}</main>
          </div>
          <CommandPaletteProvider />
        </PostHogProvider>
      </body>
    </html>
  );
}
