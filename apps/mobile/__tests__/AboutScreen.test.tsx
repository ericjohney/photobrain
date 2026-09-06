import { waitFor } from "@testing-library/react-native";
import { ScrollView } from "react-native";
import AboutScreen from "@/screens/AboutScreen";
import { renderWithProviders } from "./test-utils";

describe("AboutScreen", () => {
	it("allows long technology and feature text to wrap beside icons", async () => {
		const { getByText, UNSAFE_getByType } = renderWithProviders(
			<AboutScreen />,
		);
		await waitFor(() => expect(getByText("PhotoBrain")).toBeTruthy());
		for (const text of [
			"AI-Powered Semantic Search (CLIP)",
			"Semantic search using CLIP embeddings",
			"Perceptual hash for duplicate detection",
		]) {
			expect(getByText(text)).toHaveStyle({ flex: 1 });
			expect(getByText(text).props.numberOfLines).toBeUndefined();
		}
		expect(
			UNSAFE_getByType(ScrollView).props.contentInsetAdjustmentBehavior,
		).toBe("automatic");
	});
});
