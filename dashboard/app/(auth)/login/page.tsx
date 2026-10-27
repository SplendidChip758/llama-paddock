import type { Metadata } from "next";
import { LoginForm } from "@/components/AuthForms";

export const metadata: Metadata = { title: "Sign in · llama-paddock" };

export default async function Page({ searchParams }: PageProps<"/login">) {
  const { next } = await searchParams;
  // only same-site paths, never "//host" or absolute URLs
  const target = typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return <LoginForm next={target} />;
}
