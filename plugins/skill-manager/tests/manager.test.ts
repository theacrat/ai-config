import { afterEach, describe, expect, it } from "vitest";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
	symlinkSync,
	readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Skill } from "@opencode/plugin";
import type { SkillEditor } from "@opencode/plugin/promise/skill";
import {
	applyCatalogue,
	checkoutRoot,
	loadCatalogue,
	managedPaths,
	parseSkill,
	searchCatalogue,
} from "../src/manager";

const temporary: string[] = [];
afterEach(() =>
	temporary
		.splice(0)
		.forEach((path) => rmSync(path, { recursive: true, force: true })),
);
function fixture() {
	const root = mkdtempSync("/tmp/opencode/skill-manager-test-");
	temporary.push(root);
	writeFileSync(join(root, "sources.json"), '{"skills":[]}');
	write(
		root,
		"plugins/skill-manager/skills/skill-discovery/SKILL.md",
		readFileSync(
			new URL("../skills/skill-discovery/SKILL.md", import.meta.url),
			"utf8",
		),
	);
	return root;
}
function write(root: string, path: string, text: string) {
	const full = join(root, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, text);
	return full;
}
function editorFor(initial: readonly Skill.Info[] = []) {
	const values = new Map(initial.map((entry) => [String(entry.id), entry]));
	const editor: SkillEditor = {
		list: () => [...values.values()],
		get: (id) => values.get(id),
		add: (entry) => {
			values.set(entry.id, entry);
		},
		remove: (id) => {
			values.delete(id);
		},
		update: (id, update) => {
			const value = values.get(id);
			if (value) update(value);
		},
	};
	return { editor, values };
}
describe("native catalogue", () => {
	it("advertises only two bootstraps among 150 managed skills, preserving explicit IDs", () => {
		const root = fixture();
		for (let index = 0; index < 150; index++)
			write(
				root,
				`personal/skills/task-${index}/SKILL.md`,
				`---\nname: Task ${index}\ndescription: Useful task\n---\nPrivate body ${index}`,
			);
		write(
			root,
			"personal/skills/thea-mode/SKILL.md",
			"---\ndescription: Start here\n---\nFollow personal guidance",
		);
		const entries = loadCatalogue(root);
		const { editor, values } = editorFor();
		applyCatalogue(
			editor,
			entries,
			new Set(managedPaths(entries, root, join(root, "legacy"))),
		);
		expect(values.size).toBe(152);
		expect(
			[...values.values()]
				.filter((entry) => entry.autoinvoke)
				.map((entry) => entry.id)
				.sort(),
		).toEqual(["skill-discovery", "thea-mode"]);
		expect(values.get("task-100")?.content).toBe("Private body 100");
	});
	it("uses manifest aliases as IDs, keeps display names and original resource bases", () => {
		const root = fixture();
		const file = write(
			root,
			"sources/upstream/short/SKILL.md",
			"---\nname: Friendly display\ndescription: >-\n  Multi-line\n  description\n---\nRead references/rules.md.\n",
		);
		write(root, "sources/upstream/short/references/rules.md", "resource body");
		write(
			root,
			"sources.json",
			JSON.stringify({
				skills: [
					{ name: "long-alias", root: "sources/upstream", path: "short" },
				],
			}),
		);
		const skill = loadCatalogue(root).find(
			(entry) => entry.id === "long-alias",
		);
		expect(skill).toMatchObject({
			id: "long-alias",
			name: "Friendly display",
			description: "Multi-line description",
			path: file,
			content: "Read references/rules.md.\n",
		});
		expect(
			readFileSync(
				join(dirname(skill?.path ?? ""), "references/rules.md"),
				"utf8",
			),
		).toBe("resource body");
	});
	it("preserves external overrides and unrelated entries; retires old managed IDs", () => {
		const root = fixture();
		const project = parseSkill(
			"Project override",
			"/other/.opencode/skills/task/SKILL.md",
			"task",
		);
		const unrelated = {
			...parseSkill(
				"Unrelated",
				"/other/.opencode/skills/other/SKILL.md",
				"other",
			),
			autoinvoke: true,
		};
		const stale = parseSkill(
			"Old managed copy",
			join(root, "old/SKILL.md"),
			"old",
		);
		const { editor, values } = editorFor([project, unrelated, stale]);
		applyCatalogue(
			editor,
			[parseSkill("Managed body", join(root, "task/SKILL.md"), "task")],
			new Set([stale.path, join(root, "task/SKILL.md")]),
		);
		expect([...values.values()]).toEqual([project, unrelated]);
	});
	it("preserves project overrides and unselected files inside the checkout and legacy data", () => {
		const root = fixture();
		const managed = parseSkill(
			"Managed",
			write(root, "plugins/pstack/pstack/skills/task/SKILL.md", "Managed"),
			"task",
		);
		const override = {
			...parseSkill(
				"Project",
				write(root, ".opencode/skills/task/SKILL.md", "Project"),
				"task",
			),
			autoinvoke: true,
		};
		const unrelated = parseSkill(
			"Unselected",
			write(root, "sources/unused/SKILL.md", "Unselected"),
			"unused",
		);
		const data = join(root, "legacy");
		const unrelatedData = parseSkill(
			"Unrelated data",
			write(data, "custom/SKILL.md", "Unrelated data"),
			"data",
		);
		const old = parseSkill(
			"Old copy",
			write(data, "pstack/skills/task/SKILL.md", "Old copy"),
			"old-alias",
		);
		const { editor, values } = editorFor([
			override,
			unrelated,
			unrelatedData,
			old,
		]);
		applyCatalogue(
			editor,
			[managed],
			new Set(managedPaths([managed], root, data)),
		);
		expect([...values.values()]).toEqual([override, unrelated, unrelatedData]);
	});
	it("reads the router body from its real native skill file", () => {
		const root = fixture();
		const router = loadCatalogue(root).find(
			(entry) => entry.id === "skill-discovery",
		);
		expect(router).toBeDefined();
		const disk = readFileSync(router?.path ?? "", "utf8");
		expect(router?.content).toBe(
			parseSkill(disk, router?.path ?? "", "skill-discovery").content,
		);
		expect(router?.content).toContain("native skill(id)");
		writeFileSync(router?.path ?? "", "Updated router instructions");
		expect(
			loadCatalogue(root).find((entry) => entry.id === "skill-discovery")
				?.content,
		).toBe("Updated router instructions");
	});
	it("replays refreshed additions, edits and removals without changing prior snapshots", () => {
		const root = fixture();
		const path = write(root, "personal/skills/first/SKILL.md", "Before");
		const before = loadCatalogue(root);
		writeFileSync(path, "After");
		write(root, "personal/skills/second/SKILL.md", "Second");
		expect(before.find((entry) => entry.id === "first")?.content).toBe(
			"Before",
		);
		expect(
			loadCatalogue(root).find((entry) => entry.id === "first")?.content,
		).toBe("After");
		rmSync(dirname(path), { recursive: true });
		expect(loadCatalogue(root).map((entry) => entry.id)).toEqual([
			"second",
			"skill-discovery",
		]);
	});
	it("honours disabled bootstrap frontmatter and strips CRLF/YAML documents correctly", () => {
		expect(
			parseSkill(
				'---\r\nname: "Thea: mode"\r\nmetadata:\r\n  opencode/autoinvoke: "false"\r\n...\r\nBody\r\n---\r\nRetain separator',
				"/skills/thea-mode/SKILL.md",
				"thea-mode",
			),
		).toMatchObject({
			name: "Thea: mode",
			autoinvoke: false,
			content: "Body\r\n---\r\nRetain separator",
		});
	});
	it("resolves the checkout through the installer's package symlink", () => {
		const root = fixture();
		mkdirSync(join(root, "plugins/skill-manager"), { recursive: true });
		symlinkSync(join(root, "plugins/skill-manager"), join(root, "ai-config"));
		expect(checkoutRoot(join(root, "ai-config"))).toBe(root);
	});
});
describe("metadata search", () => {
	const entries = Array.from({ length: 120 }, (_, index) => ({
		id: `task-${String(index).padStart(3, "0")}`,
		name: "Common task",
		description: "Review TypeScript",
		content: "SECRET",
		path: "/secret",
	}));
	it("paginates deterministically and never returns bodies or paths", () => {
		expect(
			searchCatalogue(entries, { query: "task", offset: 10, limit: 2 }),
		).toEqual([
			{ id: "task-010", name: "Common task", description: "Review TypeScript" },
			{ id: "task-011", name: "Common task", description: "Review TypeScript" },
		]);
		expect(searchCatalogue(entries, { query: "task" })).toHaveLength(10);
		expect(() =>
			searchCatalogue(entries, { query: "task", limit: 11 }),
		).toThrow();
		expect(() => searchCatalogue(entries, { query: " " })).toThrow();
		expect(searchCatalogue(entries, { query: "unknown" })).toEqual([]);
		expect(searchCatalogue(entries, { query: "task", offset: 999 })).toEqual(
			[],
		);
	});
	it("finds exact IDs and keywords with bounded description lengths", () => {
		expect(
			searchCatalogue(entries, { query: "task-101" }).map((entry) => entry.id),
		).toEqual(["task-101"]);
		expect(
			searchCatalogue(entries, { query: "TypeScript review", limit: 1 }),
		).toHaveLength(1);
		expect(
			searchCatalogue(
				[{ id: "long", name: "x".repeat(900), description: "y".repeat(900) }],
				{
					query: "long",
				},
			)[0]?.description,
		).toHaveLength(500);
	});
});
