import { useCallback, useState } from "react";

interface PanelState {
	leftPanelVisible: boolean;
	rightPanelVisible: boolean;
	filmstripVisible: boolean;
	leftPanelWidth: number;
	rightPanelWidth: number;
	filmstripHeight: number;
}

const STORAGE_KEY = "photobrain-panel-state";

const DEFAULT_STATE: PanelState = {
	leftPanelVisible: true,
	rightPanelVisible: true,
	filmstripVisible: true,
	leftPanelWidth: 220,
	rightPanelWidth: 280,
	filmstripHeight: 100,
};

function loadFromStorage(): PanelState {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored) {
			return { ...DEFAULT_STATE, ...JSON.parse(stored) };
		}
	} catch {
		// Ignore errors
	}
	return DEFAULT_STATE;
}

function saveToStorage(state: PanelState) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {
		// Ignore errors
	}
}

export function usePanelState() {
	const [state, setState] = useState<PanelState>(loadFromStorage);

	const updateState = useCallback((updates: Partial<PanelState>) => {
		setState((prev) => {
			const next = { ...prev, ...updates };
			saveToStorage(next);
			return next;
		});
	}, []);

	const toggleLeftPanel = useCallback(() => {
		updateState({ leftPanelVisible: !state.leftPanelVisible });
	}, [state.leftPanelVisible, updateState]);

	const toggleRightPanel = useCallback(() => {
		updateState({ rightPanelVisible: !state.rightPanelVisible });
	}, [state.rightPanelVisible, updateState]);

	const toggleFilmstrip = useCallback(() => {
		updateState({ filmstripVisible: !state.filmstripVisible });
	}, [state.filmstripVisible, updateState]);

	const toggleAllPanels = useCallback(() => {
		const allVisible =
			state.leftPanelVisible &&
			state.rightPanelVisible &&
			state.filmstripVisible;
		updateState({
			leftPanelVisible: !allVisible,
			rightPanelVisible: !allVisible,
			filmstripVisible: !allVisible,
		});
	}, [
		state.leftPanelVisible,
		state.rightPanelVisible,
		state.filmstripVisible,
		updateState,
	]);

	const setLeftPanelWidth = useCallback(
		(width: number) => {
			updateState({ leftPanelWidth: width });
		},
		[updateState],
	);

	const setRightPanelWidth = useCallback(
		(width: number) => {
			updateState({ rightPanelWidth: width });
		},
		[updateState],
	);

	const setFilmstripHeight = useCallback(
		(height: number) => {
			updateState({ filmstripHeight: height });
		},
		[updateState],
	);

	return {
		...state,
		toggleLeftPanel,
		toggleRightPanel,
		toggleFilmstrip,
		toggleAllPanels,
		setLeftPanelWidth,
		setRightPanelWidth,
		setFilmstripHeight,
	};
}
