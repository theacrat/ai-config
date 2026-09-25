import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Skill } from "@opencode/plugin";
import type { SkillEditor } from "@opencode/plugin/promise/skill";
import { parse } from "yaml";
import { z } from "zod";

const manifestSchema = z.object({
  skills: z.array(z.object({ name: z.string().min(1), path: z.string(), root: z.string() })),
});
const frontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export const searchInput = z.object({
  query: z.string().trim().min(1).max(200),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(10).default(10),
});
export interface Metadata {
  id: string;
  name: string;
  description?: string;
}

export function checkoutRoot(packageDirectory: string): string {
  return resolve(realpathSync(packageDirectory), "../..");
}

export function parseSkill(markdown: string, path: string, id: string): Skill.Info {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(
    markdown,
  );
  const data = frontmatterSchema.parse(match ? (parse(match[1] ?? "") ?? {}) : {});
  const flag = data.metadata?.["opencode/autoinvoke"];
  const disabled = flag === false || flag === "false";
  return {
    id: Skill.ID.make(id),
    name: Skill.Name.make(data.name ?? id),
    description: data.description,
    path: Skill.Info.fields.path.make(resolve(path)),
    content: match ? markdown.slice(match[0].length) : markdown,
    autoinvoke: id === "thea-mode" && !disabled,
  };
}

function files(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return files(path);
      return entry.isFile() && entry.name === "SKILL.md" ? [path] : [];
    });
}

export function loadCatalogue(checkout: string): readonly Skill.Info[] {
  const manifest = manifestSchema.parse(
    JSON.parse(readFileSync(join(checkout, "sources.json"), "utf8")),
  );
  const selected = manifest.skills.map((entry) => ({
    id: entry.name,
    path: resolve(checkout, entry.root, entry.path, "SKILL.md"),
  }));
  const roots = [
    "plugins/pstack/pstack/skills",
    "plugins/1password/skills",
    "plugins/cloudflare/skills",
    "personal/skills",
  ];
  const all = [
    ...selected,
    ...roots.flatMap((root) =>
      files(join(checkout, root)).map((path) => ({ id: basename(dirname(path)), path })),
    ),
  ];
  const entries = new Map<string, Skill.Info>();
  for (const { id, path } of all)
    entries.set(id, parseSkill(readFileSync(path, "utf8"), realpathSync(path), id));
  const routerPath = join(checkout, "plugins/skill-manager/skills/skill-discovery/SKILL.md");
  const router = parseSkill(
    readFileSync(routerPath, "utf8"),
    realpathSync(routerPath),
    "skill-discovery",
  );
  entries.set("skill-discovery", { ...router, autoinvoke: true });
  return [...entries.values()];
}

function canonicalPath(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

export function managedPaths(
  entries: readonly Skill.Info[],
  checkout: string,
  legacyBundle: string,
): readonly string[] {
  const pstack = join(checkout, "plugins/pstack/pstack/skills") + sep;
  return entries.flatMap((entry) => {
    const path = canonicalPath(entry.path);
    return path.startsWith(pstack)
      ? [path, canonicalPath(join(legacyBundle, "pstack/skills", path.slice(pstack.length)))]
      : [path];
  });
}

export function applyCatalogue(
  editor: SkillEditor,
  entries: readonly Skill.Info[],
  ownedPaths: ReadonlySet<string>,
): void {
  for (const existing of editor.list()) {
    if (ownedPaths.has(canonicalPath(String(existing.path)))) editor.remove(String(existing.id));
  }
  for (const entry of entries) {
    if (!editor.get(entry.id)) editor.add(entry);
  }
}

export function searchCatalogue(entries: readonly Metadata[], raw: unknown): Metadata[] {
  const input = searchInput.parse(raw);
  const terms = input.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return entries
    .filter((entry) =>
      terms.every((term) =>
        `${entry.id} ${entry.name} ${entry.description ?? ""}`.toLowerCase().includes(term),
      ),
    )
    .sort(
      (a, b) =>
        Number(b.id === input.query) - Number(a.id === input.query) || a.id.localeCompare(b.id),
    )
    .slice(input.offset, input.offset + input.limit)
    .map(({ id, name, description }) => ({
      id,
      name: name.slice(0, 120),
      description: (description ?? "").slice(0, 500),
    }));
}
