"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";

type AllowedEmailEntry = {
  id: string;
  email: string;
  createdAt: string;
};

const formatTimestamp = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
};

export function WhitelistManager() {
  const [entries, setEntries] = useState<AllowedEmailEntry[]>([]);
  const [formEmail, setFormEmail] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const fetchEntries = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/allowed-emails", {
        cache: "no-store",
      });
      const body = (await response.json().catch(() => null)) as {
        allowedEmails?: AllowedEmailEntry[];
        error?: string;
      } | null;
      if (!response.ok || !body || !Array.isArray(body.allowedEmails)) {
        throw new Error(body?.error ?? "Failed to load whitelist");
      }
      setEntries(body.allowedEmails);
    } catch (err) {
      console.error("Failed to load whitelist", err);
      setError(
        err instanceof Error ? err.message : "Unable to load whitelist entries"
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchEntries();
  }, [fetchEntries]);

  const sortedEntries = useMemo(() => {
    return [...entries].sort((a, b) => a.email.localeCompare(b.email));
  }, [entries]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setError(null);
      setMessage(null);
      const normalizedEmail = formEmail.trim().toLowerCase();
      if (!normalizedEmail) {
        setError("Enter an email before adding it to the whitelist.");
        return;
      }
      setIsSaving(true);
      try {
        const response = await fetch("/api/allowed-emails", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: normalizedEmail }),
        });
        const body = (await response.json().catch(() => null)) as {
          allowedEmail?: AllowedEmailEntry;
          error?: string;
        } | null;
        if (!response.ok || !body?.allowedEmail) {
          throw new Error(body?.error ?? "Unable to add email");
        }
        const createdEntry = body.allowedEmail;
        setEntries((current) => [...current, createdEntry]);
        setFormEmail("");
        setMessage(`${normalizedEmail} added to whitelist.`);
      } catch (err) {
        console.error("Failed to add whitelist email", err);
        setError(
          err instanceof Error ? err.message : "Unable to add whitelist email"
        );
      } finally {
        setIsSaving(false);
      }
    },
    [formEmail]
  );

  const handleDelete = useCallback(async (entry: AllowedEmailEntry) => {
    setError(null);
    setMessage(null);
    setDeletingId(entry.id);
    try {
      const response = await fetch(`/api/allowed-emails/${entry.id}`, {
        method: "DELETE",
      });
      if (!response.ok && response.status !== 204) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? "Unable to delete whitelist entry");
      }
      setEntries((current) => current.filter((item) => item.id !== entry.id));
      setMessage(`${entry.email} removed from whitelist.`);
    } catch (err) {
      console.error("Failed to delete whitelist email", err);
      setError(
        err instanceof Error ? err.message : "Unable to delete whitelist email"
      );
    } finally {
      setDeletingId(null);
    }
  }, []);

  return (
    <div className="space-y-6">
      <form
        onSubmit={handleSubmit}
        className="rounded-3xl border border-slate-100 bg-white/90 p-6 shadow-lg shadow-amber-100/50"
      >
        <p className="text-xs font-semibold uppercase tracking-[0.35em] text-amber-500">
          Add email
        </p>
        <div className="mt-4 flex flex-col gap-4 sm:flex-row">
          <input
            type="email"
            value={formEmail}
            onChange={(event) => setFormEmail(event.target.value)}
            placeholder="teammate@example.com"
            className="flex-1 rounded-2xl border border-slate-200 bg-white/80 px-4 py-3 text-base text-slate-900 shadow-inner shadow-white/50 outline-none transition focus:border-amber-400 focus:ring-4 focus:ring-amber-100"
          />
          <button
            type="submit"
            disabled={isSaving}
            className="rounded-2xl bg-slate-900 px-6 py-3 text-sm font-semibold uppercase tracking-[0.3em] text-white shadow-lg shadow-slate-900/20 transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isSaving ? "Adding…" : "Add"}
          </button>
        </div>
      </form>

      {(error || message) && (
        <div
          className={`rounded-2xl border px-4 py-3 text-sm ${
            error
              ? "border-rose-200 bg-rose-50 text-rose-700"
              : "border-emerald-200 bg-emerald-50 text-emerald-700"
          }`}
        >
          {error ?? message}
        </div>
      )}

      <section className="rounded-3xl border border-slate-100 bg-white/80 p-6 shadow-lg shadow-slate-200/60">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-100 pb-4 text-slate-600">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.35em] text-slate-400">
              Whitelisted Google logins
            </p>
            <h2 className="text-2xl font-semibold text-slate-900">
              {sortedEntries.length} allowed email
              {sortedEntries.length === 1 ? "" : "s"}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => {
              void fetchEntries();
            }}
            disabled={isLoading}
            className="rounded-2xl border border-slate-200 px-3 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-slate-600 transition hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        <div className="mt-4 space-y-3">
          {isLoading && sortedEntries.length === 0 ? (
            <p className="text-sm text-slate-500">Loading whitelist…</p>
          ) : sortedEntries.length === 0 ? (
            <p className="text-sm text-slate-500">
              No emails are currently allowed. Add one above to unblock
              sign-ins.
            </p>
          ) : (
            sortedEntries.map((entry) => (
              <div
                key={entry.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-100 bg-white/70 px-4 py-3 text-sm text-slate-700 shadow-inner shadow-white/40"
              >
                <div>
                  <p className="text-base font-semibold text-slate-900">
                    {entry.email}
                  </p>
                  <p className="text-xs text-slate-400">
                    Added {formatTimestamp(entry.createdAt)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    void handleDelete(entry);
                  }}
                  disabled={deletingId === entry.id}
                  className="rounded-2xl border border-rose-200 px-4 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-rose-600 transition hover:border-rose-300 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {deletingId === entry.id ? "Removing…" : "Remove"}
                </button>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
