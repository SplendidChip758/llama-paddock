import { redirect } from "next/navigation";

export default async function Page({ params }: PageProps<"/i/[id]">) {
  const { id } = await params;
  redirect(`/i/${encodeURIComponent(id)}/monitor`);
}
