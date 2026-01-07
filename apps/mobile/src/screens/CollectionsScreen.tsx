import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { StyleSheet, Text, View } from "react-native";

export default function CollectionsScreen() {
	return (
		<View style={styles.container}>
			<Ionicons name="folder-outline" size={64} color="#9ca3af" />
			<Text style={styles.title}>Collections</Text>
			<Text style={styles.subtitle}>Coming soon...</Text>
			<Text style={styles.description}>
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
		backgroundColor: "#ffffff",
	},
	title: {
		fontSize: 24,
		fontWeight: "600",
		color: "#111827",
		marginTop: 16,
		marginBottom: 8,
	},
	subtitle: {
		fontSize: 16,
		color: "#6b7280",
		marginBottom: 16,
	},
	description: {
		fontSize: 14,
		color: "#9ca3af",
		textAlign: "center",
		maxWidth: 300,
	},
});
