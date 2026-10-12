import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { isAdminServer } from "@/lib/auth/server";
import { loadDashboardData } from "@/lib/dashboard-data";

export const metadata: Metadata = { title: "Dashboard" };

// Per-request data behind authentication: never statically rendered or cached.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  if (!(await isAdminServer())) redirect("/login");
  const data = await loadDashboardData();
  return <DashboardShell data={data} />;
}
