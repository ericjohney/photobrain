import { useInngestSubscription } from "@inngest/realtime/hooks";
import { Inngest } from "inngest";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { trpc } from "@/lib/trpc";

const nativeWebSocket = globalThis.WebSocket;
if (nativeWebSocket) {
	// Inngest passes a WHATWG URL object, but React Native 0.86's native module
	// requires a string and aborts the app before JavaScript can handle the error.
	globalThis.WebSocket = new Proxy(nativeWebSocket, {
		construct(target, args, newTarget) {
			const [url, ...rest] = args;
			return Reflect.construct(target, [String(url), ...rest], newTarget);
		},
	});
}

const PROGRESS_PHASES = [
	"queued",
	"discovering",
	"processing",
	"scan-complete",
	"embedding",
	"completed",
	"failed",
] as const;

const EMPTY_JOB_ID = "00000000-0000-0000-0000-000000000000";
const PHASE_ORDER = new Map(
	PROGRESS_PHASES.map((phase, index) => [phase, index]),
);

export interface ProgressData {
	phase: (typeof PROGRESS_PHASES)[number];
	current: number;
	total: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function decodeProgressMessage(message: unknown): ProgressData | null {
	if (!isRecord(message)) return null;
	const candidate = isRecord(message.data) ? message.data : message;
	if (
		typeof candidate.phase !== "string" ||
		!PROGRESS_PHASES.includes(candidate.phase as ProgressData["phase"]) ||
		typeof candidate.current !== "number" ||
		typeof candidate.total !== "number"
	) {
		return null;
	}

	return {
		phase: candidate.phase as ProgressData["phase"],
		current: candidate.current,
		total: candidate.total,
	};
}

function belongsToJob(message: unknown, jobId: string | null) {
	if (!jobId || !isRecord(message) || typeof message.channel !== "string") {
		return true;
	}
	return message.channel === `job:${jobId}`;
}

function getTimestamp(value: unknown): number | null {
	if (value instanceof Date) return value.getTime();
	if (typeof value !== "string" && typeof value !== "number") return null;
	const timestamp = new Date(value).getTime();
	return Number.isNaN(timestamp) ? null : timestamp;
}

function getMessageTimestamp(message: unknown): number | null {
	if (!isRecord(message)) return null;
	return getTimestamp(message.createdAt ?? message.created_at);
}

function compareProgress(left: ProgressData, right: ProgressData) {
	const phaseDifference =
		(PHASE_ORDER.get(left.phase) ?? 0) - (PHASE_ORDER.get(right.phase) ?? 0);
	if (phaseDifference !== 0) return phaseDifference;
	if (left.current !== right.current) return left.current - right.current;
	return left.total - right.total;
}

function toWebSocketBaseUrl(baseUrl: string) {
	if (baseUrl.startsWith("https://")) {
		return `wss://${baseUrl.slice("https://".length)}`;
	}
	if (baseUrl.startsWith("http://")) {
		return `ws://${baseUrl.slice("http://".length)}`;
	}
	return baseUrl;
}

export function useJobProgress(jobId: string | null) {
	const utils = trpc.useUtils();
	const refreshState = useRef({
		jobId,
		current: 0,
		scanComplete: false,
		embedding: false,
		terminal: false,
		lastRefreshAt: null as number | null,
	});
	const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const statusQuery = trpc.scanStatus.useQuery(
		{ jobId: jobId ?? EMPTY_JOB_ID },
		{
			enabled: Boolean(jobId),
			refetchInterval: (query) => {
				if (query.state.status === "success" && query.state.data === null) {
					return false;
				}
				const status = query.state.data?.status;
				return status === "completed" || status === "failed" ? false : 1500;
			},
		},
	);
	const durableProgress = useMemo(
		() => decodeProgressMessage(statusQuery.data),
		[statusQuery.data],
	);
	const isMissingJob =
		Boolean(jobId) && statusQuery.isSuccess && statusQuery.data === null;
	const isDurableTerminal =
		durableProgress?.phase === "completed" ||
		durableProgress?.phase === "failed";
	const tokenQuery = trpc.realtimeToken.useQuery(
		{ jobId: jobId ?? EMPTY_JOB_ID },
		{
			enabled: Boolean(jobId && !isDurableTerminal && !isMissingJob),
			staleTime: Number.POSITIVE_INFINITY,
			retry: 3,
			refetchInterval: (query) =>
				query.state.status === "error" ? 5000 : false,
		},
	);
	const realtimeToken = useMemo(() => {
		const response = tokenQuery.data;
		if (!response?.baseUrl) return response?.token;
		return {
			...response.token,
			app: new Inngest({
				id: "photobrain",
				baseUrl: toWebSocketBaseUrl(response.baseUrl),
			}),
		};
	}, [tokenQuery.data]);
	const refreshRealtimeToken = useCallback(async () => {
		const result = await tokenQuery.refetch();
		if (result.error) throw result.error;
		if (!result.data?.token) {
			throw new Error("Could not refresh Realtime token");
		}
		return result.data.baseUrl
			? {
					...result.data.token,
					app: new Inngest({
						id: "photobrain",
						baseUrl: toWebSocketBaseUrl(result.data.baseUrl),
					}),
				}
			: result.data.token;
	}, [tokenQuery.refetch]);

	const { data, latestData, state } = useInngestSubscription({
		token: realtimeToken,
		refreshToken: refreshRealtimeToken,
		enabled: Boolean(
			jobId && tokenQuery.data?.token && !isDurableTerminal && !isMissingJob,
		),
		key: jobId ?? undefined,
	});

	const realtimeMessages = useMemo(() => {
		const messages = data?.length ? data : latestData ? [latestData] : [];
		return messages.filter((message) => belongsToJob(message, jobId));
	}, [data, jobId, latestData]);
	const realtimeUpdate = useMemo(() => {
		for (let index = realtimeMessages.length - 1; index >= 0; index--) {
			const decoded = decodeProgressMessage(realtimeMessages[index]);
			if (decoded) {
				const message = realtimeMessages[index];
				return {
					progress: decoded,
					updatedAt: getMessageTimestamp(message),
				};
			}
		}
		return null;
	}, [realtimeMessages]);
	const realtimeProgress = realtimeUpdate?.progress ?? null;
	const realtimeUpdatedAt = realtimeUpdate?.updatedAt ?? null;
	const durableUpdatedAt = getTimestamp(statusQuery.data?.updatedAt);
	const progressDifference =
		realtimeProgress && durableProgress
			? compareProgress(realtimeProgress, durableProgress)
			: 0;
	const realtimeIsNewer =
		progressDifference !== 0
			? progressDifference > 0
			: realtimeUpdatedAt !== null && durableUpdatedAt !== null
				? realtimeUpdatedAt >= durableUpdatedAt
				: state === "active";
	const nonTerminalProgress =
		realtimeProgress && durableProgress
			? realtimeIsNewer
				? realtimeProgress
				: durableProgress
			: (realtimeProgress ?? durableProgress);
	const latest = isMissingJob
		? { phase: "failed" as const, current: 0, total: 0 }
		: isDurableTerminal
			? durableProgress
			: nonTerminalProgress;
	const progress = useMemo(() => {
		if (!latest) {
			return {
				phase: null as ProgressData["phase"] | null,
				current: 0,
				total: 0,
				percentage: 0,
			};
		}

		return {
			...latest,
			percentage:
				latest.total > 0
					? Math.min(100, Math.round((latest.current / latest.total) * 100))
					: 0,
		};
	}, [latest]);
	const isCompleted = progress.phase === "completed";
	const isFailed = progress.phase === "failed" || isMissingJob;
	const isActive =
		Boolean(jobId) &&
		progress.phase !== "completed" &&
		progress.phase !== "failed" &&
		!isMissingJob;

	const cancelPendingRefresh = useCallback(() => {
		if (refreshTimer.current !== null) {
			clearTimeout(refreshTimer.current);
			refreshTimer.current = null;
		}
	}, []);
	const refreshLibrary = useCallback(() => {
		if (!jobId || refreshState.current.jobId !== jobId) return;
		refreshState.current.lastRefreshAt = Date.now();
		void Promise.all([
			utils.photos.invalidate(),
			utils.folders.invalidate(),
			utils.filterOptions.invalidate(),
		]);
	}, [jobId, utils.filterOptions, utils.folders, utils.photos]);

	useEffect(() => {
		refreshState.current = {
			jobId,
			current: 0,
			scanComplete: false,
			embedding: false,
			terminal: false,
			lastRefreshAt: null,
		};
		return () => {
			refreshState.current.jobId = null;
			cancelPendingRefresh();
		};
	}, [jobId, cancelPendingRefresh]);

	useEffect(() => {
		const observed = refreshState.current;
		if (!jobId || observed.jobId !== jobId || observed.terminal) return;
		if (isCompleted || isFailed) {
			observed.terminal = true;
			cancelPendingRefresh();
			refreshLibrary();
			void utils.searchPhotos.invalidate();
			return;
		}

		if (
			(progress.phase === "scan-complete" &&
				!observed.scanComplete &&
				!observed.embedding) ||
			(progress.phase === "embedding" && !observed.embedding)
		) {
			if (progress.phase === "scan-complete") observed.scanComplete = true;
			else observed.embedding = true;
			cancelPendingRefresh();
			refreshLibrary();
			return;
		}

		if (
			progress.phase !== "processing" ||
			observed.scanComplete ||
			observed.embedding ||
			progress.current <= observed.current
		) {
			return;
		}
		observed.current = progress.current;
		const remaining =
			observed.lastRefreshAt === null
				? 0
				: 1000 - (Date.now() - observed.lastRefreshAt);
		if (remaining <= 0) {
			cancelPendingRefresh();
			refreshLibrary();
		} else if (refreshTimer.current === null) {
			refreshTimer.current = setTimeout(() => {
				if (refreshState.current !== observed || observed.jobId !== jobId) {
					return;
				}
				refreshTimer.current = null;
				refreshLibrary();
			}, remaining);
		}
	}, [
		cancelPendingRefresh,
		isCompleted,
		isFailed,
		jobId,
		progress.current,
		progress.phase,
		refreshLibrary,
		utils.searchPhotos,
	]);

	const allMessages = useMemo(
		() =>
			realtimeMessages
				.map(decodeProgressMessage)
				.filter((item): item is ProgressData => item !== null),
		[realtimeMessages],
	);

	return {
		progress,
		isActive,
		isCompleted,
		isFailed,
		isConnected: state === "active",
		error:
			isActive && !latest && statusQuery.error
				? "Unable to check scan status. Retrying automatically."
				: null,
		failureMessage: isMissingJob
			? "Scan job was not found."
			: (statusQuery.data?.error ?? null),
		allMessages,
	};
}
