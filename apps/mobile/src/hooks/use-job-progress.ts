import { useInngestSubscription } from "@inngest/realtime/hooks";
import { useCallback, useMemo } from "react";
import { trpc } from "@/lib/trpc";

// Progress data shape from Inngest functions
interface ProgressData {
	phase:
		| "discovering"
		| "processing"
		| "embedding"
		| "scan-complete"
		| "completed";
	current: number;
	total: number;
}

export function useJobProgress(jobId: string | null) {
	const utils = trpc.useUtils();

	// Fetch token from tRPC
	const refreshToken = useCallback(async () => {
		if (!jobId) return null;
		const { token } = await utils.realtimeToken.fetch({ jobId });
		return token;
	}, [jobId, utils.realtimeToken]);

	const { data, latestData, error, state } = useInngestSubscription({
		refreshToken,
		enabled: !!jobId,
		key: jobId ?? undefined,
	});

	// Compute derived progress state
	const progress = useMemo(() => {
		const latest = latestData as ProgressData | null;
		if (!latest) {
			return {
				phase: null as string | null,
				current: 0,
				total: 0,
				percentage: 0,
			};
		}

		return {
			phase: latest.phase,
			current: latest.current,
			total: latest.total,
			percentage:
				latest.total > 0
					? Math.round((latest.current / latest.total) * 100)
					: 0,
		};
	}, [latestData]);

	// Check if job is active
	const isActive = useMemo(() => {
		return (
			state === "active" &&
			progress.phase !== null &&
			progress.phase !== "completed"
		);
	}, [state, progress.phase]);

	// Check if job completed
	const isCompleted = useMemo(() => {
		return progress.phase === "completed" || progress.phase === "scan-complete";
	}, [progress.phase]);

	// Invalidate photos query when scan completes
	const handleComplete = useCallback(() => {
		utils.photos.invalidate();
		utils.folders.invalidate();
	}, [utils.photos, utils.folders]);

	// Watch for completion
	useMemo(() => {
		if (isCompleted) {
			handleComplete();
		}
	}, [isCompleted, handleComplete]);

	return {
		progress,
		isActive,
		isCompleted,
		isConnected: state === "active",
		error,
		allMessages: data as ProgressData[],
	};
}
