import React from "react";
import {
	View,
	TextInput,
	StyleSheet,
	TouchableOpacity,
	ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

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
	return (
		<View style={styles.container}>
			<View style={styles.searchContainer}>
				<Ionicons
					name="search"
					size={20}
					color="#6b7280"
					style={styles.searchIcon}
				/>
				<TextInput
					style={styles.input}
					value={value}
					onChangeText={onChangeText}
					placeholder={placeholder}
					placeholderTextColor="#9ca3af"
					returnKeyType="search"
					autoCapitalize="none"
					autoCorrect={false}
				/>
				{loading && (
					<ActivityIndicator
						size="small"
						color="#3b82f6"
						style={styles.loadingIcon}
					/>
				)}
				{value.length > 0 && !loading && (
					<TouchableOpacity onPress={onClear} style={styles.clearButton}>
						<Ionicons name="close-circle" size={20} color="#6b7280" />
					</TouchableOpacity>
				)}
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		padding: 12,
		backgroundColor: "#ffffff",
		borderBottomWidth: 1,
		borderBottomColor: "#e5e7eb",
	},
	searchContainer: {
		flexDirection: "row",
		alignItems: "center",
		backgroundColor: "#f3f4f6",
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
		color: "#111827",
	},
	loadingIcon: {
		marginLeft: 8,
	},
	clearButton: {
		padding: 4,
		marginLeft: 8,
	},
});
