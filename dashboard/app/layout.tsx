import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "llama-paddock",
  description: "Monitor and manage Ollama instances",
  // favicon: app/icon.svg (Next.js file convention)
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
