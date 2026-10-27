import type { Metadata } from "next";
import { ChangePasswordForm } from "@/components/AuthForms";

export const metadata: Metadata = { title: "Change password · llama-paddock" };

export default function Page() {
  return <ChangePasswordForm />;
}
