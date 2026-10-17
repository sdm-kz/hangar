import { forwardRef, memo, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type Konva from "konva";
import { Circle, Ellipse, Group, Image as KImage, Layer, Line, Rect as KRect, Shape as KShape, Stage, Text, Transformer } from "react-konva";
import { getStroke } from "perfect-freehand";
import type { Rect } from "@/lib/tauri";
import {
  addShape,
  arrowPolygon,
  contrastOn,
  dragRect,
  fontSizeFor,
  isMeaningful,
  moveShape,
  newId,
  nextStep,
  placeCrop,
  removeShape,
  replaceShape,
  snapAngle,
  stepRadius,
  type Doc,
  type Shape,
  type Tool,
} from "./model";

export interface CanvasHandle {
  /** The picture with its drawing, cut to the crop, at the capture's full resolution. */
  exportCanvas(): HTMLCanvasElement | null;
  /** End any text edit in progress, keeping what was typed. */
  finishEditing(): void;
}

interface Props {
  image: HTMLImageElement;
  /** CSS pixels per capture pixel, as the window shows it. */
  viewScale: number;
  /** The part of the scaled picture in view: its size, and how far into the picture it starts. */
  viewport: { width: number; height: number; panX: number; panY: number };
  /** Device pixels per CSS pixel; past one capture pixel per device pixel the picture is drawn sharp. */
  dpr: number;
  /** Capture pixels per logical pixel — what a stroke weight is multiplied by. */
  captureScale: number;
  doc: Doc;
  tool: Tool;
  color: string;
  strokeWidth: number;
  selectedId: string | null;
  onSelect(id: string | null): void;
  onCommit(doc: Doc): void;
}

type TextEdit = { shape: Extract<Shape, { kind: "text" }>; isNew: boolean };

/** Tools that draw on top of whatever is there. While one of these is out, existing shapes don't take
 *  the pointer — a highlighter stroke over an arrow should be a stroke, not a drag of the arrow. */
const DRAWS_OVER: Tool[] = ["pen", "marker", "blur", "crop"];

const ACCENT = "#ff7a59";

// Memoised: the editor re-renders on every keystroke in the message box, and a canvas re-render means
// a redraw of the full-resolution picture. Every prop is stable between those keystrokes.
export const Canvas = memo(forwardRef<CanvasHandle, Props>(function Canvas(props, ref) {
  const { image, viewScale, viewport, dpr, captureScale, doc, tool, color, strokeWidth, selectedId, onSelect, onCommit } = props;
  const stageRef = useRef<Konva.Stage>(null);
  const contentRef = useRef<Konva.Layer>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [cropDraft, setCropDraft] = useState<Rect | null>(null);
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const interactive = !DRAWS_OVER.includes(tool);
  const shadow = useMemo(
    () => ({ shadowColor: "black", shadowBlur: 3 * captureScale, shadowOpacity: 0.35, shadowForStrokeEnabled: true }),
    [captureScale],
  );

  // What the shapes' handlers read when they fire. The shapes skip re-rendering unless they changed
  // (see ShapeView), so the handlers they hold may be from an older render; through this they still
  // act on the current picture.
  const latest = useRef({ doc, onCommit, onSelect, tool });
  latest.current = { doc, onCommit, onSelect, tool };

  const pointer = (): { x: number; y: number } => {
    const p = stageRef.current?.getPointerPosition() ?? { x: 0, y: 0 };
    return { x: (p.x + viewport.panX) / viewScale, y: (p.y + viewport.panY) / viewScale };
  };

  // Keep the transformer on whatever is selected and resizable.
  const selected = doc.shapes.find((s) => s.id === selectedId) ?? null;
  useEffect(() => {
    const tr = transformerRef.current;
    if (!tr) return;
    const node = selected && !textEdit ? stageRef.current?.findOne(`#${selected.id}`) : null;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [selected, textEdit, doc]);

  const commitText = (edit: TextEdit, text: string) => {
    setTextEdit(null);
    const shape = { ...edit.shape, text };
    if (!isMeaningful(shape, 0)) {
      if (!edit.isNew) onCommit(removeShape(doc, shape.id));
      return;
    }
    onCommit(edit.isNew ? addShape(doc, shape) : replaceShape(doc, shape));
    onSelect(shape.id);
  };

  useImperativeHandle(ref, () => ({
    exportCanvas() {
      const stage = stageRef.current;
      const layer = contentRef.current;
      if (!stage || !layer) return null;
      const area = doc.crop ?? { x: 0, y: 0, width, height };
      // Draw at 1:1 and unpanned so the export has exactly the capture's pixels, then put the view back
      // before the next frame paints — nothing on screen changes. toCanvas draws into a canvas of its
      // own size, so the stage itself needn't grow to the picture's.
      const saved = { scale: stage.scaleX(), position: stage.position() };
      stage.scale({ x: 1, y: 1 });
      stage.position({ x: 0, y: 0 });
      const canvas = layer.toCanvas({ x: area.x, y: area.y, width: area.width, height: area.height, pixelRatio: 1 });
      stage.scale({ x: saved.scale, y: saved.scale });
      stage.position(saved.position);
      return canvas;
    },
    finishEditing() {
      if (textEdit) commitText(textEdit, textEdit.shape.text);
    },
  }));

  const onPointerDown = (e: Konva.KonvaEventObject<PointerEvent>) => {
    if (e.evt.button !== 0) return;
    if (textEdit) {
      // The textarea's blur commits it; a click elsewhere only ends the edit.
      return;
    }
    const target = e.target;
    const onBackground = target === stageRef.current || target.name() === "background";
    if (target.name() === "crop-rect" || target.getParent()?.className === "Transformer") return;
    if (!onBackground && interactive) return; // a shape: Konva drags or selects it
    const p = pointer();
    if (tool === "select") {
      onSelect(null);
      return;
    }
    onSelect(null);
    stageRef.current?.content.setPointerCapture(e.evt.pointerId);
    dragOrigin.current = p;
    const base = { id: newId(), color, width: strokeWidth };
    switch (tool) {
      case "arrow":
      case "line":
        setDraft({ ...base, kind: tool, points: [p.x, p.y, p.x, p.y] });
        break;
      case "rect":
      case "ellipse":
        setDraft({ ...base, kind: tool, x: p.x, y: p.y, w: 0, h: 0 });
        break;
      case "blur":
        setDraft({ id: base.id, kind: "blur", x: p.x, y: p.y, w: 0, h: 0 });
        break;
      case "pen":
      case "marker":
        setDraft({ ...base, kind: tool, points: [p.x, p.y] });
        break;
      case "text": {
        // Keep the press from moving focus, or it would blur the textarea this is about to open.
        e.evt.preventDefault();
        const fontSize = fontSizeFor(strokeWidth);
        dragOrigin.current = null;
        setTextEdit({ shape: { ...base, kind: "text", x: p.x, y: p.y - fontSize * 0.6, text: "", fontSize }, isNew: true });
        break;
      }
      case "step": {
        dragOrigin.current = null;
        const shape: Shape = { ...base, kind: "step", x: p.x, y: p.y, n: nextStep(doc) };
        onCommit(addShape(doc, shape));
        break;
      }
      case "crop":
        setCropDraft({ x: p.x, y: p.y, width: 0, height: 0 });
        break;
    }
  };

  const onPointerMove = (e: Konva.KonvaEventObject<PointerEvent>) => {
    const o = dragOrigin.current;
    if (!o) return;
    const p = pointer();
    const shift = e.evt.shiftKey;
    if (cropDraft) {
      const r = dragRect(o.x, o.y, clamp(p.x, 0, width), clamp(p.y, 0, height), shift);
      setCropDraft({ x: r.x, y: r.y, width: r.w, height: r.h });
      return;
    }
    if (!draft) return;
    switch (draft.kind) {
      case "arrow":
      case "line": {
        const [x2, y2] = shift ? snapAngle(o.x, o.y, p.x, p.y) : [p.x, p.y];
        setDraft({ ...draft, points: [o.x, o.y, x2, y2] });
        break;
      }
      case "rect":
      case "ellipse":
      case "blur":
        setDraft({ ...draft, ...dragRect(o.x, o.y, p.x, p.y, shift) });
        break;
      case "pen":
      case "marker": {
        const pts = draft.points;
        const lx = pts[pts.length - 2];
        const ly = pts[pts.length - 1];
        if (Math.hypot(p.x - lx, p.y - ly) < captureScale) break;
        if (shift && draft.kind === "marker") {
          // A straight highlighter stroke from where it started.
          const [x2, y2] = snapAngle(pts[0], pts[1], p.x, p.y);
          setDraft({ ...draft, points: [pts[0], pts[1], x2, y2] });
        } else setDraft({ ...draft, points: [...pts, p.x, p.y] });
        break;
      }
    }
  };

  const onPointerUp = () => {
    if (!dragOrigin.current) return;
    dragOrigin.current = null;
    const min = 3 * captureScale;
    if (cropDraft) {
      setCropDraft(null);
      const r = { x: Math.round(cropDraft.x), y: Math.round(cropDraft.y), width: Math.round(cropDraft.width), height: Math.round(cropDraft.height) };
      if (r.width >= min && r.height >= min) onCommit({ ...doc, crop: r });
      return;
    }
    if (draft) {
      setDraft(null);
      if (isMeaningful(draft, min)) onCommit(addShape(doc, draft));
    }
  };

  // ---- Moving and resizing existing shapes ----

  const onShapeDragEnd = (shape: Shape, node: Konva.Node) => {
    const { doc, onCommit } = latest.current;
    let moved: Shape;
    switch (shape.kind) {
      case "arrow":
      case "line":
      case "pen":
      case "marker":
        // Drawn from points with the node at the origin: the drag is the node's offset.
        moved = moveShape(shape, node.x(), node.y());
        node.position({ x: 0, y: 0 });
        break;
      case "ellipse":
        moved = { ...shape, x: node.x() - shape.w / 2, y: node.y() - shape.h / 2 };
        break;
      default:
        moved = { ...shape, x: node.x(), y: node.y() } as Shape;
    }
    onCommit(replaceShape(doc, moved));
  };

  const onTransformEnd = (shape: Shape, node: Konva.Node) => {
    const { doc, onCommit } = latest.current;
    const sx = node.scaleX();
    const sy = node.scaleY();
    node.scale({ x: 1, y: 1 });
    let next: Shape = shape;
    if (shape.kind === "rect" || shape.kind === "blur") {
      next = { ...shape, x: node.x(), y: node.y(), w: Math.max(1, shape.w * sx), h: Math.max(1, shape.h * sy) };
    } else if (shape.kind === "ellipse") {
      const w = Math.max(1, shape.w * sx);
      const h = Math.max(1, shape.h * sy);
      next = { ...shape, x: node.x() - w / 2, y: node.y() - h / 2, w, h };
    } else if (shape.kind === "text") {
      next = { ...shape, x: node.x(), y: node.y(), fontSize: Math.max(6, Math.round(shape.fontSize * sy)) };
    }
    onCommit(replaceShape(doc, next));
  };

  const shapeProps = (shape: Shape) => ({
    id: shape.id,
    draggable: interactive && !textEdit,
    listening: interactive,
    onPointerDown: (e: Konva.KonvaEventObject<PointerEvent>) => {
      if (e.evt.button === 0) latest.current.onSelect(shape.id);
    },
    onDragStart: () => latest.current.onSelect(shape.id),
    onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => onShapeDragEnd(shape, e.target),
    onTransformEnd: (e: Konva.KonvaEventObject<Event>) => onTransformEnd(shape, e.target),
    onMouseEnter: () => setCursor(stageRef.current, "move"),
    onMouseLeave: () => setCursor(stageRef.current, cursorFor(latest.current.tool)),
    onDblClick: () => {
      if (shape.kind === "text") setTextEdit({ shape, isNew: false });
    },
  });

  useEffect(() => setCursor(stageRef.current, cursorFor(tool)), [tool]);

  const crop = cropDraft ?? doc.crop;
  const resizable = selected && ["rect", "ellipse", "blur", "text"].includes(selected.kind);
  const lineEnds = selected && (selected.kind === "arrow" || selected.kind === "line") && interactive ? selected : null;

  return (
    // Only the part in view is a canvas: zoomed in, the whole picture at that size would be far past
    // what a canvas can hold.
    <div className="relative overflow-hidden" style={{ width: viewport.width, height: viewport.height }}>
      <Stage
        ref={stageRef}
        width={viewport.width}
        height={viewport.height}
        scaleX={viewScale}
        scaleY={viewScale}
        x={-viewport.panX}
        y={-viewport.panY}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {/* Smoothed only while shrinking: zoomed in, each capture pixel shows as a crisp square. */}
        <Layer ref={contentRef} imageSmoothingEnabled={viewScale * dpr < 1}>
          <KImage image={image} name="background" width={width} height={height} />
          {doc.shapes.map((s) =>
            textEdit?.shape.id === s.id ? null : (
              <ShapeView key={s.id} shape={s} image={image} shadow={shadow} captureScale={captureScale} {...shapeProps(s)} />
            ),
          )}
        </Layer>
        {/* Its own layer: a shape being dragged out redraws on every pointer move, and on the content
            layer that would mean redrawing the full-resolution picture under it each time. */}
        <Layer listening={false}>
          {draft && <ShapeView shape={draft} image={image} shadow={shadow} captureScale={captureScale} listening={false} drafting />}
        </Layer>
        <Layer>
          {crop && <CropShade crop={crop} width={width} height={height} active={tool === "crop"} viewScale={viewScale} />}
          {tool === "crop" && doc.crop && !cropDraft && (
            <CropHandle crop={doc.crop} bounds={{ width, height }} onChange={(c) => onCommit({ ...doc, crop: c })} />
          )}
          <Transformer
            ref={transformerRef}
            rotateEnabled={false}
            ignoreStroke
            flipEnabled={false}
            keepRatio={selected?.kind === "text"}
            resizeEnabled={!!resizable}
            enabledAnchors={
              selected?.kind === "text"
                ? ["top-left", "top-right", "bottom-left", "bottom-right"]
                : resizable
                  ? undefined
                  : []
            }
            borderStroke={ACCENT}
            anchorStroke={ACCENT}
            anchorSize={8}
            anchorCornerRadius={2}
            borderDash={resizable ? undefined : [4, 3]}
          />
          {lineEnds && (
            <LineEndHandles
              shape={lineEnds}
              viewScale={viewScale}
              onChange={(points) => onCommit(replaceShape(doc, { ...lineEnds, points }))}
            />
          )}
        </Layer>
      </Stage>
      {textEdit && (
        <TextEditor
          edit={textEdit}
          viewScale={viewScale}
          pan={viewport}
          onChange={(text) => setTextEdit({ ...textEdit, shape: { ...textEdit.shape, text } })}
          onDone={(text) => commitText(textEdit, text)}
        />
      )}
    </div>
  );
}));

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

function cursorFor(tool: Tool): string {
  return tool === "select" ? "default" : tool === "text" ? "text" : "crosshair";
}

function setCursor(stage: Konva.Stage | null, cursor: string) {
  if (stage) stage.container().style.cursor = cursor;
}

// The rest are Konva node props (id, handlers, draggable…), passed straight through to the node.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NodeProps = Record<string, any>;

type ShapeViewProps = {
  shape: Shape;
  image: HTMLImageElement;
  shadow: object;
  captureScale: number;
  drafting?: boolean;
} & NodeProps;

/** One annotation, drawn the same whether it's being dragged out or long since placed. Re-rendered only
 *  when what it draws changes — shapes are immutable, so the object's identity says when. Its handlers
 *  are left out of the comparison; they read the canvas's current state when they run. */
const ShapeView = memo(ShapeViewImpl, (a, b) =>
  a.shape === b.shape &&
  a.image === b.image &&
  a.shadow === b.shadow &&
  a.captureScale === b.captureScale &&
  a.drafting === b.drafting &&
  a.draggable === b.draggable &&
  a.listening === b.listening,
);

function ShapeViewImpl({ shape, image, shadow, captureScale, drafting, ...node }: ShapeViewProps) {
  switch (shape.kind) {
    case "arrow": {
      const [x1, y1, x2, y2] = shape.points;
      return (
        <Group {...node}>
          <Line points={shape.points} stroke="transparent" strokeWidth={shape.width} hitStrokeWidth={Math.max(14, shape.width * 3)} />
          <Line points={arrowPolygon(x1, y1, x2, y2, shape.width)} closed fill={shape.color} listening={false} {...shadow} />
        </Group>
      );
    }
    case "line":
      return (
        <Line
          {...node}
          points={shape.points}
          stroke={shape.color}
          strokeWidth={shape.width}
          lineCap="round"
          hitStrokeWidth={Math.max(14, shape.width * 3)}
          {...shadow}
        />
      );
    case "rect":
      return (
        <KRect
          {...node}
          x={shape.x}
          y={shape.y}
          width={shape.w}
          height={shape.h}
          stroke={shape.color}
          strokeWidth={shape.width}
          cornerRadius={shape.width * 0.75}
          hitStrokeWidth={Math.max(14, shape.width * 3)}
          fillEnabled={false}
          {...shadow}
        />
      );
    case "ellipse":
      return (
        <Ellipse
          {...node}
          x={shape.x + shape.w / 2}
          y={shape.y + shape.h / 2}
          radiusX={shape.w / 2}
          radiusY={shape.h / 2}
          stroke={shape.color}
          strokeWidth={shape.width}
          hitStrokeWidth={Math.max(14, shape.width * 3)}
          fillEnabled={false}
          {...shadow}
        />
      );
    case "pen": {
      const pairs: [number, number][] = [];
      for (let i = 0; i < shape.points.length; i += 2) pairs.push([shape.points[i], shape.points[i + 1]]);
      const outline = getStroke(pairs, {
        size: shape.width * 1.8,
        thinning: 0.45,
        smoothing: 0.6,
        streamline: 0.45,
        simulatePressure: true,
        last: !drafting,
      }).flat();
      return (
        <Group {...node}>
          <Line points={shape.points} stroke="transparent" strokeWidth={shape.width} hitStrokeWidth={Math.max(14, shape.width * 3)} />
          <Line points={outline} closed fill={shape.color} listening={false} {...shadow} />
        </Group>
      );
    }
    case "marker":
      return (
        <Line
          {...node}
          points={shape.points}
          stroke={shape.color}
          strokeWidth={shape.width * 4.5}
          lineCap="round"
          lineJoin="round"
          tension={0.3}
          opacity={0.42}
          globalCompositeOperation="multiply"
          hitStrokeWidth={shape.width * 4.5}
        />
      );
    case "text":
      return (
        <Text
          {...node}
          x={shape.x}
          y={shape.y}
          text={shape.text}
          fontSize={shape.fontSize}
          fontFamily={FONT}
          fontStyle="bold"
          lineHeight={1.2}
          fill={shape.color}
          stroke={contrastOn(shape.color)}
          strokeWidth={Math.max(1, shape.fontSize * 0.1)}
          fillAfterStrokeEnabled
          lineJoin="round"
        />
      );
    case "step": {
      const r = stepRadius(shape.width);
      return (
        <Group {...node} x={shape.x} y={shape.y}>
          <Circle radius={r} fill={shape.color} stroke="white" strokeWidth={Math.max(1.5, r * 0.12)} {...shadow} />
          <Text
            text={String(shape.n)}
            width={r * 2}
            height={r * 2}
            offsetX={r}
            offsetY={r}
            align="center"
            verticalAlign="middle"
            fontSize={r * (shape.n > 9 ? 0.9 : 1.15)}
            fontFamily={FONT}
            fontStyle="bold"
            fill={contrastOn(shape.color)}
            listening={false}
          />
        </Group>
      );
    }
    case "blur":
      return <Pixelated {...node} shape={shape} image={image} block={Math.max(6, Math.round(9 * captureScale))} />;
  }
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, sans-serif';

/** A region of the picture redrawn in coarse blocks: unreadable, and still obviously "something was
 *  here". Pixelation rather than blur, since a blur of large text can often be read back. */
function Pixelated({
  shape,
  image,
  block,
  ...node
}: { shape: Extract<Shape, { kind: "blur" }>; image: HTMLImageElement; block: number } & NodeProps) {
  const { x, y, w, h } = shape;
  const canvas = useMemo(() => {
    const cw = Math.max(1, Math.round(w));
    const ch = Math.max(1, Math.round(h));
    const small = document.createElement("canvas");
    small.width = Math.max(1, Math.ceil(cw / block));
    small.height = Math.max(1, Math.ceil(ch / block));
    const sctx = small.getContext("2d")!;
    sctx.drawImage(image, x, y, cw, ch, 0, 0, small.width, small.height);
    const out = document.createElement("canvas");
    out.width = cw;
    out.height = ch;
    const octx = out.getContext("2d")!;
    octx.imageSmoothingEnabled = false;
    octx.drawImage(small, 0, 0, small.width, small.height, 0, 0, small.width * block, small.height * block);
    return out;
  }, [image, x, y, w, h, block]);
  return <KImage {...node} x={x} y={y} width={w} height={h} image={canvas} />;
}

/** Everything outside the crop, shaded; dark while cropping, darker once it's set. */
function CropShade({ crop, width, height, active, viewScale }: { crop: Rect; width: number; height: number; active: boolean; viewScale: number }) {
  return (
    <>
      <KShape
        listening={false}
        sceneFunc={(ctx) => {
          ctx.beginPath();
          ctx.rect(0, 0, width, height);
          ctx.rect(crop.x, crop.y, crop.width, crop.height);
          ctx.fillStyle = active ? "rgba(0,0,0,0.5)" : "rgba(0,0,0,0.72)";
          ctx.fill("evenodd");
        }}
      />
      <KRect
        listening={false}
        x={crop.x}
        y={crop.y}
        width={crop.width}
        height={crop.height}
        stroke="white"
        strokeWidth={1 / viewScale}
        dash={[6 / viewScale, 4 / viewScale]}
      />
    </>
  );
}

/** The crop, draggable and resizable while the crop tool is out. */
function CropHandle({ crop, bounds, onChange }: { crop: Rect; bounds: { width: number; height: number }; onChange(c: Rect): void }) {
  const rectRef = useRef<Konva.Rect>(null);
  const trRef = useRef<Konva.Transformer>(null);
  useEffect(() => {
    if (rectRef.current && trRef.current) trRef.current.nodes([rectRef.current]);
  }, [crop]);
  const done = (moved: boolean) => {
    const n = rectRef.current;
    if (!n) return;
    const r = { x: n.x(), y: n.y(), width: n.width() * n.scaleX(), height: n.height() * n.scaleY() };
    n.scale({ x: 1, y: 1 });
    const placed = placeCrop(r, moved, bounds);
    if (placed) onChange(placed);
  };
  return (
    <>
      <KRect
        ref={rectRef}
        name="crop-rect"
        x={crop.x}
        y={crop.y}
        width={crop.width}
        height={crop.height}
        fill="transparent"
        draggable
        onDragEnd={() => done(true)}
        onTransformEnd={() => done(false)}
        onMouseEnter={(e) => (e.target.getStage()!.container().style.cursor = "move")}
        onMouseLeave={(e) => (e.target.getStage()!.container().style.cursor = "crosshair")}
      />
      <Transformer ref={trRef} rotateEnabled={false} flipEnabled={false} keepRatio={false} borderStroke={ACCENT} anchorStroke={ACCENT} anchorSize={9} />
    </>
  );
}

/** Grab handles on an arrow's or a line's two ends. */
function LineEndHandles({
  shape,
  viewScale,
  onChange,
}: {
  shape: Extract<Shape, { kind: "arrow" | "line" }>;
  viewScale: number;
  onChange(points: [number, number, number, number]): void;
}) {
  const [x1, y1, x2, y2] = shape.points;
  const r = 5 / viewScale;
  const handle = (x: number, y: number, which: 0 | 1) => (
    <Circle
      x={x}
      y={y}
      radius={r}
      fill="white"
      stroke={ACCENT}
      strokeWidth={1.5 / viewScale}
      draggable
      onMouseEnter={(e) => (e.target.getStage()!.container().style.cursor = "grab")}
      onMouseLeave={(e) => (e.target.getStage()!.container().style.cursor = "default")}
      onDragEnd={(e) => {
        const nx = e.target.x();
        const ny = e.target.y();
        onChange(which === 0 ? [nx, ny, x2, y2] : [x1, y1, nx, ny]);
      }}
    />
  );
  return (
    <>
      {handle(x1, y1, 0)}
      {handle(x2, y2, 1)}
    </>
  );
}

/** Typing into a text annotation: a textarea laid exactly over where the text will be drawn. */
function TextEditor({
  edit,
  viewScale,
  pan,
  onChange,
  onDone,
}: {
  edit: TextEdit;
  viewScale: number;
  pan: { panX: number; panY: number };
  onChange(t: string): void;
  onDone(t: string): void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const { shape } = edit;
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.width = "0px";
    el.style.height = "0px";
    el.style.width = `${Math.max(shape.fontSize * viewScale * 2, el.scrollWidth + 4)}px`;
    el.style.height = `${el.scrollHeight}px`;
  }, [shape.text, shape.fontSize, viewScale]);
  return (
    <textarea
      ref={ref}
      value={shape.text}
      wrap="off"
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      onBlur={(e) => onDone(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
          e.preventDefault();
          onDone(e.currentTarget.value);
        }
      }}
      className="absolute resize-none overflow-hidden border border-dashed border-accent bg-transparent p-0 outline-none"
      style={{
        left: shape.x * viewScale - pan.panX,
        top: shape.y * viewScale - pan.panY,
        fontSize: shape.fontSize * viewScale,
        lineHeight: 1.2,
        fontWeight: 700,
        fontFamily: FONT,
        color: shape.color,
        WebkitTextStroke: `${Math.max(0.5, shape.fontSize * 0.05 * viewScale)}px ${contrastOn(shape.color)}`,
        paintOrder: "stroke fill",
        caretColor: shape.color,
      }}
    />
  );
}
