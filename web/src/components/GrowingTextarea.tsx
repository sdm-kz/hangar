import { useLayoutEffect, useRef, type ComponentProps } from "react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * A text box that is as tall as what is in it: three rows at least, and up to two fifths of the window,
 * past which it scrolls. A prompt pasted in shows whole rather than through a slot, and an empty box
 * doesn't hold a third of the dialog. No resize grip, since the box sizes itself.
 */
export function GrowingTextarea({
  value,
  className,
  ...props
}: Omit<ComponentProps<typeof Textarea>, "rows" | "ref"> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto"; // back to its three rows, so a shorter text shrinks it again
    // scrollHeight leaves out the border, which a border-box height includes (see PostponedPool).
    const full = el.scrollHeight + el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(full, Math.round(window.innerHeight * 0.4))}px`;
  }, [value]);
  return <Textarea ref={ref} rows={3} value={value} className={cn("min-h-0 resize-none", className)} {...props} />;
}
