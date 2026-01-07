import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

export default function AboutScreen() {
	return (
		<ScrollView style={styles.container} contentContainerStyle={styles.content}>
			<View style={styles.header}>
				<Ionicons name="images" size={64} color="#3b82f6" />
				<Text style={styles.title}>PhotoBrain</Text>
				<Text style={styles.version}>Version 0.1.0</Text>
			</View>

			<View style={styles.section}>
				<Text style={styles.sectionTitle}>About</Text>
				<Text style={styles.description}>
					PhotoBrain is a modern, AI-powered self-hosted photo management and
					gallery application. Fast, intelligent, and easy to use.
				</Text>
			</View>

			<View style={styles.section}>
				<Text style={styles.sectionTitle}>Technology Stack</Text>
				<View style={styles.techList}>
					<TechItem icon="logo-react" text="React Native & Expo" />
					<TechItem icon="search" text="AI-Powered Semantic Search (CLIP)" />
					<TechItem icon="server" text="Hono Backend API" />
					<TechItem icon="albums" text="SQLite Database" />
					<TechItem icon="flash" text="Rust Image Processing" />
				</View>
			</View>

			<View style={styles.section}>
				<Text style={styles.sectionTitle}>Features</Text>
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
	return (
		<View style={styles.techItem}>
			<Ionicons name={icon as any} size={20} color="#3b82f6" />
			<Text style={styles.techText}>{text}</Text>
		</View>
	);
}

function FeatureItem({ text }: { text: string }) {
	return (
		<View style={styles.featureItem}>
			<Ionicons name="checkmark-circle" size={20} color="#10b981" />
			<Text style={styles.featureText}>{text}</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: "#ffffff",
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
		color: "#111827",
		marginTop: 16,
	},
	version: {
		fontSize: 14,
		color: "#6b7280",
		marginTop: 4,
	},
	section: {
		marginBottom: 32,
	},
	sectionTitle: {
		fontSize: 20,
		fontWeight: "600",
		color: "#111827",
		marginBottom: 12,
	},
	description: {
		fontSize: 16,
		color: "#4b5563",
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
		color: "#4b5563",
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
		color: "#4b5563",
	},
});
