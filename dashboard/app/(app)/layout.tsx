import { PaddockProvider } from "@/components/PaddockProvider";
import { Header } from "@/components/Header";
import { StorageNotice } from "@/components/StorageNotice";
import { version } from "@/package.json";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <PaddockProvider>
      <Header version={version} />
      <main>
        <StorageNotice />
        {children}
      </main>
    </PaddockProvider>
  );
}
