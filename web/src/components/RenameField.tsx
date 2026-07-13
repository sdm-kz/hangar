import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Inline text input for renaming a session. Autofocuses and selects, commits on Enter/blur, cancels
 * on Escape. Stops click/keydown propagation so it works inside a clickable session row.
 */
export function RenameField({
  value,
  onSubmit,
  onCancel,
  className,
}: {
  value: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== value) onSubmit(next);
    else onCancel();
  };

  return (
    <input
      ref={ref}
      value={draft}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={commit}
      className={cn(
        "min-w-0 flex-1 rounded border bg-background px-1 py-0.5 text-sm outline-none focus:ring-1 focus:ring-primary",
        className
      )}
    />
  );
}
