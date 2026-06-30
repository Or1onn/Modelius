// Icon.tsx — Icon atom backed by lucide-react (name → component map, currentColor).
import type { CSSProperties } from "react";
import {
  MessageSquare, Server, Shield, LayoutDashboard, Workflow, Plus, SendHorizontal,
  Leaf, Star, Zap, Lock, Paperclip, X, ChevronRight, ChevronDown, Search, Check,
  Sparkles, ArrowRight, Play, TrendingUp, Gauge, Copy, RefreshCw, Settings, Pencil,
  Eye, EyeOff, Key, CircleAlert, CircleCheck, CircleX, Link2, Cpu, SlidersHorizontal,
  Ellipsis, Upload, Brain, Code, PanelLeftClose, PanelLeftOpen, Pin, Trash2, Globe,
  Moon, Sun, type LucideIcon,
} from "lucide-react";

// name → lucide component. Names kept from the old set so call sites don't change.
const ICONS: Record<string, LucideIcon> = {
  chat: MessageSquare,
  providers: Server,
  policy: Shield,
  dashboard: LayoutDashboard,
  pipeline: Workflow,
  plus: Plus,
  send: SendHorizontal,
  leaf: Leaf,
  star: Star,
  bolt: Zap,
  lock: Lock,
  attach: Paperclip,
  close: X,
  chevron: ChevronRight,
  chevronD: ChevronDown,
  search: Search,
  check: Check,
  spark: Sparkles,
  arrowR: ArrowRight,
  play: Play,
  trend: TrendingUp,
  gauge: Gauge,
  copy: Copy,
  refresh: RefreshCw,
  cog: Settings,
  moon: Moon,
  sun: Sun,
  edit: Pencil,
  eye: Eye,
  eyeOff: EyeOff,
  key: Key,
  shield: Shield,
  alert: CircleAlert,
  checkCircle: CircleCheck,
  xCircle: CircleX,
  link: Link2,
  cpu: Cpu,
  sliders: SlidersHorizontal,
  more: Ellipsis,
  upload: Upload,
  memory: Brain,
  code: Code,
  panelLeftClose: PanelLeftClose,
  panelLeftOpen: PanelLeftOpen,
  pin: Pin,
  trash: Trash2,
  globe: Globe,
};

interface IconProps {
  name: string;
  size?: number;
  stroke?: number;
  fill?: boolean;
  style?: CSSProperties;
}

export function Icon({ name, size = 16, stroke = 1.6, fill = false, style }: IconProps) {
  const Cmp = ICONS[name];
  if (!Cmp) return null;
  return (
    <Cmp
      size={size}
      strokeWidth={stroke}
      style={style}
      fill={fill ? "currentColor" : "none"}
      aria-hidden="true"
    />
  );
}
