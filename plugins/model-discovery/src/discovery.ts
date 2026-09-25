import { z } from "zod";

const identifier = z
	.string()
	.min(1)
	.refine((value) => value.trim() === value && !value.includes("#"))
	.refine(
		(value) => !["__proto__", "prototype", "constructor"].includes(value),
	);
const providerIdentifier = identifier.refine((value) => !value.includes("/"));
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const url = z.url().refine((value) => {
	const parsed = new URL(value);
	return (
		["http:", "https:"].includes(parsed.protocol) &&
		!parsed.username &&
		!parsed.password &&
		!parsed.hash
	);
});
const defaults = z
	.object({
		context: positive.default(32768),
		output: positive.default(4096),
		tools: z.boolean().default(true),
	})
	.strict();
const modalities = z.object({
	input: z.array(z.enum(["text", "audio", "image", "video", "pdf"])).optional(),
	output: z
		.array(z.enum(["text", "audio", "image", "video", "pdf"]))
		.optional(),
});
const cost = z.object({
	input: z.number().nonnegative(),
	output: z.number().nonnegative(),
	cache_read: z.number().nonnegative().optional(),
	cache_write: z.number().nonnegative().optional(),
	context_over_200k: z
		.object({
			input: z.number().nonnegative(),
			output: z.number().nonnegative(),
			cache_read: z.number().nonnegative().optional(),
			cache_write: z.number().nonnegative().optional(),
		})
		.optional(),
});

function antigravityName(id: string): string {
	const base = id.replace(/-(thinking|minimal|low|medium|high|max|agent)$/, "");
	return base
		.split(/[-_/]+/)
		.filter(Boolean)
		.map((part) =>
			/^(gpt|gemini|claude|oss)$/i.test(part)
				? part.toUpperCase()
				: `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`,
		)
		.join(" ");
}

function displayName(
	id: string,
	owner: string | undefined,
	name: string | undefined,
): string {
	return name ?? (owner === "antigravity" ? antigravityName(id) : id);
}
const configuredModel = z
	.object({
		id: identifier,
		name: z.string().min(1).optional(),
		context: positive.optional(),
		output: positive.optional(),
		tools: z.boolean().optional(),
		reasoning: z.boolean().optional(),
		modalities: modalities.optional(),
		cost: cost.optional(),
		release_date: z.string().optional(),
		attachment: z.boolean().optional(),
		temperature: z.boolean().optional(),
		status: z.enum(["alpha", "beta", "deprecated", "active"]).optional(),
		reasoning_options: z
			.array(
				z
					.object({ type: z.literal("effort"), values: z.array(identifier) })
					.strict(),
			)
			.optional(),
	})
	.strict();
const source = z
	.object({
		id: providerIdentifier,
		baseURL: url,
		apiKeyEnv: z
			.string()
			.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
			.optional(),
		modelsURL: url.optional(),
		discovery: z.boolean().default(true),
		models: z
			.array(
				z.union([
					identifier.transform((id): z.output<typeof configuredModel> => ({
						id,
					})),
					configuredModel,
				]),
			)
			.refine(
				(models) =>
					new Set(models.map((item) => item.id)).size === models.length,
			)
			.default([]),
		timeoutMs: positive.max(2147483647).default(10000),
		defaults: defaults.prefault({}),
	})
	.strict();
export const optionsSchema = z
	.object({ sources: z.array(source) })
	.strict()
	.refine(
		({ sources }) =>
			new Set(sources.map((item) => item.id)).size === sources.length,
	);
export type Options = z.input<typeof optionsSchema>;
export type Source = z.output<typeof source>;

const model = z.object({
	id: identifier,
	name: z.string().min(1).optional(),
	context_length: positive.optional(),
	max_context_length: positive.optional(),
	max_output_tokens: positive.optional(),
	tool_call: z.boolean().optional(),
	supports_tools: z.boolean().optional(),
	reasoning: z.boolean().optional(),
	modalities: modalities.optional(),
	cost: cost.optional(),
	owned_by: z.string().min(1).optional(),
	created: z.number().int().nonnegative().optional(),
	release_date: z.string().optional(),
	attachment: z.boolean().optional(),
	temperature: z.boolean().optional(),
	status: z.enum(["alpha", "beta", "deprecated", "active"]).optional(),
	reasoning_options: z
		.array(
			z
				.object({ type: z.literal("effort"), values: z.array(identifier) })
				.strict(),
		)
		.optional(),
	supported_reasoning_levels: z
		.array(
			z
				.object({ effort: identifier, description: z.string().optional() })
				.strict(),
		)
		.optional(),
});
const responseSchema = z
	.object({ data: z.array(model) })
	.refine(
		({ data }) => new Set(data.map((item) => item.id)).size === data.length,
	);
export type DiscoveredModel = {
	id: string;
	name: string;
	context?: number;
	output?: number;
	tools?: boolean;
	reasoning?: boolean;
	modalities?: z.output<typeof modalities>;
	cost?: z.output<typeof cost>;
	ownedBy?: string;
	releaseDate?: string;
	attachment?: boolean;
	temperature?: boolean;
	status?: "alpha" | "beta" | "deprecated" | "active";
	reasoningOptions?: ReadonlyArray<{
		type: "effort";
		values: ReadonlyArray<string>;
	}>;
};
export type Inventory = {
	source: Source;
	apiKey: string | undefined;
	models: ReadonlyMap<string, DiscoveredModel>;
};
export type Diagnostic = {
	code:
		| "invalid-options"
		| "missing-api-key"
		| "http-error"
		| "discovery-unavailable"
		| "authentication-error"
		| "empty-catalogue"
		| "invalid-response"
		| "request-failed";
	sourceIndex?: number;
	status?: number;
};
export type Reporter = (diagnostic: Diagnostic) => void;

export const diagnosticMessages: Record<Diagnostic["code"], string> = {
	"invalid-options":
		"Invalid model discovery options. Check the source configuration.",
	"missing-api-key":
		"Model source skipped. Set the configured API key environment variable.",
	"http-error":
		"Model listing returned an HTTP error. Check listing access or configure explicit models.",
	"discovery-unavailable":
		"Model listing is unavailable. Configure explicit models and set discovery: false.",
	"authentication-error":
		"Model listing access was denied. Check listing credentials or configure explicit models if inference is permitted.",
	"empty-catalogue":
		"Model listing returned no models. Configure explicit models and set discovery: false.",
	"invalid-response":
		"Model listing returned an invalid or incomplete response. Check the catalogue format or configure explicit models.",
	"request-failed":
		"Model listing request failed. Check connectivity and timeout settings or configure explicit models.",
};

export async function discover(
	input: unknown,
	report: Reporter,
): Promise<Inventory[]> {
	let options;
	try {
		const explicit = z.record(z.string(), z.unknown()).safeParse(input);
		const fallback =
			input === undefined ||
			(explicit.success && Object.keys(explicit.data).length === 0);
		const value: unknown =
			fallback && process.env.OPENCODE_MODEL_DISCOVERY
				? JSON.parse(process.env.OPENCODE_MODEL_DISCOVERY)
				: input;
		options = optionsSchema.parse(value);
	} catch {
		report({ code: "invalid-options" });
		return [];
	}
	const results = await Promise.all(
		options.sources.map(async (source, sourceIndex) => {
			const apiKey = source.apiKeyEnv
				? process.env[source.apiKeyEnv]
				: undefined;
			if (source.apiKeyEnv && !apiKey) {
				report({ code: "missing-api-key", sourceIndex });
				return;
			}
			const configured = new Map<string, DiscoveredModel>(
				source.models.map((item) => {
					const { reasoning_options, ...metadata } = item;
					return [
						item.id,
						{
							...metadata,
							name: displayName(item.id, undefined, item.name),
							releaseDate: item.release_date,
							...(reasoning_options === undefined
								? {}
								: { reasoningOptions: reasoning_options }),
						},
					];
				}),
			);
			const fallback = {
				source,
				apiKey,
				models: configured,
			} satisfies Inventory;
			if (!source.discovery) return fallback;
			const failed = configured.size ? fallback : undefined;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), source.timeoutMs);
			try {
				const base = new URL(source.baseURL);
				base.pathname = `${base.pathname.replace(/\/$/, "")}/models`;
				const response = await fetch(source.modelsURL ?? base, {
					headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
					signal: controller.signal,
					redirect: "error",
				});
				if (!response.ok) {
					await response.body?.cancel();
					const code = [404, 405, 501].includes(response.status)
						? "discovery-unavailable"
						: [401, 403].includes(response.status)
							? "authentication-error"
							: "http-error";
					report({ code, sourceIndex, status: response.status });
					return failed;
				}
				let data: unknown;
				try {
					data = await response.json();
				} catch {
					report({ code: "invalid-response", sourceIndex });
					return failed;
				}
				const parsed = responseSchema.safeParse(data);
				if (!parsed.success) {
					report({ code: "invalid-response", sourceIndex });
					return failed;
				}
				const models = new Map<string, DiscoveredModel>();
				for (const item of parsed.data.data) {
					const reasoningOptions =
						item.reasoning_options ??
						(item.supported_reasoning_levels
							? [
									{
										type: "effort" as const,
										values: item.supported_reasoning_levels.map(
											(level) => level.effort,
										),
									},
								]
							: undefined);
					models.set(item.id, {
						id: item.id,
						name: displayName(item.id, item.owned_by, item.name),
						context: item.context_length ?? item.max_context_length,
						output: item.max_output_tokens,
						tools: item.tool_call ?? item.supports_tools,
						reasoning: item.reasoning ?? (reasoningOptions ? true : undefined),
						reasoningOptions,
						modalities: item.modalities,
						cost: item.cost,
						ownedBy: item.owned_by,
						releaseDate: item.release_date,
						attachment: item.attachment,
						temperature: item.temperature,
						status: item.status,
					});
				}
				const names = new Map<string, number>();
				for (const model of models.values())
					names.set(model.name, (names.get(model.name) ?? 0) + 1);
				for (const model of models.values()) {
					if ((names.get(model.name) ?? 0) > 1 && model.ownedBy) {
						model.name = `${model.name} (${model.ownedBy})`;
					}
				}
				if (!models.size) report({ code: "empty-catalogue", sourceIndex });
				for (const item of source.models) {
					const discovered = models.get(item.id);
					models.set(item.id, {
						id: item.id,
						name: item.name ?? discovered?.name ?? item.id,
						context: item.context ?? discovered?.context,
						output: item.output ?? discovered?.output,
						tools: item.tools ?? discovered?.tools,
						reasoning: item.reasoning ?? discovered?.reasoning,
						modalities:
							item.modalities || discovered?.modalities
								? { ...discovered?.modalities, ...item.modalities }
								: undefined,
						cost: item.cost ?? discovered?.cost,
						ownedBy: discovered?.ownedBy,
						releaseDate: item.release_date ?? discovered?.releaseDate,
						attachment: item.attachment ?? discovered?.attachment,
						temperature: item.temperature ?? discovered?.temperature,
						status: item.status ?? discovered?.status,
						reasoningOptions: item.reasoning_options
							? item.reasoning_options
							: discovered?.reasoningOptions,
					});
				}
				return { source, apiKey, models } satisfies Inventory;
			} catch {
				report({ code: "request-failed", sourceIndex });
				return failed;
			} finally {
				clearTimeout(timer);
			}
		}),
	);
	return results.filter((item) => item !== undefined);
}
