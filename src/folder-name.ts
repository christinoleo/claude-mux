/**
 * Why `name` cannot be made a new folder in the one browsed, or null when it
 * can. One level only: a slash would reach past the folder on screen.
 */
export function folderNameProblem(name: string): string | null {
  if (name.trim() === "") return "Name the folder";
  if (name !== name.trim()) return "No spaces at either end";
  if (name.includes("/") || name.includes("\0")) return "One folder at a time, no slashes";
  if (name === "." || name === "..") return "Not a folder name";
  if (new TextEncoder().encode(name).length > 255) return "Too long";
  return null;
}
