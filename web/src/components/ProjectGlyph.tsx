import type { Project } from "@/types";
import { projectIcon } from "@/lib/groupIcons";
import { sessionColor } from "@/lib/sessionColors";

/**
 * A project as a glyph: its icon, in its accent colour. One component for every place a project is
 * named — the sidebar heading, the move-to menus, the new-session and template dialogs — so a
 * project picked to wear a rocket wears it everywhere, not just where someone remembered to look.
 * No project (or one with no icon) draws the default.
 */
export function ProjectGlyph({
  project,
  className,
}: {
  project: Pick<Project, "color" | "icon"> | null | undefined;
  className?: string;
}) {
  const Icon = projectIcon(project?.icon);
  const accent = sessionColor(project?.color ?? null);
  return <Icon className={className} style={accent ? { color: accent } : undefined} aria-hidden />;
}
