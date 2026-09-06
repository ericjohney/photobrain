import { fireEvent, waitFor } from "@testing-library/react-native";
import { Dimensions, StyleSheet } from "react-native";
import MetadataPanel from "@/components/MetadataPanel";
import { MOCK_PHOTOS } from "./fixtures";
import { renderWithProviders } from "./test-utils";

jest.unmock("@/components/MetadataPanel");

const photo = {
	...MOCK_PHOTOS[0],
	name: "A very long photo filename from a sunset photography expedition.jpg",
	modifiedAt: "2024-06-15T18:30:00.000Z",
	thumbnailUpdatedAt: null,
};

describe("MetadataPanel", () => {
	beforeEach(() => {
		jest.spyOn(Dimensions, "get").mockReturnValue({
			width: 390,
			height: 844,
			scale: 3,
			fontScale: 1,
		});
	});

	afterEach(() => jest.restoreAllMocks());

	it("wraps selectable file and EXIF values with bounded labels", async () => {
		const { getByText } = renderWithProviders(
			<MetadataPanel visible photo={photo} onClose={jest.fn()} />,
		);
		await waitFor(() => expect(getByText(photo.name)).toBeTruthy());
		for (const value of [
			photo.name,
			"Sony A7III",
			"Sony FE 24-70mm f/2.8 GM",
		]) {
			expect(getByText(value).props.selectable).toBe(true);
			expect(getByText(value).props.numberOfLines).toBeUndefined();
			expect(getByText(value)).toHaveStyle({ flex: 1, textAlign: "right" });
		}
		expect(getByText("Name")).toHaveStyle({ width: "35%", maxWidth: 140 });
	});

	it("stacks labels above left-aligned values at accessibility font sizes", async () => {
		jest.spyOn(Dimensions, "get").mockReturnValue({
			width: 320,
			height: 568,
			scale: 2,
			fontScale: 2,
		});
		const { getByText } = renderWithProviders(
			<MetadataPanel visible photo={photo} onClose={jest.fn()} />,
		);
		await waitFor(() => expect(getByText(photo.name)).toBeTruthy());
		expect(getByText("Name")).toHaveStyle({ width: "100%", maxWidth: "100%" });
		expect(getByText(photo.name)).toHaveStyle({ flex: 0, textAlign: "left" });
		expect(
			StyleSheet.flatten(getByText("Name").parent?.parent?.props.style),
		).toMatchObject({
			flexDirection: "column",
		});
	});

	it("announces accordion state and toggles file and initially closed location details", async () => {
		const { getByRole, getByText, queryByText } = renderWithProviders(
			<MetadataPanel
				visible
				photo={{ ...photo, exif: MOCK_PHOTOS[2].exif }}
				onClose={jest.fn()}
			/>,
		);
		await waitFor(() =>
			expect(
				getByRole("button", { name: "File", expanded: true }),
			).toBeTruthy(),
		);
		fireEvent.press(getByRole("button", { name: "File" }));
		expect(getByRole("button", { name: "File", expanded: false })).toBeTruthy();
		expect(queryByText(photo.name)).toBeNull();
		fireEvent.press(getByRole("button", { name: "File" }));
		expect(getByText(photo.name)).toBeTruthy();
		expect(
			getByRole("button", { name: "Location", expanded: false }),
		).toBeTruthy();
		expect(queryByText("37.7749, -122.4194")).toBeNull();
		fireEvent.press(getByRole("button", { name: "Location" }));
		expect(
			getByRole("button", { name: "Location", expanded: true }),
		).toBeTruthy();
		expect(getByText("37.7749, -122.4194").props.selectable).toBe(true);
	});

	it("keeps RAW failure details selectable and provides a 44pt close button", async () => {
		const onClose = jest.fn();
		const rawError =
			"No embedded preview was found in this RAW file. Try another source file.";
		const { getByRole, getByText } = renderWithProviders(
			<MetadataPanel
				visible
				photo={{
					...photo,
					isRaw: true,
					rawFormat: "ARW",
					rawStatus: "failed",
					rawError,
				}}
				onClose={onClose}
			/>,
		);
		const close = await waitFor(() =>
			getByRole("button", { name: "Close photo info" }),
		);
		expect(close).toHaveStyle({ width: 44, height: 44 });
		expect(getByText("Failed")).toBeTruthy();
		expect(getByText(rawError).props.selectable).toBe(true);
		expect(getByText(rawError).props.numberOfLines).toBeUndefined();
		fireEvent.press(close);
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
