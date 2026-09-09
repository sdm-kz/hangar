import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Inline text input for renaming a session or a file. Autofocuses and selects, commits on
 * Enter/blur, cancels on Escape. Stops click/keydown propagation so it works inside a clickable row.
 *
 * It takes up exactly the room the text it replaces did. A bordered, padded box would be the obvious
 * shape for an input, but this one appears *inside* a tree row in place of a label: a border and a
 * couple of pixels of vertical padding grow the row, which shoves every row below it down and
 * shifts the thing you were aiming at the moment you start typing. So the box is flat -- same font,
 * same line height, no border, no vertical padding -- and the ring does the work of saying "this is
 * a field now". A ring is a box-shadow, painted outside the layout box, so it costs no height at
 * all. The sliver of horizontal padding is given back with a matching negative margin, which keeps
 * the text on the same column it was reading from a moment ago.
 *
 * The type size is inherited rather than set, so the name keeps the size it had a keystroke ago in
 * each of the three trees this serves -- they are not all the same size, and the file trees used to
 * jump a step up on the way into the field.
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
        "-mx-0.5 min-w-0 flex-1 rounded-sm bg-background px-0.5 outline-none ring-1 ring-primary",
        className
      )}
    />
  );
}
