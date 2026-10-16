import { PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SessionsProgressMenu } from "@/components/SessionsProgressMenu";

/**
 * The desktop button that brings a collapsed sidebar back. With the sidebar hidden, the Sessions
 * tab's "2/3" is hidden with it, and that is the one thing worth knowing without opening it -- so
 * the button carries the fraction itself, with the same dropdown the tab's has.
 */
export function ShowSidebarButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <div className={cn("relative hidden shrink-0 items-center md:flex", className)}>
      <Button variant="ghost" size="icon" title="Show sidebar" onClick={onClick}>
        <PanelLeftOpen />
      </Button>
      <SessionsProgressMenu triggerClassName="-ml-1 h-9 px-1.5" />
    </div>
  );
}
