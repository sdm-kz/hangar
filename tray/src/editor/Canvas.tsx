import { forwardRef, memo, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type Konva from "konva";
import { Circle, Ellipse, Group, Image as KImage, Layer, Line, Rect as KRect, Shape as KShape, Stage, Text, Transformer } from "react-konva";
import { getStroke } from "perfect-freehand";
import type { Rect } from "@/lib/tauri";
import {
  addShape,
  applyCrop,
  arrowPolygon,
  contrastOn,
  dragRect,
  eraserWidth,
  exportArea,
  extendFor,
  finishRegion,
  FIT_MARGIN,
  FONT,
  measureText,
  fontSizeFor,
  frameOf,
  isMeaningful,
  moveRegion,
  moveShape,
  newId,
  nextStep,
  pixelBounds,
  placeCrop,
  regionContains,
  removeShape,
  replaceShape,
  snapAngle,
  stepRadius,
  traceRegion,
  type Doc,
  type Region,
  type Shape,
  type Tool,
} from "./model";

export interface CanvasHandle {
  /** The picture with its drawing, cut to the crop, at the capture's full resolution. */
  exportCanvas(): HTMLCanvasElement | null;
  /** End any text edit in progress, keeping what was typed. */
  finishEditing(): void;
  /** Whether an area of the picture is selected, as of the last render: current the moment a key is
   *  pressed, where `onArea` is told only once the frame has painted. */
  hasArea(): boolean;
  /** Fill the selected area of the picture with `color`; nothing when no area is selected. */
  fillArea(color: string): void;
  /** Let go of the selected area, leaving the picture as it is. */
  dropArea(): void;
}

interface Props {
  image: HTMLImageElement;
  /** CSS pixels per capture pixel, as the window shows it. */
  viewScale: number;
  /** The part of the scaled picture in view: its size, and how far into what is on show (the crop
   *  applied, or all of it) it starts. */
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
  /** Whether an area of the picture is selected now (the area and lasso tools). */
  onArea(selected: boolean): void;
}

type TextEdit = { shape: Extract<Shape, { kind: "text" }>; isNew: boolean };

/** Tools that draw on top of whatever is there. While one of these is out, existing shapes don't take
 *  the pointer — a highlighter stroke over an arrow should be a stroke, not a drag of the arrow. */
const DRAWS_OVER: Tool[] = ["pen", "marker", "blur", "crop", "area", "lasso", "eraser"];

const ACCENT = "#ff7a59";
/** What a moved part of the picture leaves behind: white, as the margin a picture grows by. */
const HOLE = "#ffffff";

/** An area of the picture picked with the area or lasso tool. Once moved, its pixels are a patch on the
 *  picture, and moving it again moves that patch rather than lifting the picture from under it; the
 *  outline then goes where the patch is — `region` as it was when the patch lay at `origin` — so an
 *  undo or a redo of a move takes the outline with the pixels. */
type AreaSelection = { region: Region; patchId: string | null; origin?: { x: number; y: number }; filledBy?: string };
type Patch = Extract<Shape, { kind: "patch" }>;
/** An area being dragged to a new place: how far, and what goes with it — pixels lifted from the picture
 *  just now, or the patch an earlier move made. */
type AreaMove = { dx: number; dy: number; lifted: Patch | null; patch: Patch | null };

// Memoised: the editor re-renders on every keystroke in the message box, and a canvas re-render means
// a redraw of the full-resolution picture. Every prop is stable between those keystrokes.
export const Canvas = memo(forwardRef<CanvasHandle, Props>(function Canvas(props, ref) {
  const { image, viewScale, viewport, dpr, captureScale, doc, tool, color, strokeWidth, selectedId, onSelect, onCommit, onArea } = props;
  const stageRef = useRef<Konva.Stage>(null);
  const contentRef = useRef<Konva.Layer>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [cropDraft, setCropDraft] = useState<Rect | null>(null);
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);
  const [area, setArea] = useState<AreaSelection | null>(null);
  const [areaDraft, setAreaDraft] = useState<Region | null>(null);
  const [areaMove, setAreaMove] = useState<AreaMove | null>(null);
  // Where the pointer is, for the eraser's outline.
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  // The picture as edited — fills, moved areas, erasing — without the marks on it: what a pixelation
  // blurs. Redrawn only when those edits change, not with every mark.
  const editsRef = useRef<Shape[]>([]);
  const latestEdits = doc.shapes.filter(isPictureEdit);
  if (latestEdits.length !== editsRef.current.length || latestEdits.some((s, i) => s !== editsRef.current[i])) {
    editsRef.current = latestEdits;
  }
  const edits = editsRef.current;
  const picture = useMemo(() => renderPicture(image, edits), [image, edits]);
  const areaPatch = area?.patchId ? (doc.shapes.find((s): s is Patch => s.id === area.patchId && s.kind === "patch") ?? null) : null;
  // Where the selected area is now (see AreaSelection); null when nothing is, or its patch was undone.
  const areaRegion = !area || (area.filledBy && !doc.shapes.some((s) => s.id === area.filledBy))
    ? null
    : area.patchId
      ? areaPatch && area.origin
        ? moveRegion(area.region, areaPatch.x - area.origin.x, areaPatch.y - area.origin.y)
        : null
      : area.region;
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  // The part of the picture on show. Everything stays in the capture's pixels; only the view moves.
  const frame = frameOf(doc, width, height);
  const panX = viewport.panX + frame.x * viewScale;
  const panY = viewport.panY + frame.y * viewScale;
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

  // `next`, with the picture grown to take in `shape` if it now reaches past the edge — in the same
  // undoable step, so undoing the shape takes the margin it made with it.
  const fit = (next: Doc, shape: Shape) => extendFor(next, shape, width, height, FIT_MARGIN * captureScale, measureText);

  const pointer = (): { x: number; y: number } => {
    const p = stageRef.current?.getPointerPosition() ?? { x: 0, y: 0 };
    return { x: (p.x + panX) / viewScale, y: (p.y + panY) / viewScale };
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
    onCommit(fit(edit.isNew ? addShape(doc, shape) : replaceShape(doc, shape), shape));
    onSelect(shape.id);
  };

  /** The picture with its drawing over `r`, at the capture's own pixels. */
  const render = (r: Rect): HTMLCanvasElement | null => {
    const stage = stageRef.current;
    const layer = contentRef.current;
    if (!stage || !layer) return null;
    // Drawn at 1:1 and unpanned so it has exactly the capture's pixels, then the view is put back before
    // the next frame paints — nothing on screen changes. toCanvas draws into a canvas of its own size,
    // so the stage itself needn't grow to the picture's.
    const saved = { scale: stage.scaleX(), position: stage.position() };
    stage.scale({ x: 1, y: 1 });
    stage.position({ x: 0, y: 0 });
    const canvas = layer.toCanvas({ x: r.x, y: r.y, width: r.width, height: r.height, pixelRatio: 1 });
    stage.scale({ x: saved.scale, y: saved.scale });
    stage.position(saved.position);
    return canvas;
  };

  /** What shows inside a region now, as a patch lying where it is: everything inside the outline, and
   *  nothing of what is outside it but inside its bounds. */
  const lift = (region: Region): Patch | null => {
    const b = pixelBounds(region);
    if (b.width < 1 || b.height < 1) return null;
    const shown = render(b);
    if (!shown) return null;
    let pixels = shown;
    if (region.kind === "poly") {
      pixels = document.createElement("canvas");
      pixels.width = b.width;
      pixels.height = b.height;
      const ctx = pixels.getContext("2d")!;
      traceRegion(ctx, moveRegion(region, -b.x, -b.y));
      ctx.clip();
      ctx.drawImage(shown, 0, 0);
    }
    const outline = region.kind === "poly" ? moveRegion(region, -b.x, -b.y) : undefined;
    return { id: newId(), kind: "patch", x: b.x, y: b.y, w: b.width, h: b.height, pixels, outline };
  };

  /** Put the area down `dx`, `dy` from where it is, as one undoable step: lifted out of the picture,
   *  leaving white, the first time; the patch that made moved after that. */
  const placeArea = (move: AreaMove) => {
    if (!areaRegion) return;
    if (move.patch) {
      // The outline follows the patch by itself (see AreaSelection).
      const moved = { ...move.patch, x: move.patch.x + move.dx, y: move.patch.y + move.dy };
      onCommit(fit(replaceShape(doc, moved), moved));
    } else if (move.lifted) {
      const hole: Shape = { id: newId(), kind: "fill", region: areaRegion, color: HOLE };
      const patch = { ...move.lifted, x: move.lifted.x + move.dx, y: move.lifted.y + move.dy };
      onCommit(fit(addShape(addShape(doc, hole), patch), patch));
      setArea({ region: areaRegion, patchId: patch.id, origin: { x: move.lifted.x, y: move.lifted.y } });
    }
  };

  const fillArea = (fill: string) => {
    if (!areaRegion) return;
    const shape: Shape = { id: newId(), kind: "fill", region: areaRegion, color: fill };
    onCommit(fit(addShape(doc, shape), shape));
    // Filled, it is part of the picture again: the next move lifts the fill along with what is under it.
    // An undo that takes the fill away takes the selection with it, as one of a move does.
    setArea({ region: areaRegion, patchId: null, filledBy: shape.id });
  };

  useImperativeHandle(ref, () => ({
    exportCanvas() {
      return render(exportArea(doc, width, height));
    },
    finishEditing() {
      if (textEdit) commitText(textEdit, textEdit.shape.text);
    },
    hasArea: () => !!areaRegion,
    fillArea,
    dropArea() {
      setArea(null);
    },
  }));

  // The selected area goes with the tools that made it, and with an undo that took its patch away (the
  // pixels are back where they were, so the outline would be in the wrong place).
  useEffect(() => {
    if (tool !== "area" && tool !== "lasso") {
      setArea(null);
      setAreaDraft(null);
      setAreaMove(null);
    }
    if (tool !== "eraser") setHover(null);
  }, [tool]);
  useEffect(() => {
    if (area && !areaRegion) setArea(null);
  }, [area, areaRegion]);
  useEffect(() => onArea(!!areaRegion), [areaRegion, onArea]);
  useEffect(() => () => onArea(false), [onArea]);

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
        onCommit(fit(addShape(doc, shape), shape));
        break;
      }
      case "crop":
        setCropDraft({ x: p.x, y: p.y, width: 0, height: 0 });
        break;
      case "area":
      case "lasso": {
        if (areaRegion && regionContains(areaRegion, p.x, p.y)) {
          // Into the selection: a drag moves it. Lifted now, so it shows moving as it is dragged.
          setAreaMove({ dx: 0, dy: 0, patch: areaPatch, lifted: areaPatch ? null : lift(areaRegion) });
          break;
        }
        setArea(null);
        setAreaDraft(tool === "area" ? { kind: "rect", x: p.x, y: p.y, w: 0, h: 0 } : { kind: "poly", points: [p.x, p.y] });
        break;
      }
      case "eraser":
        setDraft({ id: base.id, kind: "eraser", points: [p.x, p.y], width: eraserWidth(strokeWidth) });
        break;
    }
  };

  const onPointerMove = (e: Konva.KonvaEventObject<PointerEvent>) => {
    const o = dragOrigin.current;
    const p = pointer();
    if (tool === "eraser") setHover(p);
    if (!o) {
      if (tool === "area" || tool === "lasso") {
        setCursor(stageRef.current, areaRegion && regionContains(areaRegion, p.x, p.y) ? "move" : cursorFor(tool));
      }
      return;
    }
    const shift = e.evt.shiftKey;
    if (areaMove) {
      // Whole pixels, so what moves stays sharp. Shift holds it to straight across or straight down.
      let dx = Math.round(p.x - o.x);
      let dy = Math.round(p.y - o.y);
      if (shift) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      setAreaMove({ ...areaMove, dx, dy });
      return;
    }
    if (areaDraft) {
      if (areaDraft.kind === "rect") setAreaDraft({ kind: "rect", ...dragRect(o.x, o.y, p.x, p.y, shift) });
      else {
        const pts = areaDraft.points;
        if (Math.hypot(p.x - pts[pts.length - 2], p.y - pts[pts.length - 1]) >= captureScale) {
          setAreaDraft({ kind: "poly", points: [...pts, p.x, p.y] });
        }
      }
      return;
    }
    if (cropDraft) {
      const r = dragRect(o.x, o.y, clamp(p.x, frame.x, frame.x + frame.width), clamp(p.y, frame.y, frame.y + frame.height), shift);
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
      case "marker":
      case "eraser": {
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
    if (areaMove) {
      setAreaMove(null);
      if (areaMove.dx !== 0 || areaMove.dy !== 0) placeArea(areaMove);
      return;
    }
    if (areaDraft) {
      setAreaDraft(null);
      const region = finishRegion(areaDraft, min);
      setArea(region ? { region, patchId: null } : null);
      return;
    }
    if (cropDraft) {
      setCropDraft(null);
      const r = { x: Math.round(cropDraft.x), y: Math.round(cropDraft.y), width: Math.round(cropDraft.width), height: Math.round(cropDraft.height) };
      if (r.width >= min && r.height >= min) onCommit({ ...doc, crop: r });
      return;
    }
    if (draft) {
      setDraft(null);
      if (isMeaningful(draft, min)) onCommit(fit(addShape(doc, draft), draft));
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
    onCommit(fit(replaceShape(doc, moved), moved));
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
    onCommit(fit(replaceShape(doc, next), next));
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
        x={-panX}
        y={-panY}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover(null)}
      >
        {/* Smoothed only while shrinking: zoomed in, each capture pixel shows as a crisp square. */}
        <Layer ref={contentRef} imageSmoothingEnabled={viewScale * dpr < 1}>
          {/* What the picture was grown by to fit its shapes, white, as on a page. */}
          <Margin frame={frame} width={width} height={height} />
          <KImage image={image} name="background" width={width} height={height} />
          {doc.shapes.map((s) =>
            textEdit?.shape.id === s.id || areaMove?.patch?.id === s.id ? null : (
              <ShapeView key={s.id} shape={s} image={image} picture={picture} shadow={shadow} captureScale={captureScale} {...shapeProps(s)} />
            ),
          )}
        </Layer>
        {/* Its own layer: a shape being dragged out redraws on every pointer move, and on the content
            layer that would mean redrawing the full-resolution picture under it each time. */}
        <Layer listening={false}>
          {draft && (
            <ShapeView shape={draft} image={image} picture={picture} shadow={shadow} captureScale={captureScale} listening={false} drafting />
          )}
          {areaMove && areaRegion && <AreaMoving move={areaMove} region={areaRegion} />}
          {tool === "eraser" && hover && !draft && (
            <Circle x={hover.x} y={hover.y} radius={eraserWidth(strokeWidth) / 2} stroke="white" strokeWidth={1.5 / viewScale} shadowColor="black" shadowBlur={2 / viewScale} shadowOpacity={0.8} />
          )}
        </Layer>
        <Layer>
          {crop && <CropShade crop={crop} frame={frame} active={tool === "crop"} viewScale={viewScale} />}
          {(areaDraft || areaRegion) && (
            <AreaOutline
              region={areaDraft ?? moveRegion(areaRegion!, areaMove?.dx ?? 0, areaMove?.dy ?? 0)}
              viewScale={viewScale}
            />
          )}
          {tool === "crop" && doc.crop && !cropDraft && (
            <CropHandle
              crop={doc.crop}
              bounds={frame}
              onChange={(c) => onCommit({ ...doc, crop: c })}
              onApply={() => onCommit(applyCrop(doc))}
            />
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
              onChange={(points) => {
                const moved = { ...lineEnds, points };
                onCommit(fit(replaceShape(doc, moved), moved));
              }}
            />
          )}
        </Layer>
      </Stage>
      {textEdit && (
        <TextEditor
          edit={textEdit}
          viewScale={viewScale}
          pan={{ panX, panY }}
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
  /** The picture as edited, for pixelation (see renderPicture). */
  picture: CanvasImageSource;
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
  a.picture === b.picture &&
  a.shadow === b.shadow &&
  a.captureScale === b.captureScale &&
  a.drafting === b.drafting &&
  a.draggable === b.draggable &&
  a.listening === b.listening,
);

function ShapeViewImpl({ shape, image, picture, shadow, captureScale, drafting, ...node }: ShapeViewProps) {
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
      return <Pixelated {...node} shape={shape} image={picture} block={Math.max(6, Math.round(9 * captureScale))} />;
    // Edits to the picture: part of it, not marks on it. They take the pointer as the picture does
    // ("background"), so a mark they cover can't be picked up through them.
    case "fill":
      return (
        <KShape
          id={node.id}
          name="background"
          listening={node.listening !== false}
          fill={shape.color}
          sceneFunc={(ctx, self) => {
            traceRegion(ctx, shape.region);
            ctx.fillShape(self);
          }}
        />
      );
    case "patch":
      return (
        <KImage
          id={node.id}
          name="background"
          listening={node.listening !== false}
          x={shape.x}
          y={shape.y}
          width={shape.w}
          height={shape.h}
          image={shape.pixels}
          // Only what it covers: a mark through a free-form patch's clear corners can still be picked.
          hitFunc={(ctx, self) => {
            if (shape.outline) traceRegion(ctx, shape.outline);
            else {
              ctx.beginPath();
              ctx.rect(0, 0, shape.w, shape.h);
            }
            ctx.fillShape(self);
          }}
        />
      );
    case "eraser":
      return <Erased id={node.id} listening={node.listening !== false} shape={shape} image={image} drafting={drafting} />;
  }
}

/** An eraser stroke: the capture as it was, drawn back over everything added before it along the
 *  stroke — white past the capture's edges, where the picture was grown. White there only: under the
 *  capture it would show through the stroke's soft edge as a pale rim. */
function Erased({
  shape,
  image,
  drafting,
  id,
  listening,
}: {
  shape: Extract<Shape, { kind: "eraser" }>;
  image: HTMLImageElement;
  drafting?: boolean;
  id?: string;
  listening?: boolean;
}) {
  const outline = useMemo(() => eraserOutline(shape, !drafting), [shape, drafting]);
  return (
    <KShape
      id={id}
      name="background"
      listening={listening}
      sceneFunc={(ctx) => erase(ctx, outline, image)}
      hitFunc={(ctx, self) => {
        if (outline.length < 3) return;
        traceOutline(ctx, outline);
        ctx.fillShape(self);
      }}
    />
  );
}

/** The edits that change the picture itself, as against marks on it. */
function isPictureEdit(s: Shape): boolean {
  return s.kind === "fill" || s.kind === "patch" || s.kind === "eraser";
}

/** An eraser stroke's outline, as a closed polygon. */
function eraserOutline(shape: Extract<Shape, { kind: "eraser" }>, last: boolean): number[][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i + 1 < shape.points.length; i += 2) pairs.push([shape.points[i], shape.points[i + 1]]);
  return getStroke(pairs, { size: shape.width, thinning: 0, smoothing: 0.5, streamline: 0.35, simulatePressure: false, last });
}

type PathContext = { beginPath(): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; closePath(): void };

function traceOutline(ctx: PathContext, outline: number[][]) {
  ctx.beginPath();
  outline.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
}

/** Draw the capture back inside an eraser stroke's outline, over everything drawn before it: cleared
 *  first, so a mark over a see-through part of the capture goes too; then white past the capture's
 *  edges, where the picture was grown; then the capture. White there only: under the capture it would
 *  show through the stroke's soft edge as a pale rim. On the browser's canvas or Konva's, alike. */
function erase(
  ctx: PathContext & {
    save(): void;
    restore(): void;
    clip(): void;
    rect(x: number, y: number, w: number, h: number): void;
    clearRect(x: number, y: number, w: number, h: number): void;
    fill(rule?: CanvasFillRule): void;
    drawImage(image: CanvasImageSource, x: number, y: number): void;
    fillStyle: string | CanvasGradient | CanvasPattern;
  },
  outline: number[][],
  image: HTMLImageElement,
) {
  if (outline.length < 3) return;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of outline) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  ctx.save();
  traceOutline(ctx, outline);
  ctx.clip();
  ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
  ctx.beginPath();
  ctx.rect(x0, y0, x1 - x0, y1 - y0);
  ctx.rect(0, 0, image.naturalWidth, image.naturalHeight);
  ctx.fillStyle = HOLE;
  ctx.fill("evenodd");
  ctx.drawImage(image, 0, 0);
  ctx.restore();
}

/** The capture with the edits to the picture applied, in order, and no marks: the capture itself when
 *  there are none. The size of the capture; what an edit put past its edges isn't kept. */
function renderPicture(image: HTMLImageElement, edits: Shape[]): CanvasImageSource {
  if (edits.length === 0) return image;
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(image, 0, 0);
  for (const s of edits) {
    if (s.kind === "fill") {
      traceRegion(ctx, s.region);
      ctx.fillStyle = s.color;
      ctx.fill();
    } else if (s.kind === "patch") {
      ctx.drawImage(s.pixels, s.x, s.y, s.w, s.h);
    } else if (s.kind === "eraser") {
      erase(ctx, eraserOutline(s, true), image);
    }
  }
  return canvas;
}

/** An area of the picture on its way somewhere else: white where it was (where it was lifted from the
 *  picture just now), and its pixels where the pointer has it. */
function AreaMoving({ move, region }: { move: AreaMove; region: Region }) {
  const pixels = move.patch ?? move.lifted;
  return (
    <>
      {move.lifted && (
        <KShape
          fill={HOLE}
          sceneFunc={(ctx, self) => {
            traceRegion(ctx, region);
            ctx.fillShape(self);
          }}
        />
      )}
      {pixels && <KImage x={pixels.x + move.dx} y={pixels.y + move.dy} width={pixels.w} height={pixels.h} image={pixels.pixels} />}
    </>
  );
}

/** The selected area's outline: dashes in white over black, so it shows on any picture. */
function AreaOutline({ region, viewScale }: { region: Region; viewScale: number }) {
  const dash = [5 / viewScale, 4 / viewScale];
  const trace = (stroke: string, offset: number) => (
    <KShape
      listening={false}
      stroke={stroke}
      strokeWidth={1 / viewScale}
      dash={dash}
      dashOffset={offset}
      sceneFunc={(ctx, self) => {
        traceRegion(ctx, region);
        ctx.strokeShape(self);
      }}
    />
  );
  return (
    <>
      {trace("black", 0)}
      {trace("white", 4.5 / viewScale)}
    </>
  );
}

/** The part of what is on show past the picture's own edges, filled white. Only that part: a window
 *  capture can have see-through corners of its own. */
function Margin({ frame, width, height }: { frame: Rect; width: number; height: number }) {
  if (frame.x >= 0 && frame.y >= 0 && frame.x + frame.width <= width && frame.y + frame.height <= height) return null;
  return (
    <KShape
      listening={false}
      sceneFunc={(ctx) => {
        ctx.beginPath();
        ctx.rect(frame.x, frame.y, frame.width, frame.height);
        ctx.rect(0, 0, width, height);
        ctx.fillStyle = "#ffffff";
        ctx.fill("evenodd");
      }}
    />
  );
}

/** A region of the picture redrawn in coarse blocks: unreadable, and still obviously "something was
 *  here". Pixelation rather than blur, since a blur of large text can often be read back. */
function Pixelated({
  shape,
  image,
  block,
  ...node
}: { shape: Extract<Shape, { kind: "blur" }>; image: CanvasImageSource; block: number } & NodeProps) {
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

/** Everything on show outside the crop, shaded; dark while cropping, darker once it's set. */
function CropShade({ crop, frame, active, viewScale }: { crop: Rect; frame: Rect; active: boolean; viewScale: number }) {
  return (
    <>
      <KShape
        listening={false}
        sceneFunc={(ctx) => {
          ctx.beginPath();
          ctx.rect(frame.x, frame.y, frame.width, frame.height);
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

/** The crop, draggable and resizable while the crop tool is out; a double-click applies it. */
function CropHandle({ crop, bounds, onChange, onApply }: { crop: Rect; bounds: Rect; onChange(c: Rect): void; onApply(): void }) {
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
        onDblClick={onApply}
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
