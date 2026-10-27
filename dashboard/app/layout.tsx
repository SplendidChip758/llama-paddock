import type { Metadata } from "next";
import { PaddockProvider } from "@/components/PaddockProvider";
import { Header } from "@/components/Header";
import "./globals.css";

export const metadata: Metadata = {
  title: "llama-paddock",
  description: "Monitor and manage Ollama instances",
  // favicon: app/icon.svg (Next.js file convention)
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <PaddockProvider>
          <Header />
          <main>{children}</main>
        </PaddockProvider>
      </body>
    </html>
  );
}
