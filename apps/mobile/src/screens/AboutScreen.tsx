import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useColors } from "@/theme";

export default function AboutScreen() {
	const colors = useColors();

	return (
		<ScrollView
			style={[styles.container, { backgroundColor: colors.background }]}
			contentContainerStyle={styles.content}
		>
			<View style={styles.header}>
				<Ionicons name="images" size={64} color={colors.primary} />
				<Text style={[styles.title, { color: colors.foreground }]}>
					PhotoBrain
				</Text>
				<Text style={[styles.version, { color: colors.mutedForeground }]}>
					Version 0.1.0
				</Text>
			</View>

			<View style={styles.section}>
				<Text style={[styles.sectionTitle, { color: colors.foreground }]}>
					About
				</Text>
				<Text style={[styles.description, { color: colors.mutedForeground }]}>
					PhotoBrain is a modern, AI-powered self-hosted photo management and
					gallery application. Fast, intelligent, and easy to use.
				</Text>
			</View>

			<View style={styles.section}>
				<Text style={[styles.sectionTitle, { color: colors.foreground }]}>
					Technology Stack
				</Text>
				<View style={styles.techList}>
					<TechItem icon="logo-react" text="React Native & Expo" />
					<TechItem icon="search" text="AI-Powered Semantic Search (CLIP)" />
					<TechItem icon="server" text="Hono Backend API" />
					<TechItem icon="albums" text="SQLite Database" />
					<TechItem icon="flash" text="Rust Image Processing" />
				</View>
			</View>

			<View style={styles.section}>
				<Text style={[styles.sectionTitle, { color: colors.foreground }]}>
					Features
				</Text>
				<View style={styles.featureList}>
					<FeatureItem text="Fast photo grid gallery" />
					<FeatureItem text="Semantic search using CLIP embeddings" />
					<FeatureItem text="Automatic metadata extraction" />
					<FeatureItem text="Perceptual hash for duplicate detection" />
					<FeatureItem text="Cross-platform (Web & Mobile)" />
				</View>
			</View>
		</ScrollView>
	);
}

function TechItem({ icon, text }: { icon: string; text: string }) {
	const colors = useColors();

	return (
		<View style={styles.techItem}>
			<Ionicons
				name={icon as keyof typeof Ionicons.glyphMap}
				size={20}
				color={colors.primary}
			/>
			<Text style={[styles.techText, { color: colors.foreground }]}>
				{text}
			</Text>
		</View>
	);
}

function FeatureItem({ text }: { text: string }) {
	const colors = useColors();

	return (
		<View style={styles.featureItem}>
			<Ionicons name="checkmark-circle" size={20} color={colors.success} />
			<Text style={[styles.featureText, { color: colors.foreground }]}>
				{text}
			</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
	},
	content: {
		padding: 24,
	},
	header: {
		alignItems: "center",
		marginBottom: 32,
	},
	title: {
		fontSize: 32,
		fontWeight: "700",
		marginTop: 16,
	},
	version: {
		fontSize: 14,
		marginTop: 4,
	},
	section: {
		marginBottom: 32,
	},
	sectionTitle: {
		fontSize: 20,
		fontWeight: "600",
		marginBottom: 12,
	},
	description: {
		fontSize: 16,
		lineHeight: 24,
	},
	techList: {
		gap: 12,
	},
	techItem: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
	},
	techText: {
		fontSize: 16,
	},
	featureList: {
		gap: 12,
	},
	featureItem: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
	},
	featureText: {
		fontSize: 16,
	},
});
