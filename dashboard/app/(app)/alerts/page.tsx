import { AlertsView } from "@/components/AlertsView";

export default async function Page({ searchParams }: PageProps<"/alerts">) {
  const { host } = await searchParams;
  return <AlertsView host={typeof host === "string" ? host : undefined} />;
}
