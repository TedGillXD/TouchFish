import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Test fixtures stay outside the app's packaged files. Desktop regressions must
// be deterministic, offline, and independent of future upstream announcements.
export async function seedHolidayCache(directory) {
  const years = JSON.parse(await readFile(new URL("../tests/fixtures/china-holidays.json", import.meta.url), "utf8"));
  const now = Date.now();
  await writeFile(join(directory, "holiday-cache.json"), JSON.stringify({
    version: 1,
    country: "CN",
    lastChecked: now,
    years: years.map((year) => ({ ...year, fetchedAt: now })),
  }));
}
