import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useColors } from "@/theme";

export default function CollectionsScreen() {
	const colors = useColors();

	return (
		<View style={[styles.container, { backgroundColor: colors.background }]}>
			<Ionicons
				name="folder-outline"
				size={64}
				color={colors.mutedForeground}
				style={{ opacity: 0.5 }}
			/>
			<Text style={[styles.title, { color: colors.foreground }]}>
				Collections
			</Text>
			<Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
				Coming soon...
			</Text>
			<Text style={[styles.description, { color: colors.mutedForeground }]}>
				Organize your photos into collections for easy access and management.
			</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
		padding: 24,
	},
	title: {
		fontSize: 24,
		fontWeight: "600",
		marginTop: 16,
		marginBottom: 8,
	},
	subtitle: {
		fontSize: 16,
		marginBottom: 16,
	},
	description: {
		fontSize: 14,
		textAlign: "center",
		maxWidth: 300,
	},
});
