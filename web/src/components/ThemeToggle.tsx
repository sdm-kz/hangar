import { useState, useSyncExternalStore } from "react";
import { getTheme, getThemeVersion, subscribeThemeChanges, toggleTheme } from "@/lib/theme";
import { Button } from "@/components/ui/button";
import { ThemeDialog } from "./ThemeDialog";
import { Moon, Palette, Sun } from "lucide-react";

/** The sidebar footer's theme controls: the Themes dialog, and the quick light/dark switch beside it. */
export function ThemeToggle() {
  // Follows the theme rather than its own clicks: the dialog, and the system in "system" mode, change it too.
  useSyncExternalStore(subscribeThemeChanges, getThemeVersion);
  const theme = getTheme();
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="size-8 text-muted-foreground"
        title="Themes"
        onClick={() => setDialogOpen(true)}
      >
        <Palette className="size-4" />
      </Button>
      {dialogOpen && <ThemeDialog onClose={() => setDialogOpen(false)} />}
      <Button
        variant="ghost"
        size="icon"
        className="size-8 text-muted-foreground"
        title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        onClick={toggleTheme}
      >
        {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </Button>
    </>
  );
}
