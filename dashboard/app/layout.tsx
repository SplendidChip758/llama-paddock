import type { Metadata } from "next";
import "./globals.css";
import { THEME_SCRIPT } from "@/lib/theme";

export const metadata: Metadata = {
  title: "llama-paddock",
  description: "Monitor and manage Ollama instances",
  // icons: app/icon.svg, app/favicon.ico (16 px, the llama alone) and app/apple-icon.png (Next.js file conventions)
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // THEME_SCRIPT sets data-palette/data-theme before React hydrates, hence suppressHydrationWarning
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
