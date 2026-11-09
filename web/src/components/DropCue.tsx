import { Paperclip } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Shown over a message box while files are held over it (see useFileDrop): it takes them. Lets the drag
 * events through to the box under it, which is what counts them in and out.
 */
export function DropCue({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 z-30 flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-background/85 text-sm font-medium",
        className
      )}
    >
      <Paperclip className="size-4" /> Drop to attach
    </div>
  );
}
