import { act, renderHook, waitFor } from "@testing-library/react-native";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_JOB_ID = "22222222-2222-4222-8222-222222222222";

const mockPhotosInvalidate = jest.fn();
const mockFoldersInvalidate = jest.fn();
const mockFilterOptionsInvalidate = jest.fn();
const mockSearchPhotosInvalidate = jest.fn();
const mockRealtimeTokenUseQuery = jest.fn();
const mockScanStatusUseQuery = jest.fn();
const mockUseInngestSubscription = jest.fn();
const mockInngestConstructor = jest.fn(
	(options: { id: string; baseUrl?: string }) => ({
		apiBaseUrl: options.baseUrl,
	}),
);

interface ProgressMessage {
	channel: string;
	data: { phase: string; current: number; total: number };
	createdAt?: Date;
}

interface TokenQueryResult {
	data?: { token: { jwt: string }; baseUrl?: string };
	error: Error | null;
	refetch: jest.Mock;
}

interface StatusQueryResult {
	data:
		| {
				phase: string;
				current: number;
				total: number;
				status: string;
				error: string | null;
				updatedAt?: Date;
		  }
		| null
		| undefined;
	isSuccess: boolean;
	error: Error | null;
}

interface SubscriptionResult {
	data: ProgressMessage[];
	latestData: ProgressMessage | null;
	error: Error | null;
	state: string;
}

let mockTokenQueryResult: TokenQueryResult;
let mockStatusQueryResult: StatusQueryResult;
let mockSubscriptionResult: SubscriptionResult;

jest.mock("inngest", () => ({
	Inngest: mockInngestConstructor,
}));

jest.mock("@/lib/trpc", () => ({
	trpc: {
		useUtils: () => ({
			photos: { invalidate: mockPhotosInvalidate },
			folders: { invalidate: mockFoldersInvalidate },
			filterOptions: { invalidate: mockFilterOptionsInvalidate },
			searchPhotos: { invalidate: mockSearchPhotosInvalidate },
		}),
		realtimeToken: {
			useQuery: (input: unknown, options: unknown) => {
				mockRealtimeTokenUseQuery(input, options);
				return mockTokenQueryResult;
			},
		},
		scanStatus: {
			useQuery: (input: unknown, options: unknown) => {
				mockScanStatusUseQuery(input, options);
				return mockStatusQueryResult;
			},
		},
	},
}));

jest.mock("@inngest/realtime/hooks", () => ({
	useInngestSubscription: (options: unknown) => {
		mockUseInngestSubscription(options);
		return mockSubscriptionResult;
	},
}));

jest.unmock("@/hooks/use-job-progress");

const {
	decodeProgressMessage,
	useJobProgress,
} = require("@/hooks/use-job-progress");

function resetResults() {
	mockTokenQueryResult = {
		data: { token: { jwt: "test-token" } },
		error: null,
		refetch: jest.fn().mockResolvedValue({
			data: { token: { jwt: "refreshed-token" } },
			error: null,
		}),
	};
	mockStatusQueryResult = {
		data: {
			phase: "processing",
			current: 1,
			total: 4,
			status: "running",
			error: null,
		},
		isSuccess: true,
		error: null,
	};
	mockSubscriptionResult = {
		data: [],
		latestData: null,
		error: null,
		state: "active",
	};
}

describe("useJobProgress", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		resetResults();
	});

	it("decodes direct and Realtime-wrapped progress messages", () => {
		expect(
			decodeProgressMessage({ phase: "processing", current: 2, total: 5 }),
		).toEqual({ phase: "processing", current: 2, total: 5 });
		expect(
			decodeProgressMessage({
				channel: `job:${JOB_ID}`,
				data: { phase: "embedding", current: 3, total: 6 },
			}),
		).toEqual({ phase: "embedding", current: 3, total: 6 });
		expect(decodeProgressMessage({ phase: "unknown", current: 1 })).toBeNull();
	});

	it("keeps a restored job active while its status is unknown", () => {
		mockStatusQueryResult = {
			data: undefined,
			isSuccess: false,
			error: null,
		};
		const { result } = renderHook(() => useJobProgress(JOB_ID));

		expect(result.current).toMatchObject({
			progress: { phase: null, current: 0, total: 0 },
			isActive: true,
			isCompleted: false,
			isFailed: false,
			error: null,
			failureMessage: null,
		});
		expect(mockScanStatusUseQuery).toHaveBeenCalledWith(
			{ jobId: JOB_ID },
			expect.objectContaining({ enabled: true }),
		);
		expect(mockPhotosInvalidate).not.toHaveBeenCalled();
	});

	it("reports unavailable progress without losing the job and recovers on polling", () => {
		mockStatusQueryResult = {
			data: undefined,
			isSuccess: false,
			error: new Error("Network unavailable"),
		};
		const { result, rerender } = renderHook(() => useJobProgress(JOB_ID));

		expect(result.current).toMatchObject({
			progress: { phase: null },
			isActive: true,
			isCompleted: false,
			isFailed: false,
			error: "Unable to check scan status. Retrying automatically.",
			failureMessage: null,
		});
		expect(mockScanStatusUseQuery).toHaveBeenLastCalledWith(
			{ jobId: JOB_ID },
			expect.objectContaining({ enabled: true }),
		);
		const queryOptions = mockScanStatusUseQuery.mock.calls.at(-1)?.[1];
		expect(
			queryOptions.refetchInterval({
				state: { status: "error", data: undefined },
			}),
		).toBe(1500);
		expect(mockPhotosInvalidate).not.toHaveBeenCalled();

		resetResults();
		rerender({});
		expect(result.current.progress.phase).toBe("processing");
		expect(result.current.error).toBeNull();
		expect(result.current.isActive).toBe(true);
	});

	it("uses Realtime progress when durable recovery fails", () => {
		mockStatusQueryResult = {
			data: undefined,
			isSuccess: false,
			error: new Error("Network unavailable"),
		};
		const { result, rerender } = renderHook(() => useJobProgress(JOB_ID));
		expect(result.current.error).not.toBeNull();

		mockSubscriptionResult.latestData = {
			channel: `job:${JOB_ID}`,
			data: { phase: "processing", current: 2, total: 4 },
		};
		rerender({});
		expect(result.current.progress).toMatchObject({
			phase: "processing",
			current: 2,
			percentage: 50,
		});
		expect(result.current.error).toBeNull();
		expect(result.current.isActive).toBe(true);
	});

	it("keeps cached durable progress on a failed refetch", () => {
		mockStatusQueryResult.isSuccess = false;
		mockStatusQueryResult.error = new Error("Network unavailable");
		mockSubscriptionResult.error = new Error("Realtime unavailable");
		mockSubscriptionResult.state = "closed";
		const { result } = renderHook(() => useJobProgress(JOB_ID));

		expect(result.current.progress.phase).toBe("processing");
		expect(result.current.error).toBeNull();
		expect(result.current.isActive).toBe(true);
	});

	it("does not treat Realtime errors alone as a durable recovery failure", () => {
		mockStatusQueryResult = {
			data: undefined,
			isSuccess: false,
			error: null,
		};
		mockTokenQueryResult.error = new Error("Token unavailable");
		mockSubscriptionResult.error = new Error("Realtime unavailable");
		const { result } = renderHook(() => useJobProgress(JOB_ID));

		expect(result.current.progress.phase).toBeNull();
		expect(result.current.error).toBeNull();
		expect(result.current.isFailed).toBe(false);
	});

	it("does not show recovery errors without an active job", () => {
		mockStatusQueryResult = {
			data: undefined,
			isSuccess: false,
			error: new Error("Network unavailable"),
		};
		const { result } = renderHook(() => useJobProgress(null));

		expect(result.current.isActive).toBe(false);
		expect(result.current.error).toBeNull();
	});

	it("does not let the previous job's Realtime progress hide a recovery error", () => {
		mockSubscriptionResult.latestData = {
			channel: `job:${JOB_ID}`,
			data: { phase: "completed", current: 4, total: 4 },
		};
		const { result, rerender } = renderHook(
			({ jobId }) => useJobProgress(jobId),
			{ initialProps: { jobId: JOB_ID } },
		);
		expect(result.current.isCompleted).toBe(true);

		mockStatusQueryResult = {
			data: undefined,
			isSuccess: false,
			error: new Error("Network unavailable"),
		};
		rerender({ jobId: OTHER_JOB_ID });
		expect(result.current.progress.phase).toBeNull();
		expect(result.current.error).not.toBeNull();
		expect(result.current.isActive).toBe(true);
		expect(result.current.isCompleted).toBe(false);
	});

	it.each([
		"completed",
		"failed",
	])("keeps durable %s status despite a refetch error and late Realtime progress", (phase) => {
		mockStatusQueryResult.data = {
			phase,
			current: 4,
			total: 4,
			status: phase,
			error: phase === "failed" ? "Scan failed" : null,
		};
		const { result, rerender } = renderHook(() => useJobProgress(JOB_ID));
		mockStatusQueryResult.isSuccess = false;
		mockStatusQueryResult.error = new Error("Network unavailable");
		mockSubscriptionResult.latestData = {
			channel: `job:${JOB_ID}`,
			data: { phase: "processing", current: 2, total: 4 },
		};
		rerender({});

		expect(result.current.progress.phase).toBe(phase);
		expect(result.current.isActive).toBe(false);
		expect(result.current.isCompleted).toBe(phase === "completed");
		expect(result.current.isFailed).toBe(phase === "failed");
		expect(result.current.error).toBeNull();
		expect(mockPhotosInvalidate).toHaveBeenCalledTimes(1);
	});

	it("prefers current Realtime progress", () => {
		const message = {
			channel: `job:${JOB_ID}`,
			data: { phase: "processing", current: 3, total: 4 },
		};
		mockSubscriptionResult = {
			data: [message],
			latestData: message,
			error: null,
			state: "active",
		};

		const { result } = renderHook(() => useJobProgress(JOB_ID));

		expect(result.current.progress).toMatchObject({
			phase: "processing",
			current: 3,
			percentage: 75,
		});
		expect(result.current.isActive).toBe(true);
		expect(result.current.isConnected).toBe(true);
	});

	it("uses a WebSocket URL for self-hosted Realtime", () => {
		mockTokenQueryResult.data = {
			token: { jwt: "test-token" },
			baseUrl: "https://photobrain-api.example.com",
		};

		renderHook(() => useJobProgress(JOB_ID));

		expect(mockInngestConstructor).toHaveBeenCalledWith({
			id: "photobrain",
			baseUrl: "wss://photobrain-api.example.com",
		});
	});

	it("refreshes an expired Realtime token", async () => {
		renderHook(() => useJobProgress(JOB_ID));
		const options = mockUseInngestSubscription.mock.calls.at(-1)?.[0] as {
			refreshToken: () => Promise<{ jwt: string }>;
		};

		await expect(options.refreshToken()).resolves.toEqual({
			jwt: "refreshed-token",
		});
		expect(mockTokenQueryResult.refetch).toHaveBeenCalledTimes(1);
	});

	it("rejects a failed token refresh instead of returning cached data", async () => {
		const refreshError = new Error("Token service unavailable");
		mockTokenQueryResult.refetch.mockResolvedValue({
			data: { token: { jwt: "test-token" } },
			error: refreshError,
		});
		renderHook(() => useJobProgress(JOB_ID));
		const options = mockUseInngestSubscription.mock.calls.at(-1)?.[0] as {
			refreshToken: () => Promise<{ jwt: string }>;
		};

		await expect(options.refreshToken()).rejects.toBe(refreshError);
	});

	it("ignores retained Realtime messages from a previous job", () => {
		const staleMessage = {
			channel: `job:${OTHER_JOB_ID}`,
			data: { phase: "completed", current: 4, total: 4 },
		};
		mockSubscriptionResult = {
			data: [staleMessage],
			latestData: staleMessage,
			error: null,
			state: "active",
		};

		const { result } = renderHook(() => useJobProgress(JOB_ID));

		expect(result.current.progress.phase).toBe("processing");
		expect(result.current.isCompleted).toBe(false);
		expect(result.current.allMessages).toEqual([]);
	});

	it("prefers durable progress when Realtime is disconnected", () => {
		mockStatusQueryResult.data = {
			phase: "embedding",
			current: 3,
			total: 4,
			status: "running",
			error: null,
		};
		const staleMessage = {
			channel: `job:${JOB_ID}`,
			data: { phase: "processing", current: 1, total: 4 },
		};
		mockSubscriptionResult = {
			data: [staleMessage],
			latestData: staleMessage,
			error: null,
			state: "closed",
		};

		const { result } = renderHook(() => useJobProgress(JOB_ID));

		expect(result.current.progress).toMatchObject({
			phase: "embedding",
			current: 3,
		});
	});

	it("prefers newer durable progress while Realtime remains connected", () => {
		mockStatusQueryResult.data = {
			phase: "embedding",
			current: 3,
			total: 4,
			status: "running",
			error: null,
			updatedAt: new Date("2026-08-17T12:01:00.000Z"),
		};
		const staleMessage = {
			channel: `job:${JOB_ID}`,
			data: { phase: "processing", current: 1, total: 4 },
			createdAt: new Date("2026-08-17T12:00:00.000Z"),
		};
		mockSubscriptionResult = {
			data: [staleMessage],
			latestData: staleMessage,
			error: null,
			state: "active",
		};

		const { result } = renderHook(() => useJobProgress(JOB_ID));

		expect(result.current.progress).toMatchObject({
			phase: "embedding",
			current: 3,
		});
	});

	it("treats embedding progress as newer than scan completion", () => {
		mockStatusQueryResult.data = {
			phase: "scan-complete",
			current: 4,
			total: 4,
			status: "running",
			error: null,
		};
		const message = {
			channel: `job:${JOB_ID}`,
			data: { phase: "embedding", current: 1, total: 4 },
		};
		mockSubscriptionResult = {
			data: [message],
			latestData: message,
			error: null,
			state: "active",
		};

		const { result } = renderHook(() => useJobProgress(JOB_ID));

		expect(result.current.progress).toMatchObject({
			phase: "embedding",
			current: 1,
		});
	});

	it("uses durable terminal status and invalidates library queries", async () => {
		mockStatusQueryResult = {
			data: {
				phase: "completed",
				current: 4,
				total: 4,
				status: "completed",
				error: null,
			},
			isSuccess: true,
			error: null,
		};
		mockSubscriptionResult = {
			data: [
				{
					channel: `job:${JOB_ID}`,
					data: { phase: "processing", current: 2, total: 4 },
				},
			],
			latestData: null,
			error: null,
			state: "active",
		};

		const { result } = renderHook(() => useJobProgress(JOB_ID));

		expect(result.current.isCompleted).toBe(true);
		expect(result.current.isActive).toBe(false);
		await waitFor(() => expect(mockPhotosInvalidate).toHaveBeenCalledTimes(1));
		expect(mockFoldersInvalidate).toHaveBeenCalledTimes(1);
		expect(mockFilterOptionsInvalidate).toHaveBeenCalledTimes(1);
		expect(mockSearchPhotosInvalidate).toHaveBeenCalledTimes(1);
	});

	it("treats a missing durable job as terminal instead of polling forever", () => {
		mockStatusQueryResult = {
			data: null,
			isSuccess: true,
			error: null,
		};

		const { result } = renderHook(() => useJobProgress(JOB_ID));

		expect(result.current.isFailed).toBe(true);
		expect(result.current.isActive).toBe(false);
		expect(result.current.progress.phase).toBe("failed");
		expect(result.current.failureMessage).toBe("Scan job was not found.");
		expect(mockUseInngestSubscription).toHaveBeenCalledWith(
			expect.objectContaining({ enabled: false }),
		);
		const queryOptions = mockScanStatusUseQuery.mock.calls.at(-1)?.[1];
		expect(
			queryOptions.refetchInterval({
				state: { status: "success", data: null },
			}),
		).toBe(false);
	});

	describe("incremental library refresh", () => {
		beforeEach(() => {
			jest.useFakeTimers();
			setDurableProgress("processing", 0);
		});

		afterEach(() => {
			jest.useRealTimers();
		});

		function setDurableProgress(phase: string, current: number) {
			mockStatusQueryResult.data = {
				phase,
				current,
				total: 40,
				status: phase === "completed" || phase === "failed" ? phase : "running",
				error: phase === "failed" ? "Scan failed" : null,
			};
		}

		function setRealtimeProgress(phase: string, current: number) {
			mockSubscriptionResult.latestData = {
				channel: `job:${JOB_ID}`,
				data: { phase, current, total: 40 },
			};
		}

		function expectLibraryRefreshes(count: number) {
			expect(mockPhotosInvalidate).toHaveBeenCalledTimes(count);
			expect(mockFoldersInvalidate).toHaveBeenCalledTimes(count);
			expect(mockFilterOptionsInvalidate).toHaveBeenCalledTimes(count);
		}

		it("refreshes the first committed batch immediately and coalesces bursts without losing the last batch", () => {
			const { result, rerender } = renderHook(() => useJobProgress(JOB_ID));
			expectLibraryRefreshes(0);

			setRealtimeProgress("processing", 4);
			rerender({});
			expectLibraryRefreshes(1);
			expect(result.current.isCompleted).toBe(false);
			expect(result.current.progress.current).toBe(4);
			expect(mockSearchPhotosInvalidate).not.toHaveBeenCalled();

			act(() => jest.advanceTimersByTime(200));
			setRealtimeProgress("processing", 8);
			rerender({});
			act(() => jest.advanceTimersByTime(200));
			setRealtimeProgress("processing", 12);
			rerender({});
			expectLibraryRefreshes(1);

			act(() => jest.advanceTimersByTime(599));
			expectLibraryRefreshes(1);
			act(() => jest.advanceTimersByTime(1));
			expectLibraryRefreshes(2);
			expect(result.current.progress.current).toBe(12);
			expect(result.current.isCompleted).toBe(false);

			setRealtimeProgress("processing", 12);
			rerender({});
			setRealtimeProgress("processing", 8);
			rerender({});
			act(() => jest.advanceTimersByTime(5000));
			expectLibraryRefreshes(2);
			expect(mockSearchPhotosInvalidate).not.toHaveBeenCalled();
		});

		it("refreshes committed rows from durable progress after the socket disconnects", () => {
			setRealtimeProgress("processing", 4);
			const { result, rerender } = renderHook(() => useJobProgress(JOB_ID));
			expectLibraryRefreshes(1);

			mockSubscriptionResult.state = "closed";
			mockSubscriptionResult.error = new Error("Socket lost");
			act(() => jest.advanceTimersByTime(1500));
			setDurableProgress("processing", 24);
			rerender({});
			expectLibraryRefreshes(2);
			expect(result.current.progress.current).toBe(24);
			expect(result.current.isConnected).toBe(false);
			expect(result.current.isCompleted).toBe(false);

			act(() => jest.advanceTimersByTime(1500));
			setDurableProgress("processing", 24);
			rerender({});
			expectLibraryRefreshes(2);
			setDurableProgress("processing", 40);
			rerender({});
			expectLibraryRefreshes(3);
			expect(mockSearchPhotosInvalidate).not.toHaveBeenCalled();
		});

		it.each([
			"scan-complete",
			"embedding",
		])("refreshes on reconnect at %s without refetching each embedding batch", (phase) => {
			setDurableProgress(phase, phase === "embedding" ? 0 : 40);
			const { result, rerender } = renderHook(() => useJobProgress(JOB_ID));
			expectLibraryRefreshes(1);
			expect(result.current.isCompleted).toBe(false);

			setDurableProgress(phase, phase === "embedding" ? 0 : 40);
			rerender({});
			expectLibraryRefreshes(1);
			setDurableProgress("embedding", 16);
			rerender({});
			const expectedRefreshes = phase === "embedding" ? 1 : 2;
			expectLibraryRefreshes(expectedRefreshes);
			setDurableProgress("embedding", 32);
			rerender({});
			act(() => jest.advanceTimersByTime(5000));
			expectLibraryRefreshes(expectedRefreshes);
			expect(mockSearchPhotosInvalidate).not.toHaveBeenCalled();
		});

		it("cancels the old job's trailing refresh and resets the next job's first batch", () => {
			setRealtimeProgress("processing", 4);
			const { result, rerender } = renderHook(
				({ jobId }) => useJobProgress(jobId),
				{ initialProps: { jobId: JOB_ID } },
			);
			setRealtimeProgress("processing", 24);
			rerender({ jobId: JOB_ID });
			expectLibraryRefreshes(1);

			rerender({ jobId: OTHER_JOB_ID });
			expect(result.current.progress.current).toBe(0);
			act(() => jest.advanceTimersByTime(1000));
			expectLibraryRefreshes(1);

			setDurableProgress("processing", 4);
			rerender({ jobId: OTHER_JOB_ID });
			expectLibraryRefreshes(2);
			expect(result.current.progress.current).toBe(4);
			expect(mockSearchPhotosInvalidate).not.toHaveBeenCalled();
		});

		it("cancels the trailing refresh on unmount", () => {
			setDurableProgress("processing", 4);
			const { rerender, unmount } = renderHook(() => useJobProgress(JOB_ID));
			setDurableProgress("processing", 24);
			rerender({});
			expectLibraryRefreshes(1);

			unmount();
			act(() => jest.advanceTimersByTime(5000));
			expectLibraryRefreshes(1);
			expect(mockSearchPhotosInvalidate).not.toHaveBeenCalled();
		});

		it.each([
			"completed",
			"failed",
		])("refreshes all queries once on %s and cancels a pending processing refresh", (phase) => {
			setRealtimeProgress("processing", 4);
			const { result, rerender } = renderHook(() => useJobProgress(JOB_ID));
			setRealtimeProgress("processing", 24);
			rerender({});
			expectLibraryRefreshes(1);

			setDurableProgress(phase, 24);
			rerender({});
			expectLibraryRefreshes(2);
			expect(mockSearchPhotosInvalidate).toHaveBeenCalledTimes(1);
			expect(result.current.isActive).toBe(false);
			expect(result.current.isCompleted).toBe(phase === "completed");
			expect(result.current.isFailed).toBe(phase === "failed");
			expect(result.current.failureMessage).toBe(
				phase === "failed" ? "Scan failed" : null,
			);

			setRealtimeProgress("processing", 40);
			rerender({});
			act(() => jest.advanceTimersByTime(5000));
			setDurableProgress(phase, 24);
			rerender({});
			expectLibraryRefreshes(2);
			expect(mockSearchPhotosInvalidate).toHaveBeenCalledTimes(1);
		});
	});
});
