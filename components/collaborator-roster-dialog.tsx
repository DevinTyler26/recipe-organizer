"use client";

import { formatCollaboratorLabel } from "@/lib/collaborator-label";
import type { CollaboratorSummary } from "@/types/collaboration";

type CollaboratorRosterDialogProps = {
  open: boolean;
  title: string;
  collaborators: CollaboratorSummary[];
  onClose: () => void;
};

export function CollaboratorRosterDialog({
  open,
  title,
  collaborators,
  onClose,
}: CollaboratorRosterDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4 py-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="collaboration-roster-title"
        className="w-full max-w-md rounded-3xl border border-white/80 bg-white/95 p-6 shadow-2xl shadow-slate-900/25 backdrop-blur"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.35em] text-rose-400">
              Collaborators
            </p>
            <h2
              id="collaboration-roster-title"
              className="mt-1 text-xl font-semibold text-slate-900"
            >
              {title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-slate-600 transition hover:border-slate-300"
          >
            Close
          </button>
        </div>
        {collaborators.length === 0 ? (
          <p className="mt-6 rounded-2xl border border-dashed border-rose-200 bg-rose-50/70 px-4 py-3 text-sm text-rose-600">
            Only you can manage this resource right now.
          </p>
        ) : (
          <ul className="mt-6 space-y-3">
            {collaborators.map((collaborator) => (
              <li
                key={collaborator.id}
                className="flex items-center justify-between rounded-2xl border border-slate-100 bg-white/90 px-4 py-3 text-sm text-slate-700 shadow-inner shadow-white/70"
              >
                <div>
                  <p className="font-semibold text-slate-900">
                    {formatCollaboratorLabel(collaborator)}
                  </p>
                  {collaborator.email && (
                    <p className="text-xs text-slate-500">
                      {collaborator.email}
                    </p>
                  )}
                </div>
                <span className="rounded-full bg-rose-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.3em] text-rose-500">
                  Editor
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
