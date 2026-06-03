/**
 * execute — the advisor side-call. Curates the executor's branch (inventory
 * prefix + tail massaging), invokes the advisor model via completeSimple with
 * no tools, and returns a structured tool result. Every result branch (success
 * / abort / error / empty) and the pre-call error paths funnel through
 * buildAdvisorResult so the envelope is built in exactly one place.
 */

import type { StopReason, Usage } from "@earendil-works/pi-ai";
import { completeSimple, type Message, type ThinkingLevel } from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	buildSessionContext,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ensureUserTailForAdvisor, stripInflightAdvisorCall } from "./context.js";
import { getInventoryMessage, stableStringify } from "./inventory.js";
import {
	ERR_ABORTED_DETAIL,
	ERR_ADVISOR_COOLDOWN_DETAIL,
	ERR_ADVISOR_IN_FLIGHT_DETAIL,
	ERR_CALL_ABORTED,
	ERR_EMPTY_RESPONSE,
	ERR_EMPTY_RESPONSE_DETAIL,
	ERR_NO_MODEL,
	ERR_NO_MODEL_SELECTED,
	errCallFailed,
	errAdvisorCooldown,
	errAdvisorInFlight,
	errCallThrew,
	errMisconfigured,
	errNoApiKey,
	ADVISOR_TOOL_NAME,
	errNoApiKeyDetail,
	msgConsulting,
} from "./messages.js";
import { ADVISOR_SYSTEM_PROMPT } from "./prompt.js";
import { getAdvisorEffort, getAdvisorModel } from "./state.js";

interface AdvisorDetails {
	advisorModel?: string;
	effort?: ThinkingLevel;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
}

// Single result-envelope builder — every executeAdvisor branch and the pre-call
// error paths funnel through here. `effort` is snapshotted once at executeAdvisor
// entry and threaded through every call so the returned details.effort always
// matches the value sent as `reasoning` to completeSimple, even if module-level
// state is mutated during the await window.
function buildAdvisorResult(opts: {
	text: string;
	effort: ThinkingLevel | undefined;
	advisorLabel?: string;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
}): AgentToolResult<AdvisorDetails> {
	const details: AdvisorDetails = { effort: opts.effort };
	if (opts.advisorLabel !== undefined) details.advisorModel = opts.advisorLabel;
	if (opts.usage !== undefined) details.usage = opts.usage;
	if (opts.stopReason !== undefined) details.stopReason = opts.stopReason;
	if (opts.errorMessage !== undefined) details.errorMessage = opts.errorMessage;
	return { content: [{ type: "text", text: opts.text }], details };
}

function buildErrorResult(
	advisorLabel: string | undefined,
	effort: ThinkingLevel | undefined,
	userText: string,
	errorMessage: string,
): AgentToolResult<AdvisorDetails> {
	return buildAdvisorResult({ text: userText, effort, advisorLabel, errorMessage });
}

const advisorInFlightSessions = new Set<string>();
const lastAdvisorContextFingerprintBySession = new Map<string, string>();

function advisorSessionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId() ?? ctx.sessionManager.getSessionFile() ?? "unknown-session";
}

function hashString(value: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16);
}

function canonicalizeMessagesForFingerprint(messages: Message[]): unknown[] {
	const canonicalMessages: unknown[] = [];
	for (const message of messages) {
		if (message.role === "toolResult" && message.toolName === ADVISOR_TOOL_NAME) continue;
		if (message.role === "assistant") {
			if (message.content.some((part) => part.type === "toolCall" && part.name === ADVISOR_TOOL_NAME)) continue;
			canonicalMessages.push({ ...message, timestamp: undefined });
			continue;
		}
		canonicalMessages.push({ ...message, timestamp: undefined });
	}
	return canonicalMessages;
}

function advisorContextFingerprint(sentMessages: Message[]): string {
	const canonicalMessages = canonicalizeMessagesForFingerprint(sentMessages);
	return `${canonicalMessages.length}:${hashString(stableStringify(canonicalMessages))}`;
}

export async function executeAdvisor(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<AdvisorDetails> | undefined,
): Promise<AgentToolResult<AdvisorDetails>> {
	// Snapshot effort once at entry — every result envelope and the API call
	// itself use this same value so a concurrent setAdvisorEffort() during the
	// await window cannot desync details.effort from the `reasoning` actually sent.
	const effort = getAdvisorEffort();
	const advisor = getAdvisorModel();
	if (!advisor) {
		return buildErrorResult(undefined, effort, ERR_NO_MODEL, ERR_NO_MODEL_SELECTED);
	}
	const advisorLabel = `${advisor.provider}:${advisor.id}`;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(advisor);
	if (!auth.ok) {
		return buildErrorResult(advisorLabel, effort, errMisconfigured(advisorLabel, auth.error), auth.error);
	}
	if (!auth.apiKey) {
		return buildErrorResult(advisorLabel, effort, errNoApiKey(advisorLabel), errNoApiKeyDetail(advisor.provider));
	}

	// Live-read every call — advisor runs mid-turn so any message_end snapshot
	// is always one turn stale. buildSessionContext() preserves Pi's resolved
	// LLM context, including compaction summaries and branch summaries, instead
	// of replaying raw pre-compaction branch messages. convertToLlm is
	// pass-through for user/assistant/toolResult (messages.js:111-114), so
	// element refs are stable across calls via the session store.
	const { messages: sessionMessages } = buildSessionContext(
		ctx.sessionManager.getEntries(),
		ctx.sessionManager.getLeafId(),
	);
	const branchMessages = ensureUserTailForAdvisor(stripInflightAdvisorCall(convertToLlm(sessionMessages)));
	const inventoryMessage = getInventoryMessage(pi.getAllTools());
	const messages: Message[] = inventoryMessage ? [inventoryMessage, ...branchMessages] : branchMessages;

	const sessionKey = advisorSessionKey(ctx);
	const contextFingerprint = advisorContextFingerprint(messages);
	if (advisorInFlightSessions.has(sessionKey)) {
		return buildErrorResult(advisorLabel, effort, errAdvisorInFlight(), ERR_ADVISOR_IN_FLIGHT_DETAIL);
	}
	if (lastAdvisorContextFingerprintBySession.get(sessionKey) === contextFingerprint) {
		return buildErrorResult(advisorLabel, effort, errAdvisorCooldown(), ERR_ADVISOR_COOLDOWN_DETAIL);
	}
	advisorInFlightSessions.add(sessionKey);

	onUpdate?.({
		content: [{ type: "text", text: msgConsulting(advisorLabel, effort) }],
		details: { advisorModel: advisorLabel, effort },
	});

	try {
		const response = await completeSimple(
			advisor,
			// `tools: []` reaffirms the "never calls tools" contract even when
			// `messages` contains prior toolCall/toolResult blocks (btw.ts:235).
			{ systemPrompt: ADVISOR_SYSTEM_PROMPT, messages, tools: [] },
			{ apiKey: auth.apiKey, headers: auth.headers, signal, reasoning: effort },
		);

		if (response.stopReason === "aborted") {
			return buildAdvisorResult({
				text: ERR_CALL_ABORTED,
				effort,
				advisorLabel,
				usage: response.usage,
				stopReason: response.stopReason,
				errorMessage: response.errorMessage ?? ERR_ABORTED_DETAIL,
			});
		}

		if (response.stopReason === "error") {
			return buildAdvisorResult({
				text: errCallFailed(response.errorMessage),
				effort,
				advisorLabel,
				usage: response.usage,
				stopReason: response.stopReason,
				errorMessage: response.errorMessage,
			});
		}

		const advisorText = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();

		if (!advisorText) {
			return buildAdvisorResult({
				text: ERR_EMPTY_RESPONSE,
				effort,
				advisorLabel,
				usage: response.usage,
				stopReason: response.stopReason,
				errorMessage: ERR_EMPTY_RESPONSE_DETAIL,
			});
		}

		lastAdvisorContextFingerprintBySession.set(sessionKey, contextFingerprint);
		return buildAdvisorResult({
			text: advisorText,
			effort,
			advisorLabel,
			usage: response.usage,
			stopReason: response.stopReason,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return buildErrorResult(advisorLabel, effort, errCallThrew(message), message);
	} finally {
		advisorInFlightSessions.delete(sessionKey);
	}
}
