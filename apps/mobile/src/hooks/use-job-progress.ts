import { useInngestSubscription } from "@inngest/realtime/hooks";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { trpc } from "@/lib/trpc";

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

export function useJobProgress(jobId: string | null) {
	const utils = trpc.useUtils();
	const invalidatedJob = useRef<string | null>(null);
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
	const refreshRealtimeToken = useCallback(async () => {
		const result = await tokenQuery.refetch();
		if (result.error) throw result.error;
		if (!result.data?.token) {
			throw new Error("Could not refresh Realtime token");
		}
		return result.data.token;
	}, [tokenQuery.refetch]);

	const { data, latestData, state } = useInngestSubscription({
		token: tokenQuery.data?.token,
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

	useEffect(() => {
		if (
			!jobId ||
			(!isCompleted && !isFailed) ||
			invalidatedJob.current === jobId
		) {
			return;
		}
		invalidatedJob.current = jobId;
		void Promise.all([
			utils.photos.invalidate(),
			utils.folders.invalidate(),
			utils.filterOptions.invalidate(),
			utils.searchPhotos.invalidate(),
		]);
	}, [
		isCompleted,
		isFailed,
		jobId,
		utils.filterOptions,
		utils.folders,
		utils.photos,
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
