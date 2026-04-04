import type { Metadata } from "next";

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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
