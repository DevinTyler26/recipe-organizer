import { getAppVersionInfo } from "@/lib/app-version";

export function SiteFooter() {
  const { version, channel, channelLabel } = getAppVersionInfo();
  const isStable = channel === "stable";
  return (
    <footer className="border-t border-white/20 bg-slate-950/90 px-4 py-4 text-xs text-slate-200">
      <div className="mx-auto flex w-full max-w-5xl flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
        <span className="font-mono tracking-wide text-slate-100">
          Recipe Organizer v{version}
        </span>
        <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.3em] text-slate-400">
          {!isStable && (
            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-amber-300">
              {channelLabel}
            </span>
          )}
          <span>Semantic release enabled</span>
        </span>
      </div>
    </footer>
  );
}
