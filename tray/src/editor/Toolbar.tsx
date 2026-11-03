import type { ReactNode } from "react";
import clsx from "clsx";
import {
  Check,
  Circle,
  Copy,
  Crop,
  Download,
  Eraser,
  Grid3x3,
  Highlighter,
  ImagePlus,
  Lasso,
  Minus,
  MousePointer2,
  MoveUpRight,
  PaintBucket,
  Pencil,
  Redo2,
  Square,
  SquareDashed,
  Type,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { COLORS, TOOLS, WEIGHTS, type Tool, type Weight } from "./model";

const ICONS: Record<Tool, ReactNode> = {
  select: <MousePointer2 size={17} />,
  area: <SquareDashed size={17} />,
  lasso: <Lasso size={17} />,
  arrow: <MoveUpRight size={17} />,
  rect: <Square size={17} />,
  ellipse: <Circle size={17} />,
  line: <Minus size={17} className="-rotate-45" />,
  pen: <Pencil size={17} />,
  marker: <Highlighter size={17} />,
  text: <Type size={17} />,
  step: <StepIcon />,
  blur: <Grid3x3 size={17} />,
  eraser: <Eraser size={17} />,
  crop: <Crop size={17} />,
};

function StepIcon() {
  return (
    <span className="flex h-[17px] w-[17px] items-center justify-center rounded-full border-[1.6px] border-current text-[10px] font-bold leading-none">
      1
    </span>
  );
}

export function Toolbar(props: {
  tool: Tool;
  onTool(t: Tool): void;
  color: string;
  onColor(c: string): void;
  weight: Weight;
  onWeight(w: Weight): void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  /** A crop being set, one applied, or neither. */
  crop: "set" | "applied" | "none";
  onApplyCrop(): void;
  /** Drop the crop being set, or else show the whole picture again. */
  onClearCrop(): void;
  /** An area of the picture is selected (the area or lasso tool), to fill. */
  area: boolean;
  onFillArea(): void;
  onCopy(): void;
  onSave(): void;
  /** Take another capture into this editor, to send with this one. */
  onAdd(): void;
  canAdd: boolean;
  /** The zoom in percent of the capture's real size; null until there is a picture. */
  zoom: number | null;
  fitted: boolean;
  onZoom(dir: 1 | -1): void;
  onZoomToggle(): void;
  mod: string;
}) {
  const { tool, onTool, color, onColor, weight, onWeight, mod } = props;
  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border bg-panel px-2">
      <IconButton title={`Add a capture, to send with this one (${mod}⇧N)`} disabled={!props.canAdd} onClick={props.onAdd}>
        <ImagePlus size={17} />
      </IconButton>
      <IconButton title={`Copy image (${mod}C)`} onClick={props.onCopy}>
        <Copy size={17} />
      </IconButton>
      <IconButton title={`Save as… (${mod}S)`} onClick={props.onSave}>
        <Download size={17} />
      </IconButton>
      <Divider />
      <div className="flex items-center gap-0.5" role="toolbar" aria-label="Tools">
        {TOOLS.map((t) => (
          <IconButton
            key={t.tool}
            active={tool === t.tool}
            title={`${t.label} (${t.key.toUpperCase()})`}
            onClick={() => onTool(t.tool)}
          >
            {ICONS[t.tool]}
          </IconButton>
        ))}
      </div>
      {props.area && (
        <IconButton
          title="Fill the selected area with the colour (F) · Delete fills it white · drag it to move it"
          onClick={props.onFillArea}
        >
          <span className="relative flex flex-col items-center">
            <PaintBucket size={16} />
            {/* The colour it fills with; ringed, so white shows on a light panel. */}
            <span className="mt-0.5 h-[3px] w-4 rounded-full" style={{ background: color, boxShadow: "0 0 0 0.5px rgba(127,127,127,0.6)" }} />
          </span>
        </IconButton>
      )}
      {props.crop === "set" && (
        <IconButton
          title="Apply the crop: keep only what is inside it (Enter, or double-click it) · undo brings the rest back"
          onClick={props.onApplyCrop}
        >
          {/* Green, not the accent: the crop tool beside it is already lit in that. */}
          <Check size={18} strokeWidth={2.5} className="text-ok" />
        </IconButton>
      )}
      {props.crop !== "none" && (
        <IconButton
          title={props.crop === "set" ? "Remove the crop" : "Show the whole picture again"}
          onClick={props.onClearCrop}
        >
          <X size={17} />
        </IconButton>
      )}
      <Divider />
      <div className="flex items-center gap-1" role="radiogroup" aria-label="Colour">
        {COLORS.map((c) => (
          <button
            key={c}
            role="radio"
            aria-checked={color === c}
            title={c}
            onClick={() => onColor(c)}
            className={clsx(
              "h-[18px] w-[18px] rounded-full ring-offset-2 ring-offset-panel transition",
              color === c ? "ring-2 ring-foreground/70" : "hover:scale-110",
            )}
            style={{ background: c, boxShadow: "inset 0 0 0 1px rgba(127,127,127,0.45)" }}
          />
        ))}
      </div>
      <Divider />
      <div className="flex items-center gap-0.5" role="radiogroup" aria-label="Weight">
        {(Object.keys(WEIGHTS) as Weight[]).map((w) => (
          <IconButton key={w} active={weight === w} title={`Weight ${w.toUpperCase()}`} onClick={() => onWeight(w)}>
            <span className="block rounded-full bg-current" style={{ width: 14, height: WEIGHTS[w] * 0.9 + 1 }} />
          </IconButton>
        ))}
      </div>
      <Divider />
      <IconButton title={`Undo (${mod}Z)`} disabled={!props.canUndo} onClick={props.onUndo}>
        <Undo2 size={17} />
      </IconButton>
      <IconButton title={`Redo (${mod}⇧Z)`} disabled={!props.canRedo} onClick={props.onRedo}>
        <Redo2 size={17} />
      </IconButton>
      <div className="flex-1" />
      {props.zoom !== null && (
        <div className="flex items-center" role="group" aria-label="Zoom">
          <IconButton title={`Zoom out (${mod}−)`} onClick={() => props.onZoom(-1)} width="w-7">
            <ZoomOut size={17} />
          </IconButton>
          <button
            className="h-8 min-w-[38px] rounded-md px-0.5 text-[12px] tabular-nums text-foreground/80 hover:bg-muted hover:text-foreground"
            onClick={props.onZoomToggle}
            title={
              props.fitted
                ? `Fitted to the window · click for actual size (${mod}1)`
                : `Click to fit the window (${mod}0) · ${mod}wheel zooms, Space-drag or the wheel moves`
            }
          >
            {props.zoom}%
          </button>
          <IconButton title={`Zoom in (${mod}+)`} onClick={() => props.onZoom(1)} width="w-7">
            <ZoomIn size={17} />
          </IconButton>
        </div>
      )}
    </div>
  );
}

function Divider() {
  return <div className="mx-1.5 h-6 w-px bg-border" />;
}

export function IconButton({
  active,
  disabled,
  title,
  onClick,
  width,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  title: string;
  onClick(): void;
  /** A width class in place of w-8, for a tighter group. */
  width?: string;
  children: ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "flex h-8 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-35",
        active ? "bg-accent text-accent-foreground" : "text-foreground/80 hover:bg-muted enabled:hover:text-foreground",
        width ?? "w-8",
      )}
    >
      {children}
    </button>
  );
}
