import { useSyncExternalStore } from "react";
import { getTheme, getThemeVersion, subscribeThemeChanges, toggleTheme } from "@/lib/theme";
import { Button } from "@/components/ui/button";
import { Moon, Sun } from "lucide-react";

/** The sidebar footer's quick light/dark switch. The themes themselves are in Settings → Appearance. */
export function ThemeToggle() {
  // Follows the theme rather than its own clicks: Settings, and the system in "system" mode, change it too.
  useSyncExternalStore(subscribeThemeChanges, getThemeVersion);
  const theme = getTheme();

  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8 text-muted-foreground"
      title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      onClick={toggleTheme}
    >
      {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}
