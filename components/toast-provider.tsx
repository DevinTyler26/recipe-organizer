"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
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

type ToastState = {
  active: ToastMessage | null;
  queue: ToastMessage[];
};

type ToastAction =
  | { type: "ENQUEUE"; toast: ToastMessage }
  | { type: "ADVANCE" };

const toastReducer = (state: ToastState, action: ToastAction): ToastState => {
  switch (action.type) {
    case "ENQUEUE": {
      if (!state.active) {
        return { active: action.toast, queue: state.queue };
      }
      return { active: state.active, queue: [...state.queue, action.toast] };
    }
    case "ADVANCE": {
      if (state.queue.length === 0) {
        return { active: null, queue: [] };
      }
      const [next, ...rest] = state.queue;
      return { active: next, queue: rest };
    }
    default:
      return state;
  }
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [{ active }, dispatch] = useReducer(toastReducer, {
    active: null,
    queue: [],
  });

  const showToast = useCallback(
    (message: string, tone: ToastTone = "success") => {
      const id = Date.now() + Math.random();
      dispatch({ type: "ENQUEUE", toast: { id, message, tone } });
    },
    []
  );

  useEffect(() => {
    if (!active) {
      return;
    }
    const timeoutId = window.setTimeout(
      () => dispatch({ type: "ADVANCE" }),
      3600
    );
    return () => window.clearTimeout(timeoutId);
  }, [active]);

  const dismissActiveToast = useCallback(() => {
    dispatch({ type: "ADVANCE" });
  }, []);

  const value = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-4 z-[1200] flex justify-center px-4 sm:top-6 sm:justify-end">
        {active && (
          <div
            className={`pointer-events-auto flex max-w-sm items-center gap-3 rounded-2xl border px-4 py-3 text-sm font-semibold shadow-xl transition ${
              toneStyles[active.tone]
            }`}
          >
            <span className="flex-1 leading-snug">{active.message}</span>
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
