"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ToastTone = "success" | "info" | "error";

type ToastMessage = {
  id: number;
  message: string;
  tone: ToastTone;
};

type ToastContextValue = {
  showToast: (message: string, tone?: ToastTone) => void;
};

const toneStyles: Record<ToastTone, string> = {
  success:
    "border-emerald-100 bg-emerald-50 text-emerald-700 shadow-emerald-100/80",
  info: "border-slate-200 bg-white text-slate-700 shadow-slate-200/80",
  error: "border-rose-200 bg-rose-50 text-rose-700 shadow-rose-100/80",
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<ToastMessage[]>([]);
  const [activeToast, setActiveToast] = useState<ToastMessage | null>(null);

  const showToast = useCallback(
    (message: string, tone: ToastTone = "success") => {
      const id = Date.now() + Math.random();
      setQueue((current) => [...current, { id, message, tone }]);
    },
    []
  );

  useEffect(() => {
    if (activeToast || queue.length === 0) {
      return;
    }
    setActiveToast(queue[0]);
    setQueue((current) => current.slice(1));
  }, [activeToast, queue]);

  useEffect(() => {
    if (!activeToast) {
      return;
    }
    const timeoutId = window.setTimeout(() => setActiveToast(null), 3600);
    return () => window.clearTimeout(timeoutId);
  }, [activeToast]);

  const dismissActiveToast = useCallback(() => {
    setActiveToast(null);
  }, []);

  const value = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-4 z-[1200] flex justify-center px-4 sm:top-6 sm:justify-end">
        {activeToast && (
          <div
            className={`pointer-events-auto flex max-w-sm items-center gap-3 rounded-2xl border px-4 py-3 text-sm font-semibold shadow-xl transition ${
              toneStyles[activeToast.tone]
            }`}
          >
            <span className="flex-1 leading-snug">{activeToast.message}</span>
            <button
              type="button"
              onClick={dismissActiveToast}
              className="text-[10px] font-semibold uppercase tracking-[0.3em] text-slate-500 transition hover:text-slate-700"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}
