import { renderHook, waitFor } from "@testing-library/react-native";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_JOB_ID = "22222222-2222-4222-8222-222222222222";

const mockPhotosInvalidate = jest.fn();
const mockFoldersInvalidate = jest.fn();
const mockFilterOptionsInvalidate = jest.fn();
const mockSearchPhotosInvalidate = jest.fn();
const mockRealtimeTokenUseQuery = jest.fn();
const mockScanStatusUseQuery = jest.fn();
const mockUseInngestSubscription = jest.fn();

interface ProgressMessage {
	channel: string;
	data: { phase: string; current: number; total: number };
	createdAt?: Date;
}

interface TokenQueryResult {
	data?: { token: { jwt: string } };
	error: Error | null;
	refetch: jest.Mock;
}

interface StatusQueryResult {
	data: {
		phase: string;
		current: number;
		total: number;
		status: string;
		error: string | null;
		updatedAt?: Date;
	} | null;
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

	it("fetches a token for the current job and prefers current Realtime progress", () => {
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

		expect(mockRealtimeTokenUseQuery).toHaveBeenCalledWith(
			{ jobId: JOB_ID },
			expect.objectContaining({ enabled: true, retry: 3 }),
		);
		expect(mockUseInngestSubscription).toHaveBeenCalledWith(
			expect.objectContaining({
				token: { jwt: "test-token" },
				refreshToken: expect.any(Function),
				enabled: true,
				key: JOB_ID,
			}),
		);
		expect(result.current.progress).toMatchObject({
			phase: "processing",
			current: 3,
			percentage: 75,
		});
		expect(result.current.isActive).toBe(true);
		expect(result.current.isConnected).toBe(true);
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
});
