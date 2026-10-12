import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Radar } from "lucide-react";
import { isAdminServer } from "@/lib/auth/server";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await isAdminServer()) redirect("/dashboard");
  return (
    <main className="grid flex-1 place-items-center px-5 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-lg border border-line-strong bg-surface-2 text-cyan">
            <Radar className="size-4.5" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-lg font-semibold leading-tight">Industry Event Scout</h1>
            <p className="text-sm text-muted">Dashboard sign-in</p>
          </div>
        </div>
        <LoginForm />
        <p className="mt-4 text-xs leading-relaxed text-faint">
          Single-user dashboard. The password is the <code className="font-mono">ADMIN_PASSWORD</code> environment variable.
        </p>
      </div>
    </main>
  );
}
