import {
  AlertTriangle,
  Beaker,
  Bookmark,
  Boxes,
  Bug,
  CircleCheck,
  Clock,
  Cloud,
  Database,
  FileText,
  Flag,
  FolderOpen,
  GitBranch,
  Hammer,
  Heart,
  Layers,
  Lightbulb,
  Package,
  Rocket,
  Shield,
  Sparkles,
  Star,
  Target,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";

/**
 * The icons a virtual folder can wear. A small hand-picked set rather than the whole of lucide: the
 * picker is a grid in a dialog, and a thousand icons is a search problem, not a choice. They are
 * meant to say *what kind of work* is in the box — a bug, an experiment, a release — which is the
 * thing a name alone takes a second longer to tell you across a sidebar.
 *
 * The name is what's stored (server-side, on the group), so this list can grow without a migration.
 * A name that isn't here — an older client's pick, a hand-edited projects.json — draws the default,
 * exactly as an unknown colour name resolves to no accent.
 */
export const GROUP_ICONS: { name: string; Icon: LucideIcon }[] = [
  { name: "folder", Icon: FolderOpen },
  { name: "boxes", Icon: Boxes },
  { name: "star", Icon: Star },
  { name: "flag", Icon: Flag },
  { name: "bookmark", Icon: Bookmark },
  { name: "target", Icon: Target },
  { name: "bug", Icon: Bug },
  { name: "wrench", Icon: Wrench },
  { name: "hammer", Icon: Hammer },
  { name: "beaker", Icon: Beaker },
  { name: "rocket", Icon: Rocket },
  { name: "zap", Icon: Zap },
  { name: "sparkles", Icon: Sparkles },
  { name: "lightbulb", Icon: Lightbulb },
  { name: "check", Icon: CircleCheck },
  { name: "alert", Icon: AlertTriangle },
  { name: "clock", Icon: Clock },
  { name: "branch", Icon: GitBranch },
  { name: "package", Icon: Package },
  { name: "layers", Icon: Layers },
  { name: "database", Icon: Database },
  { name: "cloud", Icon: Cloud },
  { name: "shield", Icon: Shield },
  { name: "file", Icon: FileText },
  { name: "heart", Icon: Heart },
];

/** What a group with no icon (or an icon this build doesn't know) is drawn with. */
export const DEFAULT_GROUP_ICON = FolderOpen;

/** Resolve a stored icon name to its component, falling back to the default. */
export function groupIcon(name?: string | null): LucideIcon {
  if (!name) return DEFAULT_GROUP_ICON;
  return GROUP_ICONS.find((i) => i.name === name)?.Icon ?? DEFAULT_GROUP_ICON;
}
