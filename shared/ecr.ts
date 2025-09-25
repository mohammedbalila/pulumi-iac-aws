export interface PlaceholderSeedConfig {
    enabled: boolean;
    tag?: string;
    warning?: string;
}

const DEFAULT_PLACEHOLDER_TAG = "latest";

const isDigestReference = (imageUri: string): boolean => imageUri.includes("@");

const extractTag = (imageUri: string): string | undefined => {
    const lastColon = imageUri.lastIndexOf(":");
    const lastSlash = imageUri.lastIndexOf("/");

    if (lastColon === -1 || lastColon < lastSlash) {
        return undefined;
    }

    const tag = imageUri.slice(lastColon + 1).trim();
    return tag.length > 0 ? tag : undefined;
};

export const derivePlaceholderSeedConfig = (
    imageUri: string | undefined,
): PlaceholderSeedConfig => {
    if (!imageUri) {
        return { enabled: true, tag: DEFAULT_PLACEHOLDER_TAG };
    }

    if (isDigestReference(imageUri)) {
        return {
            enabled: false,
            warning: `Skipping placeholder image seeding because configured image URI "${imageUri}" uses a digest reference.`,
        };
    }

    return {
        enabled: true,
        tag: extractTag(imageUri) ?? DEFAULT_PLACEHOLDER_TAG,
    };
};
