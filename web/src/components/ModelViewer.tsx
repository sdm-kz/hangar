import { useEffect, useRef, useState } from "react";
import { Grid3x3, Loader2, RotateCcw } from "lucide-react";
import type * as THREE from "three";
import { MAX_MODEL_PREVIEW, fileExt } from "@/lib/fileKind";
import { getTheme, subscribeTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

type Status = "loading" | "error" | "toolarge" | "ready";

interface Stats {
  /** Width × depth × height, in the file's units (millimetres, for anything headed to a printer). */
  size: [number, number, number];
  triangles: number;
}

/** What the mounted scene lets the overlay do to it. */
interface View {
  reset(): void;
  setWireframe(on: boolean): void;
  dispose(): void;
}

/**
 * Read-only inline viewer for 3D models (.stl, .3mf): drag to orbit, right-drag or two fingers to pan,
 * wheel or pinch to zoom. Fetches the file's raw bytes from `url` and renders them with three.js, which
 * is loaded on demand (dynamic import) so it stays out of the main bundle. The source is just a URL, so
 * this serves both the per-session browser and the server-wide Files panel, like the OfficeViewer.
 */
export function ModelViewer({ url, name }: { url: string; name: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<View | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [stats, setStats] = useState<Stats | null>(null);
  const [wireframe, setWireframe] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    setStatus("loading");
    setStats(null);
    (async () => {
      try {
        const [buffer, three] = await Promise.all([fetchBytes(url, ctrl.signal), loadThree()]);
        if (ctrl.signal.aborted || !hostRef.current) return;
        const object = parse(three, buffer, fileExt(name));
        const { view, stats } = mount(three, hostRef.current, object);
        viewRef.current = view;
        setStats(stats);
        setStatus("ready");
      } catch (e) {
        if (!ctrl.signal.aborted) setStatus(e instanceof Error && e.message === TOO_LARGE ? "toolarge" : "error");
      }
    })();
    return () => {
      ctrl.abort();
      viewRef.current?.dispose();
      viewRef.current = null;
    };
  }, [url, name]);

  useEffect(() => viewRef.current?.setWireframe(wireframe), [wireframe, status]);

  return (
    <div className="relative h-full overflow-hidden bg-neutral-100 dark:bg-neutral-900">
      {status === "loading" && <Centered><Loader2 className="size-4 animate-spin" /> Loading model…</Centered>}
      {status === "toolarge" && <Centered>This model is too large to preview.</Centered>}
      {status === "error" && <Centered className="text-destructive">Failed to render model.</Centered>}
      {status === "ready" && (
        <div className="absolute right-3 top-3 z-10 flex items-center gap-0.5 rounded-md border bg-background/90 p-0.5 shadow-sm backdrop-blur">
          <button
            title={wireframe ? "Show solid" : "Show wireframe"}
            aria-pressed={wireframe}
            onClick={() => setWireframe((w) => !w)}
            className={cn(
              "flex size-6 items-center justify-center rounded hover:bg-accent",
              wireframe ? "text-foreground" : "text-muted-foreground"
            )}
          >
            <Grid3x3 className="size-4" />
          </button>
          <button
            title="Reset view"
            onClick={() => viewRef.current?.reset()}
            className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RotateCcw className="size-4" />
          </button>
        </div>
      )}
      {status === "ready" && stats && (
        <div className="pointer-events-none absolute bottom-3 left-3 z-10 rounded-md border bg-background/90 px-2 py-1 font-mono text-[11px] text-muted-foreground shadow-sm backdrop-blur">
          {stats.size.map(formatLength).join(" × ")} mm · {stats.triangles.toLocaleString()} triangles
        </div>
      )}
      {/* The canvas goes in here once the model is parsed; kept mounted so the effect can find it. */}
      <div ref={hostRef} className={cn("h-full w-full", status !== "ready" && "hidden")} />
    </div>
  );
}

// Thrown when the response is bigger than we're willing to parse in the browser.
const TOO_LARGE = "toolarge";

// Fetch the file's raw bytes (the URL carries auth in its query, same as the image previews), bailing
// out on oversized files before buffering them when the server says how big they are.
async function fetchBytes(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(res.statusText);
  if (Number(res.headers.get("content-length")) > MAX_MODEL_PREVIEW) throw new Error(TOO_LARGE);
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength > MAX_MODEL_PREVIEW) throw new Error(TOO_LARGE);
  return buffer;
}

async function loadThree() {
  const [THREE, { STLLoader }, { ThreeMFLoader }, { OrbitControls }] = await Promise.all([
    import("three"),
    import("three/addons/loaders/STLLoader.js"),
    import("three/addons/loaders/3MFLoader.js"),
    import("three/addons/controls/OrbitControls.js"),
  ]);
  return { THREE, STLLoader, ThreeMFLoader, OrbitControls };
}

type Three = Awaited<ReturnType<typeof loadThree>>;

// An STL carries no colour of its own (bar the rare per-face one), so it gets a neutral one that reads
// against both themes' backgrounds. A 3MF brings its materials when it has any.
const MODEL_COLOR = 0x8ea2c0;

function parse({ THREE, STLLoader, ThreeMFLoader }: Three, buffer: ArrayBuffer, ext: string): THREE.Object3D {
  if (ext === "3mf") {
    const group = new ThreeMFLoader().parse(buffer);
    // Slicers keep filament colours in their own settings, not as 3MF materials, so their files come back
    // in the loader's stand-in white, which the lights wash out. Only that stand-in is recoloured.
    group.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      for (const m of [o.material].flat())
        if (m.name === THREE.Loader.DEFAULT_MATERIAL_NAME && m instanceof THREE.MeshPhongMaterial) m.color.setHex(MODEL_COLOR);
    });
    return group;
  }
  const geometry = new STLLoader().parse(buffer);
  const colored = geometry.hasAttribute("color");
  const material = new THREE.MeshStandardMaterial({
    color: colored ? 0xffffff : MODEL_COLOR,
    vertexColors: colored,
    roughness: 0.6,
    metalness: 0.05,
  });
  return new THREE.Mesh(geometry, material);
}

/** Put `object` on a grid in a canvas inside `host`, with the camera framing it. */
function mount({ THREE, OrbitControls }: Three, host: HTMLElement, object: THREE.Object3D): { view: View; stats: Stats } {
  // Slicers and CAD work Z-up; three.js is Y-up. Turn the model over, then stand it on the grid at the
  // origin: the box is measured with the rotation alone, so the offset is in world axes.
  object.rotation.x = -Math.PI / 2;
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) throw new Error("The model has no geometry.");
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  object.position.set(-center.x, -box.min.y, -center.z);

  let triangles = 0;
  object.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const g = o.geometry as THREE.BufferGeometry;
    triangles += (g.index ? g.index.count : g.getAttribute("position").count) / 3;
  });

  const scene = new THREE.Scene();
  scene.add(object);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8c8c8c, 1.6));

  const radius = Math.max(size.length() / 2, 1e-6);
  const camera = new THREE.PerspectiveCamera(40, 1, radius / 100, radius * 100);
  // A key light that rides with the camera, so whichever side you orbit to is the lit one.
  const key = new THREE.DirectionalLight(0xffffff, 2);
  key.position.set(1, 1, 0);
  key.target.position.set(0, 0, -1);
  camera.add(key, key.target);
  scene.add(camera);

  // Front-right and a little above, far enough back for the bounding sphere to fit the frame.
  const target = new THREE.Vector3(0, size.y / 2, 0);
  const distance = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.05;
  const home = new THREE.Vector3(0.6, 0.55, 1).normalize().multiplyScalar(distance).add(target);
  camera.position.copy(home);

  // A floor grid in round steps, about ten cells across the footprint. Sunk a hair below the model so
  // its bottom face doesn't flicker against the lines.
  const extent = Math.max(size.x, size.z) * 1.6;
  const step = niceStep(extent / 10);
  const cells = Math.ceil(extent / step / 2) * 2;
  let grid: THREE.GridHelper | undefined;
  const placeGrid = (theme: Theme) => {
    if (grid) {
      scene.remove(grid);
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
    }
    grid = theme === "dark" ? new THREE.GridHelper(cells * step, cells, 0x5c5c5c, 0x363636)
                            : new THREE.GridHelper(cells * step, cells, 0xa8a8a8, 0xd4d4d4);
    grid.position.y = -radius / 500;
    scene.add(grid);
  };
  placeGrid(getTheme());

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.domElement.className = "block h-full w-full outline-none";
  host.replaceChildren(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.copy(target);
  controls.update();

  // Draw only when something moved: an idle model costs nothing but the loop's own tick.
  let dirty = true;
  controls.addEventListener("change", () => (dirty = true));
  renderer.setAnimationLoop(() => {
    controls.update();
    if (!dirty) return;
    dirty = false;
    renderer.render(scene, camera);
  });

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = host;
    if (!w || !h) return; // a hidden tab: keep the last size until it shows again
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    dirty = true;
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

  const unsubscribeTheme = subscribeTheme((theme) => {
    placeGrid(theme);
    dirty = true;
  });

  const materials = () => {
    const all = new Set<THREE.Material>();
    object.traverse((o) => {
      if (o instanceof THREE.Mesh) for (const m of [o.material].flat() as THREE.Material[]) all.add(m);
    });
    return all;
  };

  const view: View = {
    reset() {
      camera.position.copy(home);
      controls.target.copy(target);
      controls.update();
      dirty = true;
    },
    setWireframe(on) {
      for (const m of materials()) (m as THREE.MeshStandardMaterial).wireframe = on;
      dirty = true;
    },
    dispose() {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      unsubscribeTheme();
      controls.dispose();
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) o.geometry.dispose();
      });
      for (const m of materials()) {
        for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
        m.dispose();
      }
      if (grid) (grid.material as THREE.Material).dispose();
      renderer.dispose();
      // Browsers cap live WebGL contexts at a dozen or so; give this one back now rather than at GC.
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
  return { view, stats: { size: [size.x, size.z, size.y], triangles: Math.round(triangles) } };
}

// The 1-2-5 step at or above `raw`: 1, 2, 5, 10, 20, 50…
function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw));
  return raw <= p ? p : raw <= 2 * p ? 2 * p : raw <= 5 * p ? 5 * p : 10 * p;
}

function formatLength(n: number): string {
  return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
}

function Centered({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-full items-center justify-center gap-2 p-4 text-sm text-muted-foreground", className)}>
      {children}
    </div>
  );
}
