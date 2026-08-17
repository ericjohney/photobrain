import * as Updates from "expo-updates";
import { useEffect, useState } from "react";
import {
	ActivityIndicator,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from "react-native";

const DIAGNOSTIC_MODE = process.env.EXPO_PUBLIC_STARTUP_DIAGNOSTICS === "true";
const RootApp = DIAGNOSTIC_MODE
	? null
	: (require("../src/RootApp")
			.default as typeof import("../src/RootApp").default);

function formatLogs(logs: Updates.UpdatesLogEntry[]) {
	return logs
		.sort((left, right) => right.timestamp - left.timestamp)
		.slice(0, 30)
		.map((entry) => {
			const stack = entry.stacktrace?.length
				? `\n${entry.stacktrace.join("\n")}`
				: "";
			return `${new Date(entry.timestamp).toISOString()} [${entry.level}/${entry.code}]\n${entry.message}${stack}`;
		})
		.join("\n\n");
}

export function StartupDiagnostics({ onContinue }: { onContinue: () => void }) {
	const [report, setReport] = useState<string | null>(null);

	useEffect(() => {
		void Updates.readLogEntriesAsync(7 * 24 * 60 * 60 * 1000)
			.then((logs) => {
				const details = formatLogs(logs);
				setReport(
					[
						`Emergency launch: ${Updates.isEmergencyLaunch}`,
						`Emergency reason: ${Updates.emergencyLaunchReason ?? "none"}`,
						`Update ID: ${Updates.updateId ?? "embedded"}`,
						"",
						details || "No Expo Updates log entries were found.",
					].join("\n"),
				);
			})
			.catch((error) => {
				setReport(
					`Could not read Expo Updates logs:\n${error instanceof Error ? error.stack : String(error)}`,
				);
			});
	}, []);

	return (
		<View style={styles.safeArea}>
			<View style={styles.header}>
				<Text style={styles.title}>PhotoBrain Recovery</Text>
				<Text style={styles.instructions}>
					Long-press the report to select and copy it, then send it back for the
					startup fix.
				</Text>
			</View>
			{report === null ? (
				<ActivityIndicator style={styles.loader} size="large" />
			) : (
				<ScrollView style={styles.reportContainer}>
					<Text selectable style={styles.report}>
						{report}
					</Text>
				</ScrollView>
			)}
			<Pressable style={styles.button} onPress={onContinue}>
				<Text style={styles.buttonText}>Try Normal App</Text>
			</Pressable>
		</View>
	);
}

export default function RootLayout() {
	const [continueAnyway, setContinueAnyway] = useState(false);

	if (DIAGNOSTIC_MODE && !continueAnyway) {
		return <StartupDiagnostics onContinue={() => setContinueAnyway(true)} />;
	}

	const App =
		RootApp ??
		(require("../src/RootApp")
			.default as typeof import("../src/RootApp").default);
	return <App />;
}

const styles = StyleSheet.create({
	safeArea: {
		flex: 1,
		backgroundColor: "#111111",
		paddingTop: 48,
	},
	header: {
		paddingHorizontal: 20,
		paddingTop: 16,
		paddingBottom: 12,
		gap: 8,
	},
	title: {
		color: "#ffffff",
		fontSize: 24,
		fontWeight: "700",
	},
	instructions: {
		color: "#b7b7b7",
		fontSize: 15,
		lineHeight: 21,
	},
	loader: {
		flex: 1,
	},
	reportContainer: {
		flex: 1,
		marginHorizontal: 16,
		padding: 14,
		borderRadius: 12,
		backgroundColor: "#1c1c1e",
	},
	report: {
		color: "#f2f2f7",
		fontFamily: "Courier",
		fontSize: 12,
		lineHeight: 17,
	},
	button: {
		alignItems: "center",
		margin: 16,
		paddingVertical: 14,
		borderRadius: 12,
		backgroundColor: "#0a84ff",
	},
	buttonText: {
		color: "#ffffff",
		fontSize: 16,
		fontWeight: "600",
	},
});
