import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "llmovoice.js — Context orchestration for realtime agents",
  description: "A live laboratory for VoicePages, VoiceThreads, context projection, and realtime control.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

