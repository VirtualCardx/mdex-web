/**
 * 轻量提示条。`ToastProvider` 挂在应用外壳里，页面通过 `useToast()` 抛提示。
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type ToastTone = "info" | "success" | "error";

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

type ShowToast = (message: string, tone?: ToastTone) => void;

const ToastContext = createContext<ShowToast | null>(null);

export function useToast(): ShowToast {
  const show = useContext(ToastContext);
  if (!show) throw new Error("useToast 必须在 ToastProvider 内部使用");
  return show;
}

const TONE_CLASS: Record<ToastTone, string> = {
  info: "border-line bg-raised text-fg",
  success: "border-emerald-500/40 bg-emerald-500/15 text-fg",
  error: "border-red-500/40 bg-red-500/15 text-fg",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const show = useCallback<ShowToast>((message, tone = "info") => {
    const id = nextId.current++;
    setItems((prev) => [...prev, { id, message, tone }]);
    window.setTimeout(() => {
      setItems((prev) => prev.filter((item) => item.id !== id));
    }, 4000);
  }, []);

  const value = useMemo(() => show, [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-5 left-1/2 z-[60] flex w-full max-w-lg -translate-x-1/2 flex-col items-center gap-2 px-4">
        {items.map((item) => (
          <div
            key={item.id}
            role="status"
            className={`pointer-events-auto w-full rounded-lg border px-4 py-2.5 text-sm shadow-lg backdrop-blur ${TONE_CLASS[item.tone]}`}
          >
            {item.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
