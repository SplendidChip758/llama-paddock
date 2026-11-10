import type { Metadata } from "next";
import { BackupView } from "@/components/BackupView";

export const metadata: Metadata = { title: "Backup · llama-paddock" };

export default function Page() {
  return <BackupView />;
}
