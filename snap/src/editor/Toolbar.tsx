import type { ReactNode } from "react";
import clsx from "clsx";
import {
  Circle,
  Copy,
  Crop,
  Download,
  Grid3x3,
  Highlighter,
  Minus,
  MousePointer2,
  MoveUpRight,
  Pencil,
  Redo2,
  Square,
  Type,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { COLORS, TOOLS, WEIGHTS, type Tool, type Weight } from "./model";

const ICONS: Record<Tool, ReactNode> = {
  select: <MousePointer2 size={17} />,
  arrow: <MoveUpRight size={17} />,
  rect: <Square size={17} />,
  ellipse: <Circle size={17} />,
  line: <Minus size={17} className="-rotate-45" />,
  pen: <Pencil size={17} />,
  marker: <Highlighter size={17} />,
  text: <Type size={17} />,
  step: <StepIcon />,
  blur: <Grid3x3 size={17} />,
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
  hasCrop: boolean;
  onClearCrop(): void;
  onCopy(): void;
  onSave(): void;
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
      {props.hasCrop && (
        <button
          className="ml-1 flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={props.onClearCrop}
          title="Remove the crop"
        >
          <X size={13} /> Crop
        </button>
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
        <>
          <div className="flex items-center" role="group" aria-label="Zoom">
            <IconButton title={`Zoom out (${mod}−)`} onClick={() => props.onZoom(-1)}>
              <ZoomOut size={17} />
            </IconButton>
            <button
              className="h-8 min-w-[52px] rounded-md px-1.5 text-[12px] tabular-nums text-foreground/80 hover:bg-muted hover:text-foreground"
              onClick={props.onZoomToggle}
              title={
                props.fitted
                  ? `Fitted to the window · click for actual size (${mod}1)`
                  : `Click to fit the window (${mod}0) · ${mod}wheel zooms, Space-drag or the wheel moves`
              }
            >
              {props.zoom}%
            </button>
            <IconButton title={`Zoom in (${mod}+)`} onClick={() => props.onZoom(1)}>
              <ZoomIn size={17} />
            </IconButton>
          </div>
          <Divider />
        </>
      )}
      <IconButton title={`Copy image (${mod}C)`} onClick={props.onCopy}>
        <Copy size={17} />
      </IconButton>
      <IconButton title={`Save as… (${mod}S)`} onClick={props.onSave}>
        <Download size={17} />
      </IconButton>
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
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  title: string;
  onClick(): void;
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
        "flex h-8 w-8 items-center justify-center rounded-md transition-colors disabled:opacity-35",
        active ? "bg-accent text-accent-foreground" : "text-foreground/80 hover:bg-muted enabled:hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
