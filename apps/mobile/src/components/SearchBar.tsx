import { Ionicons } from "@expo/vector-icons";
import React from "react";
import {
	ActivityIndicator,
	Pressable,
	StyleSheet,
	TextInput,
	View,
} from "react-native";
import { useColors } from "@/theme";

interface SearchBarProps {
	value: string;
	onChangeText: (text: string) => void;
	onClear: () => void;
	placeholder?: string;
	loading?: boolean;
}

export default function SearchBar({
	value,
	onChangeText,
	onClear,
	placeholder = "Search photos...",
	loading = false,
}: SearchBarProps) {
	const colors = useColors();

	return (
		<View style={[styles.container, { backgroundColor: colors.toolbar }]}>
			<View style={[styles.searchContainer, { backgroundColor: colors.input }]}>
				<Ionicons
					name="search"
					size={20}
					color={colors.mutedForeground}
					style={styles.searchIcon}
				/>
				<TextInput
					style={[styles.input, { color: colors.foreground }]}
					value={value}
					onChangeText={onChangeText}
					placeholder={placeholder}
					placeholderTextColor={colors.mutedForeground}
					returnKeyType="search"
					autoCapitalize="none"
					autoCorrect={false}
				/>
				{loading && (
					<ActivityIndicator
						size="small"
						color={colors.primary}
						style={styles.loadingIcon}
					/>
				)}
				{value.length > 0 && !loading && (
					<Pressable onPress={onClear} style={styles.clearButton}>
						<Ionicons
							name="close-circle"
							size={20}
							color={colors.mutedForeground}
						/>
					</Pressable>
				)}
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		padding: 12,
	},
	searchContainer: {
		flexDirection: "row",
		alignItems: "center",
		borderRadius: 8,
		paddingHorizontal: 12,
		height: 44,
	},
	searchIcon: {
		marginRight: 8,
	},
	input: {
		flex: 1,
		fontSize: 16,
	},
	loadingIcon: {
		marginLeft: 8,
	},
	clearButton: {
		padding: 4,
		marginLeft: 8,
	},
});
