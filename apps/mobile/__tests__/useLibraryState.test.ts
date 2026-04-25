import { act, renderHook, waitFor } from "@testing-library/react-native";
import { useLibraryState } from "@/hooks/use-library-state";
import { MOCK_PHOTOS } from "./fixtures";

describe("useLibraryState", () => {
	it("initializes with grid view mode", () => {
		const { result } = renderHook(() => useLibraryState(MOCK_PHOTOS));

		expect(result.current.viewMode).toBe("grid");
		expect(result.current.totalPhotos).toBe(5);
		expect(result.current.activePhoto).toBeNull();
	});

	it("openInLoupe sets view mode and active photo", () => {
		const { result } = renderHook(() => useLibraryState(MOCK_PHOTOS));

		act(() => {
			result.current.openInLoupe(MOCK_PHOTOS[2]);
		});

		expect(result.current.viewMode).toBe("loupe");
		expect(result.current.activePhoto?.id).toBe(3);
	});

	it("closeLoupe returns to grid view", () => {
		const { result } = renderHook(() => useLibraryState(MOCK_PHOTOS));

		act(() => {
			result.current.openInLoupe(MOCK_PHOTOS[2]);
		});
		act(() => {
			result.current.closeLoupe();
		});

		expect(result.current.viewMode).toBe("grid");
	});

	it("navigatePhoto moves to next photo", async () => {
		const { result } = renderHook(() => useLibraryState(MOCK_PHOTOS));

		act(() => {
			result.current.openInLoupe(MOCK_PHOTOS[0]);
		});

		await waitFor(() => {
			expect(result.current.activePhotoIndex).toBe(0);
		});

		act(() => {
			result.current.navigatePhoto("next");
		});

		await waitFor(() => {
			expect(result.current.activePhoto?.id).toBe(2);
			expect(result.current.activePhotoIndex).toBe(1);
		});
	});

	it("navigatePhoto moves to previous photo", async () => {
		const { result } = renderHook(() => useLibraryState(MOCK_PHOTOS));

		act(() => {
			result.current.openInLoupe(MOCK_PHOTOS[2]);
		});

		await waitFor(() => {
			expect(result.current.activePhotoIndex).toBe(2);
		});

		act(() => {
			result.current.navigatePhoto("prev");
		});

		await waitFor(() => {
			expect(result.current.activePhoto?.id).toBe(2);
			expect(result.current.activePhotoIndex).toBe(1);
		});
	});

	it("navigatePhoto does not go past the last photo", async () => {
		const { result } = renderHook(() => useLibraryState(MOCK_PHOTOS));

		act(() => {
			result.current.openInLoupe(MOCK_PHOTOS[4]);
		});

		await waitFor(() => {
			expect(result.current.activePhotoIndex).toBe(4);
		});

		act(() => {
			result.current.navigatePhoto("next");
		});

		await waitFor(() => {
			expect(result.current.activePhoto?.id).toBe(5);
			expect(result.current.activePhotoIndex).toBe(4);
		});
	});

	it("navigatePhoto does not go before the first photo", async () => {
		const { result } = renderHook(() => useLibraryState(MOCK_PHOTOS));

		act(() => {
			result.current.openInLoupe(MOCK_PHOTOS[0]);
		});

		await waitFor(() => {
			expect(result.current.activePhotoIndex).toBe(0);
		});

		act(() => {
			result.current.navigatePhoto("prev");
		});

		await waitFor(() => {
			expect(result.current.activePhoto?.id).toBe(1);
			expect(result.current.activePhotoIndex).toBe(0);
		});
	});

	it("hasPrev and hasNext reflect navigation bounds", async () => {
		const { result } = renderHook(() => useLibraryState(MOCK_PHOTOS));

		// No active photo: both false
		expect(result.current.hasPrev).toBe(false);
		expect(result.current.hasNext).toBe(false);

		// First photo: hasPrev=false, hasNext=true
		act(() => {
			result.current.openInLoupe(MOCK_PHOTOS[0]);
		});
		await waitFor(() => {
			expect(result.current.activePhotoIndex).toBe(0);
		});
		expect(result.current.hasPrev).toBe(false);
		expect(result.current.hasNext).toBe(true);

		// Last photo: hasPrev=true, hasNext=false
		act(() => {
			result.current.openInLoupe(MOCK_PHOTOS[4]);
		});
		await waitFor(() => {
			expect(result.current.activePhotoIndex).toBe(4);
		});
		expect(result.current.hasPrev).toBe(true);
		expect(result.current.hasNext).toBe(false);

		// Middle photo: both true
		act(() => {
			result.current.openInLoupe(MOCK_PHOTOS[2]);
		});
		await waitFor(() => {
			expect(result.current.activePhotoIndex).toBe(2);
		});
		expect(result.current.hasPrev).toBe(true);
		expect(result.current.hasNext).toBe(true);
	});

	it("navigateToIndex sets the correct photo", async () => {
		const { result } = renderHook(() => useLibraryState(MOCK_PHOTOS));

		act(() => {
			result.current.navigateToIndex(3);
		});

		await waitFor(() => {
			expect(result.current.activePhoto?.id).toBe(4);
			expect(result.current.activePhotoIndex).toBe(3);
		});
	});

	it("navigateToIndex ignores out-of-bounds indices", () => {
		const { result } = renderHook(() => useLibraryState(MOCK_PHOTOS));

		act(() => {
			result.current.navigateToIndex(100);
		});
		expect(result.current.activePhoto).toBeNull();

		act(() => {
			result.current.navigateToIndex(-1);
		});
		expect(result.current.activePhoto).toBeNull();
	});
});
