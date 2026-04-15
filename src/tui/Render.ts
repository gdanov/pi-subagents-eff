/**
 * Result rendering — pure formatters from render.ts + render-helpers.ts +
 * formatters.ts. Receives plain Details data (no Effect environment).
 *
 * Ported from legacy render.ts, render-helpers.ts, formatters.ts.
 */
import * as fs from "node:fs";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { getMarkdownTheme, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { Container, Markdown, Spacer, Text, visibleWidth } from "@mariozechner/pi-tui";
import type { Details, SingleResult, Usage } from "../domain/results.ts";
import type { AgentProgress, ProgressSummary } from "../domain/progress.ts";
import type { AsyncJobState } from "../domain/async-state.ts";

type Theme = ExtensionContext["ui"]["theme"];

export const WIDGET_KEY = "pi-subagents:async-jobs";
export const MAX_WIDGET_JOBS = 6;

export function getTermWidth(): number {
	return process.stdout.columns || 120;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function truncLine(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;
	const targetWidth = maxWidth - 1;
	let result = "";
	let currentWidth = 0;
	let activeStyles: string[] = [];
	let i = 0;
	while (i < text.length) {
		const ansiMatch = text.slice(i).match(/^\x1b\[[0-9;]*m/);
		if (ansiMatch) {
			const code = ansiMatch[0]!;
			result += code;
			if (code === "\x1b[0m" || code === "\x1b[m") {
				activeStyles = [];
			} else {
				activeStyles.push(code);
			}
			i += code.length;
			continue;
		}
		let end = i;
		while (end < text.length && !text.slice(end).match(/^\x1b\[[0-9;]*m/)) {
			end++;
		}
		const textPortion = text.slice(i, end);
		for (const seg of segmenter.segment(textPortion)) {
			const grapheme = seg.segment;
			const graphemeWidth = visibleWidth(grapheme);
			if (currentWidth + graphemeWidth > targetWidth) {
				return result + activeStyles.join("") + "…";
			}
			result += grapheme;
			currentWidth += graphemeWidth;
		}
		i = end;
	}
	return result + activeStyles.join("") + "…";
}

export function formatTokens(n: number): string {
	return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

export function formatUsage(u: Usage, model?: string): string {
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
	if (u.input) parts.push(`in:${formatTokens(u.input)}`);
	if (u.output) parts.push(`out:${formatTokens(u.output)}`);
	if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
	if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

export function formatToolCall(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case "bash":
			return `$ ${((args.command as string) || "").slice(0, 60)}${(args.command as string)?.length > 60 ? "..." : ""}`;
		case "read":
			return `read ${shortenPath((args.path || args.file_path || "") as string)}`;
		case "write":
			return `write ${shortenPath((args.path || args.file_path || "") as string)}`;
		case "edit":
			return `edit ${shortenPath((args.path || args.file_path || "") as string)}`;
		default: {
			const s = JSON.stringify(args);
			return `${name} ${s.slice(0, 40)}${s.length > 40 ? "..." : ""}`;
		}
	}
}

export function shortenPath(p: string): string {
	const home = process.env.HOME;
	if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
	return p;
}

export function formatPath(p: string): string {
	const home = process.env.HOME;
	if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
	return p;
}

function fuzzyScore(query: string, text: string): number {
	const lq = query.toLowerCase();
	const lt = text.toLowerCase();
	if (lt.includes(lq)) return 100 + (lq.length / lt.length) * 50;
	let score = 0;
	let qi = 0;
	let consecutive = 0;
	for (let i = 0; i < lt.length && qi < lq.length; i++) {
		if (lt[i] === lq[qi]) {
			score += 10 + consecutive;
			consecutive += 5;
			qi++;
		} else {
			consecutive = 0;
		}
	}
	return qi === lq.length ? score : 0;
}

export function fuzzyFilter<T extends { name: string; description: string; model?: string }>(items: T[], query: string): T[] {
	const q = query.trim();
	if (!q) return items;
	return items
		.map((item) => ({ item, score: Math.max(fuzzyScore(q, item.name), fuzzyScore(q, item.description) * 0.8, fuzzyScore(q, item.model ?? "") * 0.6) }))
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
		.map((x) => x.item);
}

export function pad(s: string, len: number): string {
	const vis = visibleWidth(s);
	return s + " ".repeat(Math.max(0, len - vis));
}

export function row(content: string, width: number, theme: Theme): string {
	const innerW = width - 2;
	return theme.fg("border", "│") + pad(content, innerW) + theme.fg("border", "│");
}

export function renderHeader(text: string, width: number, theme: Theme): string {
	const innerW = width - 2;
	const padLen = Math.max(0, innerW - visibleWidth(text));
	const padLeft = Math.floor(padLen / 2);
	const padRight = padLen - padLeft;
	return (
		theme.fg("border", "╭" + "─".repeat(padLeft)) +
		theme.fg("accent", text) +
		theme.fg("border", "─".repeat(padRight) + "╮")
	);
}

export function formatScrollInfo(above: number, below: number): string {
	let info = "";
	if (above > 0) info += `↑ ${above} more`;
	if (below > 0) info += `${info ? "  " : ""}↓ ${below} more`;
	return info;
}

export function renderFooter(text: string, width: number, theme: Theme): string {
	const innerW = width - 2;
	const padLen = Math.max(0, innerW - visibleWidth(text));
	const padLeft = Math.floor(padLen / 2);
	const padRight = padLen - padLeft;
	return (
		theme.fg("border", "╰" + "─".repeat(padLeft)) +
		theme.fg("dim", text) +
		theme.fg("border", "─".repeat(padRight) + "╯")
	);
}

let lastWidgetHash = "";

function computeWidgetHash(jobs: AsyncJobState[]): string {
	return jobs.slice(0, MAX_WIDGET_JOBS).map(job =>
		`${job.asyncId}:${job.status}:${job.currentStep ?? 0}:${job.updatedAt ?? 0}:${job.totalTokens?.total ?? 0}`
	).join("|");
}

function safeReadFile(filePath: string): string {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return "";
	}
}

function getOutputTail(outputFile: string, lines: number): string[] {
	const content = safeReadFile(outputFile);
	if (!content) return [];
	const allLines = content.split("\n").filter(l => l.trim());
	return allLines.slice(-lines);
}

function getLastActivity(outputFile: string): string {
	const content = safeReadFile(outputFile);
	if (!content) return "";
	const allLines = content.split("\n").filter(l => l.trim());
	const last = allLines[allLines.length - 1];
	if (!last) return "";
	try {
		const obj = JSON.parse(last);
		return typeof obj.msg === "string" ? obj.msg : (typeof obj === "string" ? last : "");
	} catch {
		return last.slice(0, 60);
	}
}

export function renderWidget(ctx: ExtensionContext, jobs: AsyncJobState[]): void {
	if (!ctx.hasUI) return;
	if (jobs.length === 0) {
		if (lastWidgetHash !== "") {
			lastWidgetHash = "";
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
		return;
	}
	const displayedJobs = jobs.slice(0, MAX_WIDGET_JOBS);
	const hasRunningJobs = displayedJobs.some(job => job.status === "running");
	const newHash = computeWidgetHash(jobs);
	if (!hasRunningJobs && newHash === lastWidgetHash) {
		return;
	}
	lastWidgetHash = newHash;
	const theme = ctx.ui.theme;
	const w = getTermWidth();
	const lines: string[] = [];
	lines.push(theme.fg("accent", "Async subagents"));
	for (const job of displayedJobs) {
		const id = job.asyncId.slice(0, 6);
		const status =
			job.status === "complete"
				? theme.fg("success", "complete")
				: job.status === "failed"
					? theme.fg("error", "failed")
					: theme.fg("warning", "running");
		const stepsTotal = job.stepsTotal ?? (job.agents?.length ?? 1);
		const stepIndex = job.currentStep !== undefined ? job.currentStep + 1 : undefined;
		const stepText = stepIndex !== undefined ? `step ${stepIndex}/${stepsTotal}` : `steps ${stepsTotal}`;
		const endTime = (job.status === "complete" || job.status === "failed") ? (job.updatedAt ?? Date.now()) : Date.now();
		const elapsed = job.startedAt ? formatDuration(endTime - job.startedAt) : "";
		const agentLabel = job.agents ? job.agents.join(" -> ") : (job.mode ?? "single");
		const tokenText = job.totalTokens ? ` | ${formatTokens(job.totalTokens.total)} tok` : "";
		const activityText = job.status === "running" ? getLastActivity(job.outputFile ?? "") : "";
		const activitySuffix = activityText ? ` | ${theme.fg("dim", activityText)}` : "";
		lines.push(truncLine(`- ${id} ${status} | ${agentLabel} | ${stepText}${elapsed ? ` | ${elapsed}` : ""}${tokenText}${activitySuffix}`, w));
		if (job.status === "running" && job.outputFile) {
			const tail = getOutputTail(job.outputFile, 3);
			for (const line of tail) {
				lines.push(truncLine(theme.fg("dim", `  > ${line}`), w));
			}
		}
	}
	ctx.ui.setWidget(WIDGET_KEY, lines);
}

function extractOutputTarget(task: string): string | undefined {
	const writeToMatch = task.match(/\[Write to:\s*([^\]\n]+)\]/i);
	if (writeToMatch?.[1]?.trim()) return writeToMatch[1]!.trim();
	const findingsMatch = task.match(/Write your findings to:\s*(\S+)/i);
	if (findingsMatch?.[1]?.trim()) return findingsMatch[1]!.trim();
	const outputMatch = task.match(/[Oo]utput(?:\s+to)?\s*:\s*(\S+)/i);
	if (outputMatch?.[1]?.trim()) return outputMatch[1]!.trim();
	return undefined;
}

function hasEmptyTextOutputWithoutOutputTarget(task: string, output: string): boolean {
	if (output.trim()) return false;
	return !extractOutputTarget(task);
}

function getDisplayItems(messages: unknown[]): Array<{ type: "tool"; name: string; args: string }> {
	const items: Array<{ type: "tool"; name: string; args: string }> = [];
	for (const msg of messages) {
		if (typeof msg === "object" && msg !== null && "role" in msg && (msg as { role: unknown }).role === "assistant") {
			const m = msg as { content?: unknown[] };
			if (Array.isArray(m.content)) {
				for (const c of m.content) {
					if (typeof c === "object" && c !== null && "type" in c && (c as { type: string }).type === "tool_use") {
						const tool = c as { name?: string; input?: Record<string, unknown> };
						if (tool.name) {
							items.push({ type: "tool", name: tool.name, args: JSON.stringify(tool.input ?? {}) });
						}
					}
				}
			}
		}
	}
	return items;
}

function getSingleResultOutput(r: SingleResult): string {
	if (r.truncation?.text) return r.truncation.text;
	if (r.finalOutput) return r.finalOutput;
	if (r.savedOutputPath) {
		const content = safeReadFile(r.savedOutputPath);
		if (content) return content;
	}
	const msgs = r.messages as Array<{ role?: string; content?: unknown[] }>;
	for (let i = msgs.length - 1; i >= 0; i--) {
		const msg = msgs[i]!;
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (let j = msg.content.length - 1; j >= 0; j--) {
				const c = msg.content[j];
				if (typeof c === "object" && c !== null && "type" in c) {
					if ((c as { type: string }).type === "output") {
						const out = c as { text?: string };
						if (out.text) return out.text;
					}
				}
			}
		}
	}
	return "";
}

function hasProgressStatus(p: AgentProgress | ProgressSummary | undefined): p is AgentProgress {
	return p !== undefined && "status" in p;
}

export function renderSubagentResult(
	result: AgentToolResult<Details>,
	_options: { expanded: boolean },
	theme: Theme,
): Component {
	const d = result.details;
	if (!d || !d.results.length) {
		const t = result.content[0];
		const text = t?.type === "text" ? t.text : "(no output)";
		const contextPrefix = d?.context === "fork" ? `${theme.fg("warning", "[fork]")} ` : "";
		return new Text(truncLine(`${contextPrefix}${text}`, getTermWidth() - 4), 0, 0);
	}
	if (d.mode === "single" && d.results.length === 1) {
		return renderSingleResult(d.results[0]!, d, theme);
	}
	return renderMultiResult(d, theme);
}

function renderSingleResult(r: SingleResult, d: Details, theme: Theme): Component {
	const rProg = r.progress;
	const isRunning = hasProgressStatus(rProg) && rProg.status === "running";
	const icon = isRunning
		? theme.fg("warning", "...")
		: r.detached
			? theme.fg("warning", "↗")
			: r.exitCode === 0
				? theme.fg("success", "ok")
				: theme.fg("error", "X");
	const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
	const output = r.truncation?.text || getSingleResultOutput(r);
	const progressInfo = isRunning && hasProgressStatus(rProg)
		? ` | ${rProg.toolCount} tools, ${formatTokens(rProg.tokens)} tok, ${formatDuration(rProg.durationMs)}`
		: r.progressSummary
			? ` | ${r.progressSummary.toolCount} tools, ${formatTokens(r.progressSummary.tokens)} tok, ${formatDuration(r.progressSummary.durationMs)}`
			: "";
	const w = getTermWidth() - 4;
	const c = new Container();
	c.addChild(new Text(truncLine(`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${contextBadge}${progressInfo}`, w), 0, 0));
	c.addChild(new Spacer(1));
	const taskMaxLen = Math.max(20, w - 8);
	const taskPreview = r.task.length > taskMaxLen ? `${r.task.slice(0, taskMaxLen)}...` : r.task;
	c.addChild(new Text(truncLine(theme.fg("dim", `Task: ${taskPreview}`), w), 0, 0));
	c.addChild(new Spacer(1));
	if (isRunning && hasProgressStatus(rProg)) {
		if (rProg.currentTool) {
			const maxToolArgsLen = Math.max(50, w - 20);
			const toolArgsPreview = rProg.currentToolArgs
				? (rProg.currentToolArgs.length > maxToolArgsLen
					? `${rProg.currentToolArgs.slice(0, maxToolArgsLen)}...`
					: rProg.currentToolArgs)
				: "";
			const toolLine = toolArgsPreview ? `${rProg.currentTool}: ${toolArgsPreview}` : rProg.currentTool;
			c.addChild(new Text(truncLine(theme.fg("warning", `> ${toolLine}`), w), 0, 0));
		}
		if (rProg.recentTools?.length) {
			for (const t of rProg.recentTools.slice(-3)) {
				const maxArgsLen = Math.max(40, w - 24);
				const argsPreview = t.args.length > maxArgsLen ? `${t.args.slice(0, maxArgsLen)}...` : t.args;
				c.addChild(new Text(truncLine(theme.fg("dim", `${t.tool}: ${argsPreview}`), w), 0, 0));
			}
		}
		for (const line of (rProg.recentOutput ?? []).slice(-5)) {
			c.addChild(new Text(truncLine(theme.fg("dim", `  ${line}`), w), 0, 0));
		}
		if (rProg.currentTool || rProg.recentTools?.length || rProg.recentOutput?.length) {
			c.addChild(new Spacer(1));
		}
	}
	const items = getDisplayItems(r.messages as unknown[]);
	for (const item of items) {
		if (item.type === "tool") c.addChild(new Text(truncLine(theme.fg("muted", formatToolCall(item.name, JSON.parse(item.args))), w), 0, 0));
	}
	if (items.length) c.addChild(new Spacer(1));
	if (output) c.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
	c.addChild(new Spacer(1));
	if (r.skills?.length) c.addChild(new Text(truncLine(theme.fg("dim", `Skills: ${r.skills.join(", ")}`), w), 0, 0));
	if (r.skillsWarning) c.addChild(new Text(truncLine(theme.fg("warning", `⚠️ ${r.skillsWarning}`), w), 0, 0));
	if (r.attemptedModels && r.attemptedModels.length > 1) c.addChild(new Text(truncLine(theme.fg("dim", `Fallbacks: ${r.attemptedModels.join(" → ")}`), w), 0, 0));
	c.addChild(new Text(truncLine(theme.fg("dim", formatUsage(r.usage, r.model)), w), 0, 0));
	if (r.sessionFile) c.addChild(new Text(truncLine(theme.fg("dim", `Session: ${shortenPath(r.sessionFile)}`), w), 0, 0));
	if (r.artifactPaths) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(truncLine(theme.fg("dim", `Artifacts: ${shortenPath(r.artifactPaths.outputPath)}`), w), 0, 0));
	}
	return c;
}

function renderMultiResult(d: Details, theme: Theme): Component {
	const hasRunning = (d.progress?.some((p) => hasProgressStatus(p) && p.status === "running")) || d.results.some((r) => hasProgressStatus(r.progress) && r.progress.status === "running");
	const ok = d.results.filter((r) => (hasProgressStatus(r.progress) && r.progress.status === "completed") || (r.exitCode === 0 && !hasProgressStatus(r.progress) || (hasProgressStatus(r.progress) && r.progress.status !== "running"))).length;
	const hasEmptyWithoutTarget = d.results.some((r) =>
		r.exitCode === 0 && (!hasProgressStatus(r.progress) || r.progress.status !== "running") && hasEmptyTextOutputWithoutOutputTarget(r.task, getSingleResultOutput(r)));
	const icon = hasRunning
		? theme.fg("warning", "...")
		: hasEmptyWithoutTarget
			? theme.fg("warning", "⚠")
			: ok === d.results.length
				? theme.fg("success", "ok")
				: theme.fg("error", "X");
	const totalSummary = d.progressSummary || d.results.reduce(
		(acc, r) => {
			const prog = r.progress || r.progressSummary;
			if (prog) {
				acc.toolCount += prog.toolCount;
				acc.tokens += prog.tokens;
				acc.durationMs = d.mode === "chain" ? acc.durationMs + prog.durationMs : Math.max(acc.durationMs, prog.durationMs);
			}
			return acc;
		},
		{ toolCount: 0, tokens: 0, durationMs: 0 },
	);
	const summaryStr = totalSummary.toolCount || totalSummary.tokens
		? ` | ${totalSummary.toolCount} tools, ${formatTokens(totalSummary.tokens)} tok, ${formatDuration(totalSummary.durationMs)}`
		: "";
	const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
	const hasParallelInChain = d.chainAgents?.some((a) => a.startsWith("["));
	const totalCount = hasParallelInChain ? d.results.length : (d.totalSteps ?? d.results.length);
	const currentStep = d.currentStepIndex !== undefined ? d.currentStepIndex + 1 : ok + 1;
	const stepInfo = hasRunning ? ` ${currentStep}/${totalCount}` : ` ${ok}/${totalCount}`;
	const chainVis = d.chainAgents?.length && !hasParallelInChain
		? d.chainAgents
				.map((agent, i) => {
					const result = d.results[i];
					const isFailed = hasProgressStatus(result?.progress) && result!.exitCode !== 0 && result?.progress.status !== "running";
					const isComplete = hasProgressStatus(result?.progress) && result!.exitCode === 0 && result?.progress.status !== "running";
					const isEmptyWithoutTarget = Boolean(result) && Boolean(isComplete) && hasEmptyTextOutputWithoutOutputTarget(result!.task, getSingleResultOutput(result!));
					const isCurrent = i === (d.currentStepIndex ?? d.results.length);
					const stepIcon = isFailed
						? theme.fg("error", "✗")
						: isEmptyWithoutTarget
							? theme.fg("warning", "⚠")
							: isComplete
								? theme.fg("success", "✓")
								: isCurrent && hasRunning
									? theme.fg("warning", "●")
									: theme.fg("dim", "○");
					return `${stepIcon} ${agent}`;
				})
				.join(theme.fg("dim", " → "))
		: null;
	const w = getTermWidth() - 4;
	const c = new Container();
	c.addChild(new Text(truncLine(`${icon} ${theme.fg("toolTitle", theme.bold(d.mode))}${contextBadge}${stepInfo}${summaryStr}`, w), 0, 0));
	if (chainVis) c.addChild(new Text(truncLine(`  ${chainVis}`, w), 0, 0));
	c.addChild(new Spacer(1));
	const useResultsDirectly = hasParallelInChain || !d.chainAgents?.length;
	const stepsToShow = useResultsDirectly ? d.results.length : d.chainAgents!.length;
	for (let i = 0; i < stepsToShow; i++) {
		const r = d.results[i];
		const agentName = useResultsDirectly ? (r?.agent || `step-${i + 1}`) : (d.chainAgents![i] || r?.agent || `step-${i + 1}`);
		if (!r) {
			c.addChild(new Text(truncLine(theme.fg("dim", `  Step ${i + 1}: ${agentName}`), w), 0, 0));
			c.addChild(new Text(theme.fg("dim", `    status: ○ pending`), 0, 0));
			c.addChild(new Spacer(1));
			continue;
		}
		const progressFromArray = d.progress?.find((p) => p.index === i) || d.progress?.find((p) => hasProgressStatus(p) && p.agent === r.agent && p.status === "running");
		const rProg = r.progress || progressFromArray || r.progressSummary;
		const rRunning = hasProgressStatus(rProg) && rProg.status === "running";
		const resultOutput = getSingleResultOutput(r);
		const statusIcon = rRunning
			? theme.fg("warning", "●")
			: r.exitCode !== 0
				? theme.fg("error", "✗")
				: hasEmptyTextOutputWithoutOutputTarget(r.task, resultOutput)
					? theme.fg("warning", "⚠")
					: theme.fg("success", "✓");
		const stats = rProg ? ` | ${rProg.toolCount} tools, ${formatDuration(rProg.durationMs)}` : "";
		const modelDisplay = r.model ? theme.fg("dim", ` (${r.model})`) : "";
		const stepHeader = rRunning
			? `${statusIcon} Step ${i + 1}: ${theme.bold(theme.fg("warning", r.agent))}${modelDisplay}${stats}`
			: `${statusIcon} Step ${i + 1}: ${theme.bold(r.agent)}${modelDisplay}${stats}`;
		c.addChild(new Text(truncLine(stepHeader, w), 0, 0));
		const taskMaxLen = Math.max(20, w - 12);
		const taskPreview = r.task.length > taskMaxLen ? `${r.task.slice(0, taskMaxLen)}...` : r.task;
		c.addChild(new Text(truncLine(theme.fg("dim", `    task: ${taskPreview}`), w), 0, 0));
		const outputTarget = extractOutputTarget(r.task);
		if (outputTarget) c.addChild(new Text(truncLine(theme.fg("dim", `    output: ${outputTarget}`), w), 0, 0));
		if (r.skills?.length) c.addChild(new Text(truncLine(theme.fg("dim", `    skills: ${r.skills.join(", ")}`), w), 0, 0));
		if (r.skillsWarning) c.addChild(new Text(truncLine(theme.fg("warning", `    ⚠️ ${r.skillsWarning}`), w), 0, 0));
		if (r.attemptedModels && r.attemptedModels.length > 1) c.addChild(new Text(truncLine(theme.fg("dim", `    fallbacks: ${r.attemptedModels.join(" → ")}`), w), 0, 0));
		if (rRunning && hasProgressStatus(rProg)) {
			if (hasProgressStatus(rProg) && rProg.skills?.length) c.addChild(new Text(truncLine(theme.fg("accent", `    skills: ${rProg.skills.join(", ")}`), w), 0, 0));
			if (rProg.currentTool) {
				const maxToolArgsLen = Math.max(50, w - 20);
				const toolArgsPreview = rProg.currentToolArgs
					? (rProg.currentToolArgs.length > maxToolArgsLen ? `${rProg.currentToolArgs.slice(0, maxToolArgsLen)}...` : rProg.currentToolArgs)
					: "";
				const toolLine = toolArgsPreview ? `${rProg.currentTool}: ${toolArgsPreview}` : rProg.currentTool;
				c.addChild(new Text(truncLine(theme.fg("warning", `    > ${toolLine}`), w), 0, 0));
			}
			if (rProg.recentTools?.length) {
				for (const t of rProg.recentTools.slice(-3)) {
					const maxArgsLen = Math.max(40, w - 30);
					const argsPreview = t.args.length > maxArgsLen ? `${t.args.slice(0, maxArgsLen)}...` : t.args;
					c.addChild(new Text(truncLine(theme.fg("dim", `      ${t.tool}: ${argsPreview}`), w), 0, 0));
				}
			}
			for (const line of (rProg.recentOutput ?? []).slice(-5)) {
				c.addChild(new Text(truncLine(theme.fg("dim", `      ${line}`), w), 0, 0));
			}
		}
		c.addChild(new Spacer(1));
	}
	if (d.artifacts) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(truncLine(theme.fg("dim", `Artifacts dir: ${shortenPath(d.artifacts.dir)}`), w), 0, 0));
	}
	return c;
}
