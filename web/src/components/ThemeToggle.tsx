import { useState } from "react";
import { getTheme, toggleTheme, type Theme } from "@/lib/theme";
import { Button } from "@/components/ui/button";
import { Moon, Sun } from "lucide-react";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getTheme());

  return (
    <Button
      variant="ghost"
      size="icon"
      className="text-muted-foreground"
      title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => setTheme(toggleTheme())}
    >
      {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}
