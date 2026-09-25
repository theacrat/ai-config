import { Model, Provider } from "@opencode/plugin";
import type { Plugin } from "@opencode/plugin";
import type { ProviderEditor } from "@opencode/plugin/promise/provider";
import { diagnosticMessages, discover } from "./discovery";
import type { DiscoveredModel, Inventory } from "./discovery";

function modelCosts(cost: DiscoveredModel["cost"]): Model.Info["cost"] {
	if (!cost) return [];
	const rate = Model.Cost.fields.input.make;
	const base = {
		input: rate(cost.input),
		output: rate(cost.output),
		cache: {
			read: rate(cost.cache_read ?? 0),
			write: rate(cost.cache_write ?? 0),
		},
	};
	const tier = cost.context_over_200k;
	return tier
		? [
				base,
				{
					tier: { type: "context", size: 200000 },
					input: rate(tier.input),
					output: rate(tier.output),
					cache: {
						read: rate(tier.cache_read ?? 0),
						write: rate(tier.cache_write ?? 0),
					},
				},
			]
		: [base];
}

function mergeVariants(
	discovered: Model.Info["variants"],
	existing: Model.Info["variants"],
): Model.Info["variants"] {
	const variants = new Map(discovered.map((variant) => [variant.id, variant]));
	for (const variant of existing) variants.set(variant.id, variant);
	return [...variants.values()];
}

export function applyProviders(
	editor: ProviderEditor,
	inventories: readonly Inventory[],
): void {
	for (const { source, apiKey, models } of inventories) {
		const id = Provider.ID.make(source.id);
		const existing = editor.get(id);
		const merged = new Map<string, Model.Info>();
		for (const model of models.values()) {
			const initial = Model.Info.default(id, Model.ID.make(model.id));
			const released =
				model.releaseDate === undefined ? NaN : Date.parse(model.releaseDate);
			const variants =
				model.reasoningOptions?.flatMap((option) =>
					option.type === "effort"
						? option.values.map((value) => ({
								id: Model.VariantID.make(value),
								settings: { reasoningEffort: value },
							}))
						: [],
				) ?? [];
			merged.set(model.id, {
				...initial,
				enabled: true,
				name: model.name,
				cost: modelCosts(model.cost),
				time: Number.isFinite(released) ? { released } : initial.time,
				status: model.status ?? initial.status,
				variants,
				capabilities: {
					input: model.modalities?.input ?? ["text"],
					output: model.modalities?.output ?? ["text"],
					tools: model.tools ?? source.defaults.tools,
				},
				limit: {
					context: model.context ?? source.defaults.context,
					output: model.output ?? source.defaults.output,
				},
			});
		}
		for (const [key, model] of existing?.models ?? []) {
			const discovered = merged.get(key);
			merged.set(
				key,
				discovered
					? {
							...discovered,
							...model,
							variants: mergeVariants(discovered.variants, model.variants),
						}
					: model,
			);
		}
		const settings = {
			baseURL: source.baseURL,
			...(apiKey ? { apiKey } : {}),
			...existing?.provider.settings,
		};
		if (existing) {
			editor.update(id, (provider) => {
				provider.settings = settings;
			});
			editor.models.set(id, [...merged.values()]);
		} else {
			editor.add({
				info: {
					...Provider.Info.empty(id),
					name: source.id,
					activation: "enabled",
					package: "@opencode/ai/providers/openai-compatible",
					settings,
				},
				models: [...merged.values()],
			});
		}
	}
}

export async function setup(
	ctx: Pick<Plugin.Context, "options"> & {
		provider: Pick<Plugin.Context["provider"], "transform">;
	},
): Promise<Plugin.Cleanup> {
	const inventories = await discover(ctx.options, (diagnostic) => {
		console.warn(
			JSON.stringify({
				service: "model-discovery",
				message: diagnosticMessages[diagnostic.code],
				...diagnostic,
			}),
		);
	});
	const registration = await ctx.provider.transform((editor) =>
		applyProviders(editor, inventories),
	);
	return () => registration.dispose();
}
