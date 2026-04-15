import { Effect, Layer, ManagedRuntime } from "effect";
import { AgentDirectory, AgentDirectoryLive } from "../services/AgentDirectory.ts";
import { ArtifactStore, ArtifactStoreLive } from "../services/ArtifactStore.ts";
import { SubagentsClock, SubagentsClockLive } from "../services/Clock.ts";
import { ConfigReader, ConfigReaderLive } from "../services/ConfigReader.ts";
import { FileSystem, FileSystemLive } from "../services/FileSystem.ts";
import { GhSpawner, GhSpawnerLive } from "../services/GhSpawner.ts";
import { GitSpawner, GitSpawnerLive } from "../services/GitSpawner.ts";
import { IntercomBridge, IntercomBridgeLive } from "../services/IntercomBridge.ts";
import { ModelResolver, ModelResolverLive } from "../services/ModelResolver.ts";
import { Notifier, NotifierLive } from "../services/Notifier.ts";
import { PiEventBus, PiEventBusLive } from "../services/PiEventBus.ts";
import { PiSpawner, PiSpawnerLive } from "../services/PiSpawner.ts";
import { ResultWatcher, ResultWatcherLive } from "../services/ResultWatcher.ts";
import { RunHistory, RunHistoryLive } from "../services/RunHistory.ts";
import { SessionStore, SessionStoreLive } from "../services/SessionStore.ts";
import { SkillResolver, SkillResolverLive } from "../services/SkillResolver.ts";
import { SlashBridge, SlashBridgeLive } from "../services/SlashBridge.ts";
import { SlashLiveState, SlashLiveStateLive } from "../services/SlashLiveState.ts";

const AllLayers = Layer.mergeAll(
	AgentDirectoryLive,
	ArtifactStoreLive,
	SubagentsClockLive,
	ConfigReaderLive,
	FileSystemLive,
	GhSpawnerLive,
	GitSpawnerLive,
	IntercomBridgeLive,
	ModelResolverLive,
	NotifierLive,
	PiEventBusLive,
	PiSpawnerLive,
	ResultWatcherLive,
	RunHistoryLive,
	SessionStoreLive,
	SkillResolverLive,
	SlashBridgeLive,
	SlashLiveStateLive,
);

export type AllServices = AgentDirectory | ArtifactStore | SubagentsClock | ConfigReader | FileSystem | GhSpawner | GitSpawner | IntercomBridge | ModelResolver | Notifier | PiEventBus | PiSpawner | ResultWatcher | RunHistory | SessionStore | SkillResolver | SlashBridge | SlashLiveState;

let _runtime: ManagedRuntime.ManagedRuntime<AllServices, unknown> | undefined;

export function buildRuntime(): ManagedRuntime.ManagedRuntime<AllServices, unknown> {
	if (_runtime) return _runtime;
	_runtime = ManagedRuntime.make(AllLayers as Layer.Layer<AllServices, never, never>);
	return _runtime;
}

export async function disposeRuntime(): Promise<void> {
	if (_runtime) {
		await _runtime.dispose();
		_runtime = undefined;
	}
}
