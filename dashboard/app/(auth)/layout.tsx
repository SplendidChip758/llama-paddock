import { Logo } from "@/components/Logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="authwrap">
      <div className="authcard">
        <div className="authlogo">
          <Logo />
        </div>
        {children}
      </div>
    </main>
  );
}
