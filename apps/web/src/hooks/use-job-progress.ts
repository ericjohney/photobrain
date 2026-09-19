import { useInngestSubscription } from "@inngest/realtime/hooks";
import { Inngest } from "inngest";
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

	const tokenQuery = trpc.realtimeToken.useQuery(
		{ jobId: jobId ?? "" },
		{ enabled: Boolean(jobId), staleTime: Number.POSITIVE_INFINITY },
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
		enabled: Boolean(jobId && token),
		key: jobId ?? undefined,
	});

	// Compute derived progress state
	const progress = useMemo(() => {
		const latest = latestData?.data as ProgressData | null | undefined;
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
