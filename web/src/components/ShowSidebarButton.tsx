import { createContext, useContext } from "react";
import { PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { HeadingProgress } from "@/components/SessionSidebar";

/**
 * How much of everything running has finished -- the Sessions tab's fraction. Provided once by the
 * app so every view's "Show sidebar" button can carry it without each one threading a prop through.
 */
export const SessionsProgressContext = createContext<{ done: number; active: number }>({ done: 0, active: 0 });

/**
 * The desktop button that brings a collapsed sidebar back. With the sidebar hidden, the Sessions
 * tab's "2/3" is hidden with it, and that is the one thing worth knowing without opening it -- so
 * the button carries the fraction itself.
 */
export function ShowSidebarButton({ onClick, className }: { onClick: () => void; className?: string }) {
  const { done, active } = useContext(SessionsProgressContext);
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("hidden md:inline-flex", active > 0 && "w-auto gap-1 px-2", className)}
      title="Show sidebar"
      onClick={onClick}
    >
      <PanelLeftOpen />
      <HeadingProgress done={done} active={active} />
    </Button>
  );
}
