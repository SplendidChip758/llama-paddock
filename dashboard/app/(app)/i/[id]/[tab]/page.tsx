import { notFound } from "next/navigation";
import { InstanceView } from "@/components/InstanceView";
import { isTab } from "@/lib/tabs";

export default async function Page({ params }: PageProps<"/i/[id]/[tab]">) {
  const { id, tab } = await params;
  if (!isTab(tab)) notFound();
  return <InstanceView id={decodeURIComponent(id)} tab={tab} />;
}
