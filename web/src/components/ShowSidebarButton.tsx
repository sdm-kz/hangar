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

/**
 * The same count and list on a phone, worn beside each view's menu button. The drawer that carries
 * the Sessions tab covers the view it opens over, so this is the one place a phone can check on the
 * other sessions while still looking at this one.
 */
export function MobileSessionsProgress() {
  return (
    <div className="relative flex shrink-0 items-center md:hidden">
      <SessionsProgressMenu triggerClassName="-ml-1 h-9 px-1.5" />
    </div>
  );
}
