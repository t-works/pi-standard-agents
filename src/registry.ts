/**
 * A workflow spec (JSON) becomes a `Registry` the runtime accepts.
 *
 * Nothing here reads the filesystem: agents, prompts, models, hooks and tools
 * are *data* the host can compute, diff and version, so "which agents exist" is
 * a value rather than a directory. That is the whole difference from
 * `loadSource`, which walks the conventional `agents/` layout.
 *
 * Two guards replace what the loader used to give us:
 *  - duplicate names, because a `Map` silently keeps the first entry;
 *  - reference checks, which `validateRegistry` already implements, so we call
 *    it instead of re-deriving prompt/handler/model/tool/subagent lookups.
 *
 * Validation runs *before* a `Runtime` is constructed on purpose: a runtime with
 * a missing model reference constructs happily and only fails on the first turn
 * with "No model available", which is far away from the typo that caused it.
 */
import type {
	AgentDefinition,
	DefinitionIssue,
	HookName,
	ModelDefinition,
	PromptContent,
	PromptDefinition,
	ProviderFactory,
	SideConfig,
	SubagentRelationship,
	ToolDefinition,
} from "@standardagents/spec";
import type { AnyHook, Registry } from "@t-works/standardagents-runtime/loader";
import { formatIssues, unqualify, validateRegistry } from "@t-works/standardagents-runtime/loader";

/**
 * One side of an agent, exactly as the spec declares it: one backing
 * (`prompt`, `human` or `handler`) plus the options that side owns.
 */
export interface SideSpec {
	/** Prompt backing this side. Mutually exclusive with `human` / `handler`. */
	prompt?: string;
	/** Marks this side as human-backed. */
	human?: true;
	/** Handler backing this side. Mutually exclusive with `human` / `prompt`. */
	handler?: string;
	label?: string;
	subagents?: readonly SubagentRelationship[];
	maxSteps?: number;
	stopOnResponse?: boolean;
	stopTool?: string;
	stopToolResponseProperty?: string;
	/**
	 * Declared for spec forward-compatibility. The runtime reads tools from the
	 * prompt today, so this rides along untouched.
	 */
	tools?: readonly string[];
}

/** One agent in the spec. Both sides are always explicit. */
export interface AgentSpec {
	name: string;
	title?: string;
	description?: string;
	sides: { a: SideSpec; b: SideSpec };
}

/**
 * One prompt. `prompt` keeps the runtime's shape (a string or a parts array
 * with `text` / `include` / `env`), so prompt libraries compose by name
 * instead of by import.
 */
export interface PromptSpec {
	name: string;
	prompt: PromptContent;
	/** Model name; must match a `models` entry. */
	model: string;
	/** Description shown when the prompt is exposed as a tool. Defaults to `name`. */
	toolDescription?: string;
	tools?: readonly string[];
	includeChat?: boolean;
	env?: Record<string, string>;
}

/**
 * One model. `provider` may be omitted in a spec file (JSON cannot carry a
 * function); pass a factory for it through `BuildRegistryOptions.providers`.
 */
export interface ModelSpec {
	name: string;
	/** The model id sent to the provider, e.g. `gpt-4o-mini`. */
	model: string;
	provider?: ProviderFactory;
}

/** One hook, already built in code (a spec file cannot carry `execute`). */
export interface HookSpec {
	id: string;
	hook: HookName;
	execute: AnyHook["execute"];
}

/** One tool, already built in code. */
export interface ToolSpec {
	name: string;
	description: string;
	args?: ToolDefinition["args"];
	execute: ToolDefinition["execute"];
	variables?: ToolDefinition["variables"];
	executionMode?: ToolDefinition["executionMode"];
}

/** The workflow spec `buildRegistry` consumes. */
export interface WorkflowSpec {
	/** Stable id of the workflow; only used to make error text legible. */
	id: string;
	agents: readonly AgentSpec[];
	prompts: readonly PromptSpec[];
	models: readonly ModelSpec[];
	hooks?: readonly HookSpec[];
	tools?: readonly ToolSpec[];
}

/**
 * Wraps a resolved provider factory before the registry hands it to a runtime.
 *
 * The host uses this to decorate every model in one place — `withUsage(factory,
 * journal.modelCallSink())` — so the agent's own turns and the nested prompt
 * tools' hidden ones are measured by the same object.
 */
export type ProviderDecorator = (factory: ProviderFactory, model: ModelSpec) => ProviderFactory;

export interface BuildRegistryOptions {
	/**
	 * Provider factories for models declared without one, keyed by model name.
	 * Lets a JSON spec stay pure data while the host decides which provider runs.
	 */
	providers?: Readonly<Record<string, ProviderFactory>>;
	/**
	 * Applied to every model that ends up with a provider, declared or supplied.
	 * Runs once per model, before a runtime can cache a provider for it.
	 */
	decorate?: ProviderDecorator;
	/**
	 * When true (the default) any error-severity issue throws `RegistryBuildError`
	 * instead of returning a registry the runtime would only fail on later.
	 */
	strict?: boolean;
}

export interface BuildRegistryResult {
	registry: Registry;
	issues: DefinitionIssue[];
}

/** Thrown by `buildRegistry` when the spec cannot produce a usable registry. */
export class RegistryBuildError extends Error {
	readonly issues: DefinitionIssue[];
	readonly workflowId: string;

	constructor(workflowId: string, issues: DefinitionIssue[]) {
		const errors = issues.filter((issue) => issue.severity === "error");
		super(`Workflow '${workflowId}' has ${errors.length} error(s):\n${formatIssues(errors)}`);
		this.name = "RegistryBuildError";
		this.workflowId = workflowId;
		this.issues = issues;
	}
}

function emptyRegistry(): Registry {
	return {
		agents: new Map(),
		prompts: new Map(),
		tools: new Map(),
		models: new Map(),
		hooks: new Map(),
		handlers: new Map(),
		effects: new Map(),
		sources: {},
	};
}

/**
 * Register one definition, reporting a name that is already taken.
 *
 * `validateRegistry` checks references, not duplicates, and a `Map` would
 * quietly keep the first definition — so a spec that lists `planner` twice
 * would otherwise run one of them with no way to tell which. The loader uses
 * the same code for its own duplicate detection, and `DefinitionIssue['code']`
 * is a closed union, so we reuse it.
 */
function putDefinition<T>(
	registry: Registry,
	category: "agents" | "prompts" | "models" | "tools" | "hooks",
	name: string,
	value: T,
	spec: WorkflowSpec,
	issues: DefinitionIssue[],
): void {
	const key = unqualify(name);
	if (!key) {
		issues.push({
			code: "agent_name_missing",
			severity: "error",
			message: `${category} definition has no name in workflow '${spec.id}'`,
			path: category,
		});
		return;
	}
	if (registry[category].has(key)) {
		issues.push({
			code: "subagent_relationship_duplicate",
			severity: "error",
			message: `Duplicate ${category.slice(0, -1)} name '${key}' in workflow '${spec.id}'`,
			path: category,
		});
		return;
	}
	registry[category].set(key, value as never);
	registry.sources[`${category}:${key}`] = `${spec.id}/${category}/${key}`;
}

/**
 * Turn one declared side into a runtime side.
 *
 * The backing is chosen at runtime because the spec is data, so the object is
 * built from a passthrough bag; `validateAgentDefinition` reports a side with
 * no backing or with conflicting ones.
 */
function buildSide(side: SideSpec | undefined): SideConfig {
	const passthrough: Record<string, unknown> = {};
	if (!side) return passthrough as unknown as SideConfig;
	if (side.label !== undefined) passthrough.label = side.label;
	if (side.subagents !== undefined) passthrough.subagents = side.subagents;
	if (side.maxSteps !== undefined) passthrough.maxSteps = side.maxSteps;
	if (side.stopOnResponse !== undefined) passthrough.stopOnResponse = side.stopOnResponse;
	if (side.stopTool !== undefined) passthrough.stopTool = side.stopTool;
	if (side.stopToolResponseProperty !== undefined) {
		passthrough.stopToolResponseProperty = side.stopToolResponseProperty;
	}
	if (side.tools !== undefined) passthrough.tools = side.tools;
	if (side.human) passthrough.human = true;
	else if (side.prompt !== undefined) passthrough.prompt = side.prompt;
	else if (side.handler !== undefined) passthrough.handler = side.handler;
	return passthrough as unknown as SideConfig;
}

function buildAgent(spec: AgentSpec): AgentDefinition {
	const agent: AgentDefinition = {
		name: spec.name,
		sideA: buildSide(spec.sides?.a),
		sideB: buildSide(spec.sides?.b),
	};
	if (spec.title !== undefined) return { ...agent, title: spec.title, description: spec.description };
	if (spec.description !== undefined) return { ...agent, description: spec.description };
	return agent;
}

function buildPrompt(spec: PromptSpec): PromptDefinition {
	const prompt: PromptDefinition = {
		name: spec.name,
		toolDescription: spec.toolDescription ?? spec.name,
		prompt: spec.prompt,
		model: spec.model,
	};
	const extras: Partial<PromptDefinition> = {};
	if (spec.tools !== undefined) extras.tools = spec.tools as PromptDefinition["tools"];
	if (spec.includeChat !== undefined) extras.includeChat = spec.includeChat;
	if (spec.env !== undefined) extras.env = spec.env;
	return Object.keys(extras).length ? { ...prompt, ...extras } : prompt;
}

function buildModel(spec: ModelSpec, options: BuildRegistryOptions): ModelDefinition {
	const declared = spec.provider ?? options.providers?.[spec.name];
	// Decoration happens here, once per model, so no runtime ever caches an
	// undecorated provider: `Runtime.providerFor` keeps the first instance it builds.
	const provider = declared ? (options.decorate?.(declared, spec) ?? declared) : undefined;
	// No provider means `validateRegistry` reports it; the cast keeps the partial
	// definition printable in that error instead of throwing here.
	return { name: spec.name, model: spec.model, provider } as ModelDefinition;
}

function buildHook(spec: HookSpec): AnyHook {
	// The hook name drives the payload/return type, so a spec-driven hook can
	// only be checked at the call site; the runtime narrows it when it dispatches.
	return { id: spec.id, hook: spec.hook, execute: spec.execute } as unknown as AnyHook;
}

function buildTool(spec: ToolSpec): ToolDefinition {
	const tool: ToolDefinition = {
		description: spec.description,
		args: spec.args ?? null,
		execute: spec.execute,
		variables: spec.variables ?? [],
		tenvs: null,
	};
	return spec.executionMode ? { ...tool, executionMode: spec.executionMode } : tool;
}

/**
 * Build the `Registry` a `Runtime` accepts from a workflow spec.
 *
 * Returns every issue it found: our duplicate checks plus `validateRegistry`'s
 * reference checks (undefined prompt/handler/model/tool/subagent targets, which
 * is also how a workflow edge to a missing agent is caught).
 *
 * Fails closed: with `strict` (the default) any error throws
 * `RegistryBuildError` carrying the issues, so a host never constructs a
 * runtime around a spec that cannot run. Pass `strict: false` to inspect the
 * issues and registry instead.
 */
export function buildRegistry(
	spec: WorkflowSpec,
	options: BuildRegistryOptions = {},
): BuildRegistryResult {
	const registry = emptyRegistry();
	const issues: DefinitionIssue[] = [];

	for (const agent of spec.agents ?? []) {
		putDefinition(registry, "agents", agent.name, buildAgent(agent), spec, issues);
	}
	for (const prompt of spec.prompts ?? []) {
		putDefinition(registry, "prompts", prompt.name, buildPrompt(prompt), spec, issues);
	}
	for (const model of spec.models ?? []) {
		putDefinition(registry, "models", model.name, buildModel(model, options), spec, issues);
	}
	for (const hook of spec.hooks ?? []) {
		putDefinition(registry, "hooks", hook.id, buildHook(hook), spec, issues);
	}
	for (const tool of spec.tools ?? []) {
		putDefinition(registry, "tools", tool.name, buildTool(tool), spec, issues);
	}

	issues.push(...validateRegistry(registry));

	if ((options.strict ?? true) && issues.some((issue) => issue.severity === "error")) {
		throw new RegistryBuildError(spec.id, issues);
	}
	return { registry, issues };
}
