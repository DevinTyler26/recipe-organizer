import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { WhitelistManager } from "@/components/whitelist-manager";

export default async function WhitelistPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isAdmin) {
    redirect("/");
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-amber-50 to-white px-4 py-10 text-slate-900">
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-8">
        <header className="rounded-3xl border border-white/60 bg-white/85 p-8 shadow-xl shadow-slate-200/70 backdrop-blur">
          <p className="text-xs font-semibold uppercase tracking-[0.35em] text-amber-500">
            Admin controls
          </p>
          <h1 className="mt-3 text-3xl font-semibold leading-tight text-slate-900">
            Manage sign-in whitelist
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Only emails on this list can sign in with Google. Changes take
            effect immediately for future logins.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link
              href="/"
              className="inline-flex items-center rounded-2xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 shadow-inner shadow-white/60 transition hover:border-slate-300"
            >
              Back to recipes
            </Link>
            <span className="inline-flex items-center rounded-2xl border border-slate-100 bg-white/80 px-4 py-2 text-xs font-semibold uppercase tracking-[0.35em] text-slate-500">
              Admin {session.user.email ?? session.user.name ?? "Account"}
            </span>
          </div>
        </header>
        <WhitelistManager />
      </main>
    </div>
  );
}
