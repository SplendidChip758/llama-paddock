import { PaddockProvider } from "@/components/PaddockProvider";
import { Header } from "@/components/Header";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <PaddockProvider>
      <Header />
      <main>{children}</main>
    </PaddockProvider>
  );
}
