/**
 * config — persisted advisor config (~/.config/rpiv-advisor/advisor.json) and
 * the provider:id key codec. Owns the AdvisorConfig shape, load/validate/save,
 * and the modelKey (join) / parseModelKey (split) inverse pair (L4-04).
 */

import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { homedir } from "node:os";
import { join } from "node:path";
import { type GuidanceFields, loadJsonConfig, saveJsonConfig } from "./config-io.js";
import { EFFORT_ORDINAL } from "./messages.js";

const ADVISOR_CONFIG_PATH = join(homedir(), ".config", "rpiv-advisor", "advisor.json");

export type DisabledForModelsEntry = string | { model: string; minEffort?: ThinkingLevel };

interface AdvisorConfig {
	modelKey?: string;
	effort?: ThinkingLevel;
	guidance?: GuidanceFields;
	disabledForModels?: DisabledForModelsEntry[];
}

export function loadAdvisorConfig(): AdvisorConfig {
	return loadJsonConfig<AdvisorConfig>(ADVISOR_CONFIG_PATH);
}


export function validateAdvisorEffort(value: unknown): ThinkingLevel | undefined {
	return EFFORT_ORDINAL.includes(value as ThinkingLevel) ? (value as ThinkingLevel) : undefined;
}

export function isAdvisorEffortSupported(model: Model<Api>, effort: ThinkingLevel): boolean {
	return model.thinkingLevelMap?.[effort] !== null;
}
export function validateDisabledForModels(value: unknown): DisabledForModelsEntry[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is DisabledForModelsEntry => {
		if (typeof entry === "string") return entry.length > 0;
		if (typeof entry !== "object" || entry === null) return false;
		const obj = entry as Record<string, unknown>;
		if (typeof obj.model !== "string" || obj.model.length === 0) return false;
		if (obj.minEffort !== undefined && !EFFORT_ORDINAL.includes(obj.minEffort as ThinkingLevel)) return false;
		return true;
	});
}

export function saveAdvisorConfig(key: string | undefined, effort: ThinkingLevel | undefined): boolean {
	const existing = loadAdvisorConfig();
	const config: AdvisorConfig = { ...existing };
	// Delete (rather than omit) to clear fields that may exist in the spread
	// from a prior read. JSON.parse always produces configurable properties,
	// so delete is safe in strict mode.
	if (key) config.modelKey = key;
	else delete config.modelKey;
	if (effort) config.effort = effort;
	else delete config.effort;
	return saveJsonConfig(ADVISOR_CONFIG_PATH, config);
}

export function parseModelKey(key: string): { provider: string; modelId: string } | undefined {
	const idx = key.indexOf(":");
	if (idx < 1) return undefined;
	return { provider: key.slice(0, idx), modelId: key.slice(idx + 1) };
}

export function modelKey(m: { provider: string; id: string }): string {
	return `${m.provider}:${m.id}`;
}
