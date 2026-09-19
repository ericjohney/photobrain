import { useInngestSubscription } from "@inngest/realtime/hooks";
import { Inngest } from "inngest";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

interface ProgressData {
	phase: (typeof PROGRESS_PHASES)[number];
	current: number;
	total: number;
}

function decodeProgressMessage(message: unknown): ProgressData | null {
	if (typeof message !== "object" || message === null) return null;
	const candidate =
		"data" in message &&
		typeof message.data === "object" &&
		message.data !== null
			? message.data
			: message;
	if (
		!("phase" in candidate) ||
		typeof candidate.phase !== "string" ||
		!PROGRESS_PHASES.includes(candidate.phase as ProgressData["phase"]) ||
		!("current" in candidate) ||
		typeof candidate.current !== "number" ||
		!("total" in candidate) ||
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

function isTerminal(progress: ProgressData | null) {
	return progress?.phase === "completed" || progress?.phase === "failed";
}

function compareProgress(left: ProgressData, right: ProgressData) {
	return (
		PROGRESS_PHASES.indexOf(left.phase) -
			PROGRESS_PHASES.indexOf(right.phase) ||
		left.current - right.current ||
		left.total - right.total
	);
}

export function useJobProgress(jobId: string | null) {
	const utils = trpc.useUtils();
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
	const isDurableTerminal = isTerminal(durableProgress);
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
	const token = useMemo(() => {
		const response = tokenQuery.data;
		if (!response?.baseUrl) return response?.token;
		return {
			...response.token,
			app: new Inngest({ id: "photobrain", baseUrl: response.baseUrl }),
		};
	}, [tokenQuery.data]);
	const refreshToken = useCallback(async () => {
		const result = await tokenQuery.refetch();
		if (result.error) throw result.error;
		if (!result.data?.token) {
			throw new Error("Could not refresh Realtime token");
		}
		return result.data.baseUrl
			? {
					...result.data.token,
					app: new Inngest({ id: "photobrain", baseUrl: result.data.baseUrl }),
				}
			: result.data.token;
	}, [tokenQuery.refetch]);

	const { data, latestData, error, state } = useInngestSubscription({
		token,
		refreshToken,
		enabled: Boolean(jobId && token && !isDurableTerminal && !isMissingJob),
		key: jobId ?? undefined,
	});
	const allMessages = useMemo(() => {
		const messages = data?.length ? data : latestData ? [latestData] : [];
		return messages
			.filter(
				(message) =>
					!message ||
					typeof message.channel !== "string" ||
					message.channel === `job:${jobId}`,
			)
			.map(decodeProgressMessage)
			.filter((message): message is ProgressData => message !== null);
	}, [data, jobId, latestData]);
	const candidate = useMemo(() => {
		if (!jobId) return null;
		if (isMissingJob) return { phase: "failed" as const, current: 0, total: 0 };
		if (isDurableTerminal) return durableProgress;
		let latest = durableProgress;
		for (const message of allMessages) {
			if (isTerminal(latest)) break;
			if (!latest || compareProgress(message, latest) > 0) latest = message;
		}
		return latest;
	}, [allMessages, durableProgress, isDurableTerminal, isMissingJob, jobId]);
	const [accepted, setAccepted] = useState<{
		jobId: string | null;
		progress: ProgressData | null;
	}>({ jobId: null, progress: null });

	useEffect(() => {
		setAccepted((previous) => {
			if (previous.jobId !== jobId) return { jobId, progress: candidate };
			if (!candidate) return previous;
			if (
				previous.progress &&
				compareProgress(candidate, previous.progress) === 0
			) {
				return previous;
			}
			if (
				!previous.progress ||
				isDurableTerminal ||
				isMissingJob ||
				(!isTerminal(previous.progress) &&
					compareProgress(candidate, previous.progress) > 0)
			) {
				return { jobId, progress: candidate };
			}
			return previous;
		});
	}, [candidate, isDurableTerminal, isMissingJob, jobId]);

	const latest = accepted.jobId === jobId ? accepted.progress : null;
	const progress = {
		phase: latest?.phase ?? null,
		current: latest?.current ?? 0,
		total: latest?.total ?? 0,
		percentage:
			latest && latest.total > 0
				? Math.min(100, Math.round((latest.current / latest.total) * 100))
				: 0,
	};
	const isCompleted = progress.phase === "completed";
	const isFailed = progress.phase === "failed";
	const isActive = Boolean(jobId) && !isCompleted && !isFailed;
	const refreshLibrary = useCallback(() => {
		void utils.photos.invalidate();
		void utils.folders.invalidate();
		void utils.filterOptions.invalidate();
	}, [utils.photos, utils.folders, utils.filterOptions]);
	const refreshState = useRef({
		jobId: null as string | null,
		current: 0,
		phase: null as ProgressData["phase"] | null,
		terminal: false,
		lastRefresh: null as number | null,
		timer: undefined as number | undefined,
	});

	useEffect(() => {
		const refresh = refreshState.current;
		refresh.jobId = jobId;
		refresh.current = 0;
		refresh.phase = null;
		refresh.terminal = false;
		refresh.lastRefresh = null;
		return () => {
			refresh.jobId = null;
			window.clearTimeout(refresh.timer);
			refresh.timer = undefined;
		};
	}, [jobId]);

	useEffect(() => {
		if (!jobId || !latest) return;
		const refresh = refreshState.current;
		if (refresh.jobId !== jobId || refresh.terminal) return;
		const cancelPending = () => {
			window.clearTimeout(refresh.timer);
			refresh.timer = undefined;
		};
		const flush = () => {
			if (refresh.jobId !== jobId) return;
			cancelPending();
			refresh.lastRefresh = Date.now();
			refreshLibrary();
		};
		if (isTerminal(latest)) {
			refresh.terminal = true;
			flush();
			void utils.searchPhotos.invalidate();
			return;
		}
		if (
			(latest.phase === "scan-complete" || latest.phase === "embedding") &&
			refresh.phase !== latest.phase
		) {
			refresh.phase = latest.phase;
			flush();
			return;
		}
		if (latest.phase !== "processing" || latest.current <= refresh.current) {
			return;
		}
		refresh.current = latest.current;
		const remaining =
			refresh.lastRefresh === null
				? 0
				: 1000 - (Date.now() - refresh.lastRefresh);
		if (remaining <= 0) flush();
		else if (refresh.timer === undefined) {
			refresh.timer = window.setTimeout(flush, remaining);
		}
	}, [jobId, latest, refreshLibrary, utils.searchPhotos]);

	return {
		progress,
		isActive,
		isCompleted,
		isFailed,
		isConnected: state === "active",
		error,
		allMessages,
	};
}
