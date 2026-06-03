/**
 * restore — session_start restoration. Loads persisted config, re-applies the
 * model/effort selection + blocklist, activates the tool when not blocked, and
 * de-dupes repeated identical restore notifications. Wired via
 * registerAdvisorSessionStart.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	isAdvisorEffortSupported,
	loadAdvisorConfig,
	parseModelKey,
	validateAdvisorEffort,
	validateDisabledForModels,
} from "./config.js";
import { ADVISOR_TOOL_NAME, errModelUnavailable, msgAdvisorRestored, msgAdvisorRestoredInactive } from "./messages.js";
import { isExecutorBlocked, setDisabledForModels } from "./policy.js";
import { getAdvisorEffort, setAdvisorEffort, setAdvisorModel } from "./state.js";

/**
 * Module-local notification de-dupe. Pi fires `session_start` for every session
 * including programmatic spawns (workflow stages, batch ops, any extension's
 * `newSession` call). State mutation belongs on every fire; repeated identical
 * notifications do not. Different later messages still surface.
 */
let lastRestoreNotificationKey: string | undefined;

/** Test reset — wired into test/setup.ts `beforeEach`. */
export function __resetAdvisorAnnounced(): void {
	lastRestoreNotificationKey = undefined;
}

async function clearAdvisorSelection(pi: ExtensionAPI): Promise<void> {
	setAdvisorModel(undefined);
	setAdvisorEffort(undefined);
	const active = pi.getActiveTools();
	if (active.includes(ADVISOR_TOOL_NAME)) {
		await pi.setActiveTools(active.filter((n) => n !== ADVISOR_TOOL_NAME));
	}
}

export async function restoreAdvisorState(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
	const config = loadAdvisorConfig();

	setDisabledForModels(validateDisabledForModels(config.disabledForModels));
	await clearAdvisorSelection(pi);

	if (!config.modelKey) return;

	const parsed = parseModelKey(config.modelKey);
	if (!parsed) return;

	const notifyOnce = (msg: string, level: "info" | "warning" | "error"): void => {
		const key = `${level}:${msg}`;
		if (!ctx.hasUI || lastRestoreNotificationKey === key) return;
		ctx.ui.notify(msg, level);
		lastRestoreNotificationKey = key;
	};

	const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
	if (!model) {
		notifyOnce(errModelUnavailable(config.modelKey), "warning");
		return;
	}

	const effort = validateAdvisorEffort(config.effort);
	if (effort && isAdvisorEffortSupported(model, effort)) {
		setAdvisorEffort(effort);
	}
	const advisorLabel = `${model.provider}:${model.id}`;

	if (isExecutorBlocked(ctx, pi.getThinkingLevel())) {
		notifyOnce(msgAdvisorRestoredInactive(advisorLabel, getAdvisorEffort()), "info");
		return;
	}

	const active = pi.getActiveTools();
	if (!active.includes(ADVISOR_TOOL_NAME)) {
		await pi.setActiveTools([...active, ADVISOR_TOOL_NAME]);
	}
	notifyOnce(msgAdvisorRestored(advisorLabel, getAdvisorEffort()), "info");
}

export function registerAdvisorSessionStart(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		await restoreAdvisorState(ctx, pi);
	});
}
