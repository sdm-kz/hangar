import { type MouseEvent, useCallback, useState } from "react";
import { Check, Copy } from "lucide-react";
import { writeToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

// A hover action that copies a file/folder path to the clipboard, briefly swapping to a check mark
// for feedback. Shared by the session Files tree (FileBrowser) and the whole-server tree
// (FilesSidebar), which copy relative and absolute paths respectively.
export function CopyPathButton({
  path,
  className,
  iconClassName = "size-3.5",
  title = "Copy path",
}: {
  path: string;
  className?: string;
  iconClassName?: string;
  title?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(
    async (e: MouseEvent) => {
      e.stopPropagation();
      await writeToClipboard(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    },
    [path]
  );
  return (
    <button className={className} title={copied ? "Copied!" : title} onClick={copy}>
      {copied ? <Check className={cn(iconClassName, "text-emerald-500")} /> : <Copy className={iconClassName} />}
    </button>
  );
}
