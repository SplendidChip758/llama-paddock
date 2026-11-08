import { PromptView } from "@/components/PromptView";

export default async function Page({ searchParams }: PageProps<"/prompt">) {
  const { host, model } = await searchParams;
  return <PromptView host={typeof host === "string" ? host : undefined} model={typeof model === "string" ? model : undefined} />;
}
