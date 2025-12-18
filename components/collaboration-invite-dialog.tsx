"use client";

import { useEffect, useRef, useState } from "react";

type CollaborationInviteDialogProps = {
  open: boolean;
  title: string;
  description?: string;
  resourceLabel: string;
  confirmLabel?: string;
  onClose: () => void;
  onSubmit: (email: string) => Promise<void>;
};

export function CollaborationInviteDialog({
  open,
  title,
  description,
  resourceLabel,
  confirmLabel = "Send invite",
  onClose,
  onSubmit,
}: CollaborationInviteDialogProps) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setEmail("");
      setError(null);
      const timeout = window.setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
      return () => window.clearTimeout(timeout);
    }
    return undefined;
  }, [open]);

  if (!open) {
    return null;
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email.trim()) {
      setError("Enter an email address");
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      await onSubmit(email.trim());
      setEmail("");
      onClose();
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Unable to send invite";
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4 py-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="collaboration-dialog-title"
        className="w-full max-w-md rounded-3xl border border-white/80 bg-white/95 p-6 shadow-2xl shadow-slate-900/20 backdrop-blur"
      >
        <div className="space-y-2">
          <h2
            id="collaboration-dialog-title"
            className="text-xl font-semibold text-slate-900"
          >
            {title}
          </h2>
          <p className="text-sm text-slate-500">
            {description ?? "Invite another account to collaborate."}
          </p>
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-rose-400">
            {resourceLabel}
          </p>
        </div>
        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <label className="block text-sm font-medium text-slate-700">
            Collaborator email
            <input
              ref={inputRef}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="mt-2 w-full rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 text-base text-slate-900 outline-none transition focus:border-rose-500 focus:ring-4 focus:ring-rose-100"
              placeholder="chef@example.com"
              required
            />
          </label>
          {error && (
            <p className="text-sm font-semibold text-rose-600">{error}</p>
          )}
          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-2xl border border-transparent px-4 py-2 text-sm font-semibold text-slate-500 transition hover:border-slate-200"
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-2xl bg-slate-900 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-slate-900/20 transition disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting ? "Sending…" : confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
