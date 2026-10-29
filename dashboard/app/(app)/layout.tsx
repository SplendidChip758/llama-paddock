import { PaddockProvider } from "@/components/PaddockProvider";
import { Header } from "@/components/Header";
import { version } from "@/package.json";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <PaddockProvider>
      <Header version={version} />
      <main>{children}</main>
    </PaddockProvider>
  );
}
