import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { Plugin } from "@opencode/plugin";
import {
	applyCatalogue,
	checkoutRoot,
	groupFor,
	loadCatalogue,
	managedPaths,
	relevantGroups,
	searchCatalogue,
	searchInput,
} from "./manager";

export default Plugin.define({
	id: "ai-config.skill-manager",
	async setup(ctx) {
		const checkout = checkoutRoot(
			join(dirname(fileURLToPath(import.meta.url)), ".."),
		);
		const legacyBundle = join(
			process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"),
			"ai-config",
		);
		let catalogue = loadCatalogue(checkout);
		const projectDir = ctx.location.project.directory ?? ctx.location.directory;
		let relevant = relevantGroups(projectDir);
		const ownedPaths = new Set(managedPaths(catalogue, checkout, legacyBundle));
		const skill = await ctx.skill.transform((editor) =>
			applyCatalogue(editor, catalogue, ownedPaths, checkout, relevant),
		);
		const tool = await ctx.tool.transform((editor) => {
			editor.add({
				name: "skill_search",
				description:
					"Search skill metadata by keywords or exact ID, optionally filtered by group (cloudflare, 1password, engineering, frontend, testing, workflow, personal). At most 10 results per page. Metadata is not permission-filtered; use native skill(id) to load under OpenCode permissions.",
				input: searchInput,
				options: { codemode: false },
				execute: async (input) => {
					const current = await ctx.skill.list();
					const managed = new Map(
						catalogue.map((entry) => [String(entry.id), String(entry.path)]),
					);
					return {
						content: JSON.stringify(
							searchCatalogue(
								current.data
									.filter((entry) => managed.get(entry.id) === entry.path)
									.map((entry) => ({
										id: entry.id,
										name: entry.name,
										description: entry.description,
										group: groupFor(checkout, String(entry.path)),
									})),
								input,
							),
						),
					};
				},
			});
		});
		const timer = setInterval(() => {
			try {
				const next = loadCatalogue(checkout);
				const nextRelevant = relevantGroups(projectDir);
				if (
					JSON.stringify(next) === JSON.stringify(catalogue) &&
					JSON.stringify([...nextRelevant].sort()) ===
						JSON.stringify([...relevant].sort())
				)
					return;
				for (const path of managedPaths(next, checkout, legacyBundle))
					ownedPaths.add(path);
				catalogue = next;
				relevant = nextRelevant;
				void ctx.skill
					.reload()
					.catch((error: unknown) =>
						console.error("skill-manager refresh failed", error),
					);
			} catch (error) {
				console.error("skill-manager catalogue refresh failed", error);
			}
		}, 30_000);
		timer.unref();
		return async () => {
			clearInterval(timer);
			await Promise.all([skill.dispose(), tool.dispose()]);
		};
	},
});
