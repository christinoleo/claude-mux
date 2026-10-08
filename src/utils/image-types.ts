/** The image formats the dashboard serves and draws, by extension. Browser-safe: no node imports. */
const IMAGE_MIME_TYPES: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp'
};

/** The image MIME type for a path, or null when it is not an image the dashboard serves. */
export function imageMimeFor(path: string): string | null {
	const dot = path.lastIndexOf('.');
	// Like path.extname: a leading dot names a dotfile, not an extension.
	if (dot <= path.lastIndexOf('/') + 1) return null;
	return IMAGE_MIME_TYPES[path.slice(dot).toLowerCase()] ?? null;
}
