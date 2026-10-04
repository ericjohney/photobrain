/**
 * Fixed zero-shot CLIP label vocabulary for automatic photo tags.
 *
 * Bump `TAG_VOCABULARY_VERSION` whenever a tag, prompt, or the scoring
 * threshold changes: every stored vector whose `photo_embedding.tags_version`
 * differs is retagged by the `tag-photos-v1` backfill.
 */
export const TAG_VOCABULARY_VERSION = 3;

/** Tag slug format accepted by the `tag` filter: lowercase, hyphenated. */
export const TAG_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_TAG_SLUG_LENGTH = 64;

export type TagLabel = {
	/** Lowercase hyphenated slug stored in `photo_tags.tag`. */
	tag: string;
	/** Text prompt embedded with CLIP's text encoder. */
	prompt: string;
};

export const TAG_VOCABULARY: readonly TagLabel[] = [
	// Places and landscapes
	{ tag: "beach", prompt: "a photo of a beach" },
	{ tag: "mountain", prompt: "a photo of mountains" },
	{ tag: "snow", prompt: "a photo of a snowy landscape" },
	{ tag: "forest", prompt: "a photo of a forest" },
	{ tag: "desert", prompt: "a photo of a desert" },
	{ tag: "lake", prompt: "a photo of a lake" },
	{ tag: "ocean", prompt: "a photo of the ocean" },
	{ tag: "river", prompt: "a photo of a river" },
	{ tag: "waterfall", prompt: "a photo of a waterfall" },
	{ tag: "landscape", prompt: "a landscape photo" },
	{ tag: "sunset", prompt: "a photo of a sunset" },
	{ tag: "night-sky", prompt: "a photo of the night sky with stars" },
	{ tag: "sky", prompt: "a photo of a blue sky" },
	{ tag: "clouds", prompt: "a photo of clouds" },
	{ tag: "rain", prompt: "a photo taken in the rain" },
	{ tag: "garden", prompt: "a photo of a garden" },
	{ tag: "flowers", prompt: "a photo of flowers" },
	{ tag: "tree", prompt: "a photo of a tree" },
	{ tag: "park", prompt: "a photo of a park" },
	// Built environment
	{ tag: "city", prompt: "a photo of a city skyline" },
	{ tag: "city-night", prompt: "a photo of a city at night" },
	{ tag: "street", prompt: "a photo of a city street" },
	{ tag: "architecture", prompt: "a photo of architecture" },
	{ tag: "interior", prompt: "a photo of a room interior" },
	{ tag: "kitchen", prompt: "a photo of a kitchen" },
	{ tag: "bridge", prompt: "a photo of a bridge" },
	{ tag: "church", prompt: "a photo of a church" },
	{ tag: "museum", prompt: "a photo inside a museum" },
	{ tag: "statue", prompt: "a photo of a statue" },
	{ tag: "art", prompt: "a photo of a painting" },
	// Animals
	{ tag: "dog", prompt: "a photo of a dog" },
	{ tag: "cat", prompt: "a photo of a cat" },
	{ tag: "pet", prompt: "a photo of a pet" },
	{ tag: "bird", prompt: "a photo of a bird" },
	{ tag: "horse", prompt: "a photo of a horse" },
	{ tag: "fish", prompt: "a photo of fish" },
	{ tag: "insect", prompt: "a photo of an insect" },
	{ tag: "wildlife", prompt: "a photo of a wild animal in nature" },
	// People and events
	{ tag: "person", prompt: "a photo of a person" },
	{ tag: "group", prompt: "a photo of a group of people" },
	{ tag: "portrait", prompt: "a portrait photo of a person" },
	{ tag: "selfie", prompt: "a selfie" },
	{ tag: "child", prompt: "a photo of a child" },
	{ tag: "baby", prompt: "a photo of a human baby lying down" },
	{ tag: "wedding", prompt: "a photo of a wedding" },
	{ tag: "party", prompt: "a photo of a party" },
	{ tag: "concert", prompt: "a photo of a concert" },
	{ tag: "birthday", prompt: "a photo of a birthday cake with candles" },
	{ tag: "christmas", prompt: "a photo of a christmas tree" },
	{ tag: "fireworks", prompt: "a photo of fireworks" },
	{ tag: "graduation", prompt: "a photo of a graduation ceremony" },
	// Activities
	{ tag: "sports", prompt: "a photo of people playing sports" },
	{ tag: "hiking", prompt: "a photo of people hiking on a trail" },
	{ tag: "camping", prompt: "a photo of a tent at a campsite" },
	{ tag: "swimming", prompt: "a photo of people swimming" },
	{ tag: "skiing", prompt: "a photo of people skiing" },
	{ tag: "surfing", prompt: "a photo of a surfer" },
	{ tag: "cycling", prompt: "a photo of people riding bikes" },
	{ tag: "road-trip", prompt: "a photo of a road trip" },
	// Food
	{ tag: "food", prompt: "a photo of food on a plate" },
	{ tag: "drink", prompt: "a photo of a drink" },
	{ tag: "coffee", prompt: "a photo of a cup of coffee" },
	{ tag: "dessert", prompt: "a photo of a cake or ice cream dessert" },
	{ tag: "restaurant", prompt: "a photo of a restaurant" },
	// Vehicles
	{ tag: "car", prompt: "a photo of a car" },
	{ tag: "bicycle", prompt: "a photo of a bicycle" },
	{ tag: "motorcycle", prompt: "a photo of a motorcycle" },
	{ tag: "boat", prompt: "a photo of a boat" },
	{ tag: "airplane", prompt: "a photo of an airplane" },
	{ tag: "train", prompt: "a photo of a train" },
	// Documents and screens
	{ tag: "document", prompt: "a photo of a paper document" },
	{ tag: "receipt", prompt: "a photo of a receipt" },
	{ tag: "screenshot", prompt: "a screenshot of a user interface" },
	{ tag: "whiteboard", prompt: "a photo of a whiteboard" },
	{ tag: "text", prompt: "a photo of a sign with text" },
	{ tag: "book", prompt: "a photo of a book" },
	{ tag: "map", prompt: "a photo of a map" },
	// Styles
	{ tag: "macro", prompt: "a macro photo" },
	{ tag: "black-and-white", prompt: "a black and white photo" },
	{ tag: "aerial", prompt: "an aerial photo" },
];
