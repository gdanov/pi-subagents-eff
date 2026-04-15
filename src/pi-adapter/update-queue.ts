import { Effect } from "effect";
import type { AgentProgress } from "../domain/progress.ts";
import type { SingleResult } from "../domain/results.ts";

export interface UpdateQueueOptions {
	readonly onUpdate: (partial: { readonly result: SingleResult; readonly progress: AgentProgress }) => void;
}

export function makeUpdateQueue(options: UpdateQueueOptions) {
	const pending: Array<{ readonly result: SingleResult; readonly progress: AgentProgress }> = [];
	let draining = false;

	const processNext = () => {
		while (pending.length > 0) {
			const item = pending.shift();
			if (item) options.onUpdate(item);
		}
		draining = false;
	};

	return {
		offer: (partial: { readonly result: SingleResult; readonly progress: AgentProgress }) => {
			pending.push(partial);
			if (!draining) {
				draining = true;
				processNext();
			}
		},
		run: Effect.gen(function* () {
			processNext();
		}),
	};
}
