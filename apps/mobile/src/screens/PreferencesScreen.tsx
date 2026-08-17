import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import GlassSurface from "@/components/GlassSurface";
import { API_URL } from "@/config";
import { type ThemePreference, useColors, useTheme } from "@/theme";

const THEME_OPTIONS: Array<{
	value: ThemePreference;
	label: string;
	icon: keyof typeof Ionicons.glyphMap;
}> = [
	{ value: "light", label: "Light", icon: "sunny" },
	{ value: "dark", label: "Dark", icon: "moon" },
	{ value: "system", label: "System", icon: "phone-portrait" },
];

export default function PreferencesScreen() {
	const colors = useColors();
	const router = useRouter();
	const { themePreference, setThemePreference } = useTheme();
	const version = Constants.expoConfig?.version ?? "0.2.0";
	const serverHost = API_URL.replace(/^https?:\/\//, "").replace(/\/$/, "");

	return (
		<ScrollView
			style={[styles.container, { backgroundColor: colors.background }]}
			contentContainerStyle={styles.content}
			contentInsetAdjustmentBehavior="automatic"
		>
			<Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
				Appearance
			</Text>
			<GlassSurface style={styles.themeGroup} glassEffectStyle="clear">
				{THEME_OPTIONS.map((option) => {
					const selected = themePreference === option.value;
					return (
						<Pressable
							key={option.value}
							accessibilityRole="radio"
							accessibilityState={{ checked: selected }}
							onPress={() => setThemePreference(option.value)}
							style={[
								styles.themeOption,
								selected && { backgroundColor: colors.foreground },
							]}
						>
							<Ionicons
								name={option.icon}
								size={21}
								color={selected ? colors.background : colors.foreground}
							/>
							<Text
								style={[
									styles.themeLabel,
									{ color: selected ? colors.background : colors.foreground },
								]}
							>
								{option.label}
							</Text>
						</Pressable>
					);
				})}
			</GlassSurface>

			<Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
				PhotoBrain
			</Text>
			<View style={[styles.group, { backgroundColor: colors.card }]}>
				<View style={[styles.row, { borderBottomColor: colors.border }]}>
					<View style={[styles.rowIcon, { backgroundColor: colors.primary }]}>
						<Ionicons name="server-outline" size={17} color="#ffffff" />
					</View>
					<View style={styles.rowContent}>
						<Text style={[styles.rowTitle, { color: colors.foreground }]}>
							Server
						</Text>
						<Text
							style={[styles.rowDetail, { color: colors.mutedForeground }]}
							numberOfLines={1}
						>
							{serverHost}
						</Text>
					</View>
				</View>
				<View style={[styles.row, { borderBottomColor: colors.border }]}>
					<View style={[styles.rowIcon, { backgroundColor: colors.success }]}>
						<Ionicons name="sparkles" size={17} color="#ffffff" />
					</View>
					<View style={styles.rowContent}>
						<Text style={[styles.rowTitle, { color: colors.foreground }]}>
							Interface
						</Text>
						<Text style={[styles.rowDetail, { color: colors.mutedForeground }]}>
							Native Liquid Glass on supported iOS devices
						</Text>
					</View>
				</View>
				<Pressable
					accessibilityRole="button"
					accessibilityLabel="About PhotoBrain"
					onPress={() => router.push("/about")}
					style={styles.row}
				>
					<View
						style={[
							styles.rowIcon,
							{ backgroundColor: colors.mutedForeground },
						]}
					>
						<Ionicons name="information" size={18} color="#ffffff" />
					</View>
					<View style={styles.rowContent}>
						<Text style={[styles.rowTitle, { color: colors.foreground }]}>
							About
						</Text>
						<Text style={[styles.rowDetail, { color: colors.mutedForeground }]}>
							Version {version}
						</Text>
					</View>
					<Ionicons
						name="chevron-forward"
						size={18}
						color={colors.mutedForeground}
					/>
				</Pressable>
			</View>

			<Text style={[styles.footer, { color: colors.mutedForeground }]}>
				PhotoBrain connects to your self-hosted library. Photos remain on the
				configured server.
			</Text>
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1 },
	content: { paddingHorizontal: 16, paddingBottom: 36 },
	sectionTitle: {
		marginTop: 24,
		marginLeft: 4,
		marginBottom: 8,
		fontSize: 13,
		fontWeight: "600",
	},
	themeGroup: {
		flexDirection: "row",
		padding: 4,
		borderRadius: 22,
		borderCurve: "continuous",
		gap: 3,
	},
	themeOption: {
		flex: 1,
		minHeight: 64,
		borderRadius: 18,
		borderCurve: "continuous",
		alignItems: "center",
		justifyContent: "center",
		gap: 5,
	},
	themeLabel: { fontSize: 13, fontWeight: "600" },
	group: { borderRadius: 14, borderCurve: "continuous", overflow: "hidden" },
	row: {
		minHeight: 62,
		flexDirection: "row",
		alignItems: "center",
		paddingHorizontal: 14,
		borderBottomWidth: StyleSheet.hairlineWidth,
	},
	rowIcon: {
		width: 30,
		height: 30,
		borderRadius: 8,
		alignItems: "center",
		justifyContent: "center",
		marginRight: 12,
	},
	rowContent: { flex: 1, paddingVertical: 10 },
	rowTitle: { fontSize: 16, fontWeight: "500" },
	rowDetail: { marginTop: 2, fontSize: 12 },
	footer: {
		marginTop: 22,
		paddingHorizontal: 12,
		fontSize: 12,
		lineHeight: 17,
		textAlign: "center",
	},
});
