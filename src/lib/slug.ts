// Matches hostnsoft-deploy's X-App-Name validation (lowercase letters,
// digits, dashes) since the slug becomes that header's value.
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
