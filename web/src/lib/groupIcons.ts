import {
  Activity,
  AlertTriangle,
  Anchor,
  Archive,
  Atom,
  Beaker,
  Bell,
  BookOpen,
  Bookmark,
  Bot,
  Boxes,
  Braces,
  Brain,
  Briefcase,
  Bug,
  Building2,
  Calendar,
  Camera,
  ChartBar,
  CircleCheck,
  CircleDollarSign,
  Clock,
  Cloud,
  Code,
  Coffee,
  Cog,
  Compass,
  Cpu,
  Crown,
  Database,
  FileText,
  Flag,
  Flame,
  FlaskConical,
  FolderOpen,
  Gamepad2,
  Gauge,
  Gem,
  Gift,
  GitBranch,
  Globe,
  GraduationCap,
  Hammer,
  Heart,
  House,
  Image as ImageIcon,
  Kanban,
  Key,
  Layers,
  Leaf,
  Lightbulb,
  ListTodo,
  Lock,
  Mail,
  Map as MapIcon,
  Megaphone,
  MessageSquare,
  Microscope,
  Monitor,
  Moon,
  Mountain,
  Music,
  Network,
  NotebookPen,
  Package,
  Palette,
  PawPrint,
  PenTool,
  Puzzle,
  Rocket,
  Server,
  Shield,
  ShoppingCart,
  Smartphone,
  Sparkles,
  Sprout,
  Star,
  Store,
  Sun,
  Tag,
  Target,
  Terminal,
  Trophy,
  Truck,
  User,
  Users,
  Wallet,
  Workflow,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";

/**
 * The icons a project or a virtual folder can wear. A hand-picked set rather than the whole of
 * lucide: the picker is a grid in a dialog, and a thousand icons is a search problem, not a choice.
 * They are meant to say *what kind of work* is in the box — a bug, an experiment, a release, a
 * client — which is the thing a name alone takes a second longer to tell you across a sidebar.
 * Listed by theme (work in progress, code and infrastructure, people and business, knowledge, the
 * rest), so the grid reads in runs of related glyphs rather than as a scatter.
 *
 * The name is what's stored (server-side, on the project or group), so this list can grow without a
 * migration — but a name must never be renamed or dropped, or what was picked with it quietly turns
 * back into the default. A name that isn't here — an older client's pick, a hand-edited projects.json
 * — draws the default, exactly as an unknown colour name resolves to no accent.
 */
export const GROUP_ICONS: { name: string; Icon: LucideIcon }[] = [
  // Work in progress
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
  { name: "calendar", Icon: Calendar },
  { name: "todo", Icon: ListTodo },
  { name: "kanban", Icon: Kanban },
  { name: "workflow", Icon: Workflow },
  // Code and infrastructure
  { name: "code", Icon: Code },
  { name: "braces", Icon: Braces },
  { name: "terminal", Icon: Terminal },
  { name: "branch", Icon: GitBranch },
  { name: "package", Icon: Package },
  { name: "layers", Icon: Layers },
  { name: "database", Icon: Database },
  { name: "server", Icon: Server },
  { name: "network", Icon: Network },
  { name: "cloud", Icon: Cloud },
  { name: "globe", Icon: Globe },
  { name: "monitor", Icon: Monitor },
  { name: "smartphone", Icon: Smartphone },
  { name: "cpu", Icon: Cpu },
  { name: "bot", Icon: Bot },
  { name: "brain", Icon: Brain },
  { name: "shield", Icon: Shield },
  { name: "lock", Icon: Lock },
  { name: "key", Icon: Key },
  { name: "cog", Icon: Cog },
  { name: "gauge", Icon: Gauge },
  { name: "activity", Icon: Activity },
  { name: "chart", Icon: ChartBar },
  // People and business
  { name: "user", Icon: User },
  { name: "users", Icon: Users },
  { name: "briefcase", Icon: Briefcase },
  { name: "building", Icon: Building2 },
  { name: "store", Icon: Store },
  { name: "cart", Icon: ShoppingCart },
  { name: "truck", Icon: Truck },
  { name: "wallet", Icon: Wallet },
  { name: "dollar", Icon: CircleDollarSign },
  { name: "mail", Icon: Mail },
  { name: "message", Icon: MessageSquare },
  { name: "megaphone", Icon: Megaphone },
  { name: "bell", Icon: Bell },
  // Knowledge
  { name: "file", Icon: FileText },
  { name: "book", Icon: BookOpen },
  { name: "notebook", Icon: NotebookPen },
  { name: "graduation", Icon: GraduationCap },
  { name: "microscope", Icon: Microscope },
  { name: "flask", Icon: FlaskConical },
  { name: "atom", Icon: Atom },
  { name: "archive", Icon: Archive },
  { name: "tag", Icon: Tag },
  // The rest
  { name: "home", Icon: House },
  { name: "palette", Icon: Palette },
  { name: "pen", Icon: PenTool },
  { name: "image", Icon: ImageIcon },
  { name: "camera", Icon: Camera },
  { name: "music", Icon: Music },
  { name: "gamepad", Icon: Gamepad2 },
  { name: "puzzle", Icon: Puzzle },
  { name: "trophy", Icon: Trophy },
  { name: "crown", Icon: Crown },
  { name: "gem", Icon: Gem },
  { name: "gift", Icon: Gift },
  { name: "heart", Icon: Heart },
  { name: "map", Icon: MapIcon },
  { name: "compass", Icon: Compass },
  { name: "anchor", Icon: Anchor },
  { name: "mountain", Icon: Mountain },
  { name: "leaf", Icon: Leaf },
  { name: "sprout", Icon: Sprout },
  { name: "flame", Icon: Flame },
  { name: "sun", Icon: Sun },
  { name: "moon", Icon: Moon },
  { name: "coffee", Icon: Coffee },
  { name: "paw", Icon: PawPrint },
];

/** What a group with no icon (or an icon this build doesn't know) is drawn with. */
export const DEFAULT_GROUP_ICON = FolderOpen;

/** The same for a project: the glyph every project heading wore before projects could pick one. */
export const DEFAULT_PROJECT_ICON = Boxes;

/** The stored names of the two defaults, so a picker can show which tile "no icon" amounts to. */
export const DEFAULT_GROUP_ICON_NAME = "folder";
export const DEFAULT_PROJECT_ICON_NAME = "boxes";

function resolve(name: string | null | undefined, fallback: LucideIcon): LucideIcon {
  if (!name) return fallback;
  return GROUP_ICONS.find((i) => i.name === name)?.Icon ?? fallback;
}

/** Resolve a group's stored icon name to its component, falling back to the default. */
export function groupIcon(name?: string | null): LucideIcon {
  return resolve(name, DEFAULT_GROUP_ICON);
}

/** Resolve a project's stored icon name to its component, falling back to the default. */
export function projectIcon(name?: string | null): LucideIcon {
  return resolve(name, DEFAULT_PROJECT_ICON);
}
