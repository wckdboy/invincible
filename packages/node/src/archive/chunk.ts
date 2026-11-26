/*
 * Chunking: each entry becomes passages a search can find and a model can read, cut
 * along the lines its kind has. Prose by paragraph (headings start a new passage), code
 * by top-level function or class (or file section), a chat by exchange, data by a
 * sample of its head. Every passage carries the entry's title in front, so a passage
 * that says "it" still says what it's about.
 */

export interface Chunk {
  /** "description", or the file's path. */
  origin: string;
  text: string;
}

/** About 300 tokens: small enough to be specific, big enough to carry a thought. */
export const CHUNK_TARGET = 1200;
const CHUNK_MAX = 2000;
/** What one file may add to the index (the rest of a huge log isn't worth embedding). */
export const FILE_INDEX_BYTES = 200 * 1024;
const MAX_CHUNKS_PER_ENTRY = 400;

const CODE = new Set([".py", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".rs", ".go", ".c", ".h", ".cc", ".cpp", ".hpp", ".java", ".kt", ".swift", ".jl", ".m", ".r", ".rb", ".sh", ".bash", ".zsh", ".ps1", ".lua", ".scad", ".f90", ".f", ".geo", ".cir", ".sql", ".cs", ".php", ".toml", ".yaml", ".yml", ".ini", ".cfg"]);
const PROSE = new Set([".md", ".markdown", ".txt", ".rst", ".tex", ".org", ".adoc", ".log", ".out", ""]);
const DATA = new Set([".csv", ".tsv", ".json", ".jsonl", ".dat", ".xml", ".urdf", ".sdf", ".mjcf", ".xacro", ".world", ".obj", ".stp", ".step", ".gltf", ".svg", ".html", ".htm", ".mtl", ".ply"]);

export const extOf = (path: string): string => {
  const name = path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
};

/** Whether a file's bytes are text worth reading: UTF-8, no NULs in its head. */
export function asText(bytes: Uint8Array): string | null {
  const head = bytes.subarray(0, 8192);
  for (let i = 0; i < head.length; i++) if (head[i] === 0) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, FILE_INDEX_BYTES));
  } catch {
    // Cut mid-character at the limit: decode what's whole.
    try {
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, FILE_INDEX_BYTES));
    } catch {
      return null;
    }
  }
}

/** A Jupyter notebook's words and code, without its outputs (which can be anything, base64 images included). */
export function notebookText(text: string): string | null {
  try {
    const nb = JSON.parse(text) as { cells?: { cell_type?: string; source?: string | string[] }[] };
    if (!Array.isArray(nb.cells)) return null;
    return nb.cells
      .map((c) => {
        const source = (Array.isArray(c.source) ? c.source.join("") : String(c.source ?? "")).trim();
        return c.cell_type === "code" ? `# [code cell]\n${source}` : source;
      })
      .filter((s) => s.trim())
      .join("\n\n");
  } catch {
    return null;
  }
}

/** Collapse runs of blank lines and trailing spaces; never more than the passage limit per line. */
const tidy = (text: string): string =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** Pieces into passages of about the target size, never splitting a piece unless it alone is too long. */
function pack(pieces: string[], target = CHUNK_TARGET): string[] {
  const out: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) out.push(current.trim());
    current = "";
  };
  for (const raw of pieces) {
    const piece = raw.trim();
    if (!piece) continue;
    if (piece.length > CHUNK_MAX) {
      flush();
      out.push(...hardSplit(piece));
      continue;
    }
    if (current && current.length + piece.length + 2 > target) flush();
    current = current ? `${current}\n\n${piece}` : piece;
  }
  flush();
  return out;
}

/** A piece with no natural breaks: by lines, then by length, with a little overlap. */
function hardSplit(text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (line.length > CHUNK_MAX) {
      if (current.length) out.push(current.join("\n"));
      current = [];
      size = 0;
      for (let i = 0; i < line.length; i += CHUNK_TARGET) out.push(line.slice(Math.max(0, i - 100), i + CHUNK_TARGET));
      continue;
    }
    if (size + line.length > CHUNK_TARGET && current.length) {
      out.push(current.join("\n"));
      // The last two lines again: a passage that starts mid-thought keeps its context.
      current = current.slice(-2);
      size = current.reduce((n, l) => n + l.length + 1, 0);
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length) out.push(current.join("\n"));
  return out.filter((s) => s.trim());
}

/** Prose: paragraphs, with every Markdown heading starting a new passage. */
export function chunkProse(text: string): string[] {
  const sections = tidy(text).split(/\n(?=#{1,6} )/);
  return sections.flatMap((section) => pack(section.split(/\n\s*\n/)));
}

/** Code: top-level definitions (Python, JS/TS, Rust, Go, C-like, Julia, shell functions), else sections of lines. */
export function chunkCode(text: string): string[] {
  const lines = tidy(text).split("\n");
  const starts: number[] = [0];
  const top = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:def |class |function |fn |pub fn |pub struct |struct |enum |impl |interface |type \w+\s*=|const \w+\s*=\s*(?:async\s*)?\(|func |module |@\w+|[A-Za-z_][\w:<>,\s*&]*\s+\**[A-Za-z_]\w*\s*\([^;]*\)\s*\{?\s*$|\w+\s*\(\)\s*\{)/;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    // A decorator belongs with what follows it.
    if (top.test(line) && !(lines[i - 1] ?? "").startsWith("@")) starts.push(i);
  }
  const pieces = starts.map((s, i) => lines.slice(s, starts[i + 1] ?? lines.length).join("\n"));
  return pack(pieces);
}

/** Data: what it is, from its head. A CSV's header and first rows say more than its millionth row. */
export function chunkData(text: string): string[] {
  // One passage: what it is, not all of it.
  return [tidy(text).slice(0, CHUNK_TARGET + 600)].filter(Boolean);
}

/** A chat as it's archived: each message on its own, "You: …" or "Galahad: …", a blank line between. */
export const transcript = (messages: { role: "user" | "assistant"; content: string }[]): string =>
  messages.map((m) => `${m.role === "user" ? "You" : "Galahad"}: ${m.content.trim()}`).join("\n\n");

/** A chat: one passage per exchange (your question and the answer), split if long. */
export function chunkChat(text: string): string[] {
  const exchanges = tidy(text).split(/\n\n(?=You: )/);
  return exchanges.flatMap((e) => (e.length > CHUNK_MAX ? hardSplit(e) : [e])).filter((e) => e.trim());
}

export type FileTextKind = "code" | "prose" | "data" | "notebook";

export function fileTextKind(path: string): FileTextKind | null {
  const ext = extOf(path);
  if (ext === ".ipynb") return "notebook";
  if (CODE.has(ext)) return "code";
  if (DATA.has(ext)) return "data";
  if (PROSE.has(ext)) return "prose";
  return null;
}

export interface ChunkInput {
  kind: string;
  title: string;
  description: string;
  /** Text files, already read and scrubbed. */
  files: { path: string; text: string }[];
}

/** Every passage of an entry, in order, each headed by the entry's title (and the file's path). */
export function chunkEntry(input: ChunkInput): Chunk[] {
  const out: Chunk[] = [];
  const head = (origin: string) => (origin === "description" ? `${input.title}\n` : `${input.title} · ${origin}\n`);
  const add = (origin: string, texts: string[]) => {
    for (const text of texts) if (out.length < MAX_CHUNKS_PER_ENTRY) out.push({ origin, text: `${head(origin)}${text}` });
  };
  if (input.description.trim()) add("description", input.kind === "chat" ? chunkChat(input.description) : chunkProse(input.description));
  for (const file of input.files) {
    const kind = fileTextKind(file.path);
    if (!kind || !file.text.trim()) continue;
    const text = kind === "notebook" ? notebookText(file.text) : file.text;
    if (!text) continue;
    add(file.path, kind === "code" || kind === "notebook" ? chunkCode(text) : kind === "data" ? chunkData(text) : chunkProse(text));
  }
  // An entry with nothing else still has its title.
  if (!out.length) out.push({ origin: "description", text: input.title });
  return out;
}

// ---- Model files: what's known about them ---------------------------------------

const MODEL_EXT: Record<string, string> = {
  ".stl": "STL mesh",
  ".obj": "OBJ mesh",
  ".ply": "PLY mesh",
  ".glb": "glTF binary",
  ".gltf": "glTF",
  ".step": "STEP (CAD)",
  ".stp": "STEP (CAD)",
  ".iges": "IGES (CAD)",
  ".igs": "IGES (CAD)",
  ".brep": "OpenCascade BREP",
  ".3mf": "3MF",
  ".dae": "COLLADA",
  ".fbx": "FBX",
  ".urdf": "URDF robot",
  ".xacro": "URDF (xacro)",
  ".sdf": "SDF (Gazebo)",
  ".world": "SDF world (Gazebo)",
  ".mjcf": "MJCF (MuJoCo)",
  ".scad": "OpenSCAD",
  ".fcstd": "FreeCAD",
  ".f3d": "Fusion 360",
  ".sldprt": "SolidWorks part",
  ".blend": "Blender",
  ".msh": "gmsh mesh",
  ".geo": "gmsh geometry",
  ".vtk": "VTK",
  ".vtu": "VTK",
  ".xdmf": "XDMF",
  ".ipynb": "Jupyter notebook",
};

/** Whether a file could be a model (worth reading to find out). */
export const mightBeModel = (path: string): boolean => {
  const ext = extOf(path);
  return ext in MODEL_EXT || ext === ".py" || ext === ".jl" || ext === ".xml";
};

/** Libraries whose use marks a script as one that builds a model. */
const BUILDERS = /\b(?:import|from)\s+(build123d|cadquery|gmsh|trimesh|pyvista|OCP|OCC|FreeCAD|mujoco|pybullet|openscad|solid2|sdf|numpy-stl|stl|meshio|bpy|dolfinx|ufl|pygmsh|madcad)\b/;

export interface ModelFacts {
  format: string;
  facts: string[];
}

/** Whether a file is a model (CAD, a mesh, a robot, a notebook, a script that builds one), and what's known about it. */
export function modelFacts(path: string, bytes: Uint8Array, text: string | null): ModelFacts | null {
  const ext = extOf(path);
  let format = MODEL_EXT[ext];
  if (!format && (ext === ".py" || ext === ".jl") && text) {
    const lib = text.match(BUILDERS)?.[1];
    if (lib) format = `script that builds a model (${lib})`;
  }
  if (!format && ext === ".xml" && text && /<mujoco[\s>]/.test(text)) format = "MJCF (MuJoCo)";
  if (!format) return null;
  const facts: string[] = [`${format}, ${bytes.length} bytes`];
  try {
    if (ext === ".stl") facts.push(...stlFacts(bytes, text));
    else if (ext === ".obj" && text) {
      const v = (text.match(/^v\s/gm) ?? []).length;
      const f = (text.match(/^f\s/gm) ?? []).length;
      facts.push(`${v} vertices, ${f} faces`);
    } else if ((ext === ".urdf" || ext === ".xacro" || ext === ".sdf" || ext === ".world") && text) {
      const robot = text.match(/<(?:robot|model)\s+name="([^"]{1,80})"/)?.[1];
      const links = [...text.matchAll(/<link\s+name="([^"]{1,60})"/g)].map((m) => m[1]!);
      const joints = [...text.matchAll(/<joint\s+name="([^"]{1,60})"\s+type="([^"]{1,20})"/g)].map((m) => `${m[1]} (${m[2]})`);
      if (robot) facts.push(`named ${robot}`);
      if (links.length) facts.push(`${links.length} links: ${links.slice(0, 12).join(", ")}${links.length > 12 ? ", …" : ""}`);
      if (joints.length) facts.push(`${joints.length} joints: ${joints.slice(0, 12).join(", ")}${joints.length > 12 ? ", …" : ""}`);
    } else if ((ext === ".mjcf" || ext === ".xml") && text) {
      const model = text.match(/<mujoco\s+model="([^"]{1,80})"/)?.[1];
      const bodies = [...text.matchAll(/<body\s+[^>]*name="([^"]{1,60})"/g)].map((m) => m[1]!);
      if (model) facts.push(`named ${model}`);
      if (bodies.length) facts.push(`${bodies.length} bodies: ${bodies.slice(0, 12).join(", ")}${bodies.length > 12 ? ", …" : ""}`);
    } else if ((ext === ".step" || ext === ".stp") && text) {
      const products = [...text.matchAll(/PRODUCT\s*\(\s*'([^']{1,80})'/g)].map((m) => m[1]!);
      const schema = text.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']{1,80})'/)?.[1];
      if (schema) facts.push(`schema ${schema}`);
      if (products.length) facts.push(`products: ${[...new Set(products)].slice(0, 8).join(", ")}`);
    } else if (ext === ".gltf" && text) {
      const json = JSON.parse(text) as { meshes?: unknown[]; nodes?: unknown[]; materials?: unknown[] };
      facts.push(`${json.meshes?.length ?? 0} meshes, ${json.nodes?.length ?? 0} nodes, ${json.materials?.length ?? 0} materials`);
    } else if (ext === ".glb" && bytes.length >= 20) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (view.getUint32(0, true) === 0x46546c67) {
        const jsonLength = view.getUint32(12, true);
        const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + Math.min(jsonLength, 4 * 2 ** 20)))) as { meshes?: unknown[]; nodes?: unknown[] };
        facts.push(`${json.meshes?.length ?? 0} meshes, ${json.nodes?.length ?? 0} nodes`);
      }
    } else if (ext === ".ipynb" && text) {
      const nb = JSON.parse(text) as { cells?: { cell_type?: string }[] };
      const cells = nb.cells ?? [];
      facts.push(`${cells.length} cells (${cells.filter((c) => c.cell_type === "code").length} code)`);
    } else if (text && /^(script|MJCF)/.test(format)) {
      const imports = [...new Set([...text.matchAll(/^\s*(?:import|from)\s+([A-Za-z_][\w.]*)/gm)].map((m) => m[1]!.split(".")[0]!))];
      if (imports.length) facts.push(`imports ${imports.slice(0, 12).join(", ")}`);
    }
  } catch {
    /* what's known stays what the format says */
  }
  return { format, facts };
}

/** An STL's triangle count and bounding box (binary or ASCII). */
function stlFacts(bytes: Uint8Array, text: string | null): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const binary = bytes.length >= 84 && 84 + view.getUint32(80, true) * 50 === bytes.length;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const see = (x: number, y: number, z: number) => {
    [x, y, z].forEach((c, i) => {
      if (Number.isFinite(c)) {
        min[i] = Math.min(min[i]!, c);
        max[i] = Math.max(max[i]!, c);
      }
    });
  };
  let triangles = 0;
  if (binary) {
    triangles = view.getUint32(80, true);
    for (let t = 0; t < Math.min(triangles, 2_000_000); t++) {
      const base = 84 + t * 50 + 12;
      for (let v = 0; v < 3; v++) see(view.getFloat32(base + v * 12, true), view.getFloat32(base + v * 12 + 4, true), view.getFloat32(base + v * 12 + 8, true));
    }
  } else if (text) {
    triangles = (text.match(/\bfacet\b/g) ?? []).length;
    for (const m of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) see(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  const facts = [`${triangles} triangles (${binary ? "binary" : "ASCII"})`];
  if (Number.isFinite(min[0]!)) {
    const size = max.map((m, i) => +(m - min[i]!).toPrecision(4));
    facts.push(`bounding box ${size.join(" × ")} (units as drawn)`);
  }
  return facts;
}
