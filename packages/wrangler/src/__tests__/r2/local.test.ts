import * as fs from "node:fs";
import { runInTempDir } from "@cloudflare/workers-utils/test-helpers";
import { describe, it, vi } from "vitest";
import { readConfig } from "../../config";
import { parseExpires, usingLocalBucket } from "../../r2/helpers/object";
import { mockConsoleMethods } from "../helpers/mock-console";
import { runWrangler } from "../helpers/run-wrangler";

// Miniflare's use of undici doesn't play well with jest-mock-fetch
// and it is not needed here anyway.
vi.unmock("undici");

describe("r2", () => {
	const std = mockConsoleMethods();
	runInTempDir();

	describe("r2 object", () => {
		describe("local", () => {
			it("should put R2 object to a local bucket", async ({ expect }) => {
				await expect(() =>
					runWrangler(
						`r2 object get bucket-object-test/wormhole-img.png --file ./wormhole-img.png `
					)
				).rejects.toThrowErrorMatchingInlineSnapshot(
					`[Error: The specified key does not exist.]`
				);

				expect(std.getAndClearOut()).toMatchInlineSnapshot(`
					"
					 ⛅️ wrangler x.x.x
					──────────────────
					Resource location: local

					Use --remote if you want to access the remote instance.

					Downloading "wormhole-img.png" from "bucket-object-test".
					"
				`);

				fs.writeFileSync("wormhole-img.png", "passageway");
				await runWrangler(
					`r2 object put bucket-object-test/wormhole-img.png --file ./wormhole-img.png `
				);

				expect(std.getAndClearOut()).toMatchInlineSnapshot(`
					"
					 ⛅️ wrangler x.x.x
					──────────────────
					Resource location: local

					Use --remote if you want to access the remote instance.

					Creating object "wormhole-img.png" in bucket "bucket-object-test".
					Upload complete."
				`);

				await runWrangler(
					`r2 object get bucket-object-test/wormhole-img.png --file ./wormhole-img.png `
				);
				expect(std.getAndClearOut()).toMatchInlineSnapshot(`
					"
					 ⛅️ wrangler x.x.x
					──────────────────
					Resource location: local

					Use --remote if you want to access the remote instance.

					Downloading "wormhole-img.png" from "bucket-object-test".
					Download complete."
				`);
			});

			it("should round trip local objects whose keys are not URL safe", async ({
				expect,
			}) => {
				const keys = [
					"my report.pdf",
					"report#1.pdf",
					"sale?50.pdf",
					"héllo.txt",
					"invoices/2026/q1.pdf",
					"50%off.pdf",
					"my%20report.pdf",
				];
				fs.writeFileSync("payload", "quarterly numbers");

				for (const key of keys) {
					await runWrangler(
						`r2 object put "bucket-object-test/${key}" --file ./payload`
					);
					await runWrangler(
						`r2 object get "bucket-object-test/${key}" --file ./downloaded`
					);

					expect(`${key} holds ${fs.readFileSync("downloaded", "utf8")}`).toBe(
						`${key} holds quarterly numbers`
					);
				}
				std.getAndClearOut();
			});

			it("should keep two local objects whose keys differ after a hash", async ({
				expect,
			}) => {
				fs.writeFileSync("first", "january");
				fs.writeFileSync("second", "february");

				await runWrangler(
					`r2 object put "bucket-object-test/archive#2026-01.zip" --file ./first`
				);
				await runWrangler(
					`r2 object put "bucket-object-test/archive#2026-02.zip" --file ./second`
				);
				std.getAndClearOut();

				await runWrangler(
					`r2 object get "bucket-object-test/archive#2026-01.zip" --file ./got-first`
				);
				await runWrangler(
					`r2 object get "bucket-object-test/archive#2026-02.zip" --file ./got-second`
				);
				std.getAndClearOut();

				expect(fs.readFileSync("got-first", "utf8")).toBe("january");
				expect(fs.readFileSync("got-second", "utf8")).toBe("february");
			});

			it("should bulk put a local object whose key is not URL safe", async ({
				expect,
			}) => {
				fs.writeFileSync("payload", "quarterly numbers");
				fs.writeFileSync(
					"list.json",
					JSON.stringify([{ key: "my report #1.pdf", file: "payload" }])
				);

				await runWrangler(
					`r2 bulk put bucket-object-test --filename ./list.json`
				);
				await runWrangler(
					`r2 object get "bucket-object-test/my report #1.pdf" --file ./downloaded`
				);
				std.getAndClearOut();

				expect(fs.readFileSync("downloaded", "utf8")).toBe("quarterly numbers");
			});

			it("should bulk put R2 objects to a local bucket", async ({ expect }) => {
				await expect(() =>
					runWrangler(
						`r2 object get bucket-object-test/wormhole-img.png --file ./wormhole-img.png `
					)
				).rejects.toThrowErrorMatchingInlineSnapshot(
					`[Error: The specified key does not exist.]`
				);

				expect(std.getAndClearOut()).toMatchInlineSnapshot(`
					"
					 ⛅️ wrangler x.x.x
					──────────────────
					Resource location: local

					Use --remote if you want to access the remote instance.

					Downloading "wormhole-img.png" from "bucket-object-test".
					"
				`);

				await expect(() =>
					runWrangler(
						`r2 object get bucket-object-test/nebula-img.png --file ./nebula-img.png`
					)
				).rejects.toThrowErrorMatchingInlineSnapshot(
					`[Error: The specified key does not exist.]`
				);

				expect(std.getAndClearOut()).toMatchInlineSnapshot(`
					"
					 ⛅️ wrangler x.x.x
					──────────────────
					Resource location: local

					Use --remote if you want to access the remote instance.

					Downloading "nebula-img.png" from "bucket-object-test".
					"
				`);

				fs.writeFileSync("wormhole-img.png", "passageway");
				fs.writeFileSync("nebula-img.png", "nebula");
				fs.writeFileSync(
					"list.json",
					JSON.stringify([
						{
							key: "wormhole-img.png",
							file: "wormhole-img.png",
						},
						{
							key: "nebula-img.png",
							file: "nebula-img.png",
						},
					])
				);
				await runWrangler(
					`r2 bulk put bucket-object-test --filename ./list.json`
				);
				expect(std.getAndClearOut()).toMatchInlineSnapshot(`
					"
					 ⛅️ wrangler x.x.x
					──────────────────
					Resource location: local

					Use --remote if you want to access the remote instance.

					Starting bulk upload of 2 objects to bucket bucket-object-test using a concurrency of 20
					Uploaded 100% (2 out of 2)"
				`);

				await runWrangler(
					`r2 object get bucket-object-test/wormhole-img.png --file ./wormhole-img.png `
				);

				expect(std.getAndClearOut()).toMatchInlineSnapshot(`
					"
					 ⛅️ wrangler x.x.x
					──────────────────
					Resource location: local

					Use --remote if you want to access the remote instance.

					Downloading "wormhole-img.png" from "bucket-object-test".
					Download complete."
				`);

				await runWrangler(
					`r2 object get bucket-object-test/nebula-img.png --file ./nebula-img.png `
				);

				expect(std.getAndClearOut()).toMatchInlineSnapshot(`
					"
					 ⛅️ wrangler x.x.x
					──────────────────
					Resource location: local

					Use --remote if you want to access the remote instance.

					Downloading "nebula-img.png" from "bucket-object-test".
					Download complete."
				`);
			});

			it("should delete R2 object from local bucket", async ({ expect }) => {
				fs.writeFileSync("wormhole-img.png", "passageway");
				await runWrangler(
					`r2 object put bucket-object-test/wormhole-img.png --file ./wormhole-img.png `
				);
				expect(std.warn).toMatchInlineSnapshot(`""`);
				expect(std.getAndClearOut()).toMatchInlineSnapshot(`
					"
					 ⛅️ wrangler x.x.x
					──────────────────
					Resource location: local

					Use --remote if you want to access the remote instance.

					Creating object "wormhole-img.png" in bucket "bucket-object-test".
					Upload complete."
				`);

				await runWrangler(
					`r2 object get bucket-object-test/wormhole-img.png --file ./wormhole-img.png `
				);
				expect(std.getAndClearOut()).toMatchInlineSnapshot(`
					"
					 ⛅️ wrangler x.x.x
					──────────────────
					Resource location: local

					Use --remote if you want to access the remote instance.

					Downloading "wormhole-img.png" from "bucket-object-test".
					Download complete."
				`);

				await runWrangler(
					`r2 object delete bucket-object-test/wormhole-img.png `
				);

				expect(std.getAndClearOut()).toMatchInlineSnapshot(`
					"
					 ⛅️ wrangler x.x.x
					──────────────────
					Resource location: local

					Use --remote if you want to access the remote instance.

					Deleting object "wormhole-img.png" from bucket "bucket-object-test".
					Delete complete."
				`);

				await expect(() =>
					runWrangler(
						`r2 object get bucket-object-test/wormhole-img.png --file ./wormhole-img.png `
					)
				).rejects.toThrowErrorMatchingInlineSnapshot(
					`[Error: The specified key does not exist.]`
				);
			});

			it("should store an HTTP-date --expires value on a local object", async ({
				expect,
			}) => {
				const expires = "Fri, 01 Jan 2100 00:00:00 GMT";
				fs.writeFileSync("expires-payload", "passageway");

				await runWrangler(
					`r2 object put bucket-object-test/expires-http --file ./expires-payload --expires "${expires}"`
				);

				await usingLocalBucket(
					undefined,
					readConfig({}),
					"bucket-object-test",
					async (bucket) => {
						const object = await bucket.head("expires-http");
						expect(object?.httpMetadata?.cacheExpiry).toEqual(
							new Date(expires)
						);
					}
				);
				std.getAndClearOut();
			});

			it("should store an ISO --expires value on a local object", async ({
				expect,
			}) => {
				fs.writeFileSync("expires-payload", "passageway");

				await runWrangler(
					`r2 object put bucket-object-test/expires-iso --file ./expires-payload --expires 2100-01-01`
				);

				await usingLocalBucket(
					undefined,
					readConfig({}),
					"bucket-object-test",
					async (bucket) => {
						const object = await bucket.head("expires-iso");
						expect(object?.httpMetadata?.cacheExpiry).toEqual(
							new Date("2100-01-01T00:00:00.000Z")
						);
					}
				);
				std.getAndClearOut();
			});

			it("should store an --expires value on objects uploaded with bulk put", async ({
				expect,
			}) => {
				fs.writeFileSync("expires-payload", "passageway");
				fs.writeFileSync(
					"list.json",
					JSON.stringify([{ key: "bulk-expires-iso", file: "expires-payload" }])
				);

				await runWrangler(
					`r2 bulk put bucket-object-test --filename ./list.json --expires 2100-01-01`
				);

				await usingLocalBucket(
					undefined,
					readConfig({}),
					"bucket-object-test",
					async (bucket) => {
						const object = await bucket.head("bulk-expires-iso");
						expect(object?.httpMetadata?.cacheExpiry).toEqual(
							new Date("2100-01-01T00:00:00.000Z")
						);
					}
				);
				std.getAndClearOut();
			});

			it("should follow persist-to for object bucket", async ({ expect }) => {
				fs.writeFileSync("wormhole-img.png", "passageway");
				await runWrangler(
					`r2 object put bucket-object-test/file-one --file ./wormhole-img.png `
				);

				expect(std.getAndClearOut()).toMatchInlineSnapshot(`
					"
					 ⛅️ wrangler x.x.x
					──────────────────
					Resource location: local

					Use --remote if you want to access the remote instance.

					Creating object "file-one" in bucket "bucket-object-test".
					Upload complete."
				`);

				await runWrangler(
					`r2 object put bucket-object-test/file-two --file ./wormhole-img.png  --persist-to ./different-dir`
				);

				expect(std.getAndClearOut()).toMatchInlineSnapshot(`
					"
					 ⛅️ wrangler x.x.x
					──────────────────
					Resource location: local

					Use --remote if you want to access the remote instance.

					Creating object "file-two" in bucket "bucket-object-test".
					Upload complete."
				`);

				await expect(() =>
					runWrangler(
						`r2 object get bucket-object-test/file-one --file ./wormhole-img.png  --persist-to ./different-dir`
					)
				).rejects.toThrowErrorMatchingInlineSnapshot(
					`[Error: The specified key does not exist.]`
				);

				expect(std.getAndClearOut()).toMatchInlineSnapshot(`
					"
					 ⛅️ wrangler x.x.x
					──────────────────
					Resource location: local

					Use --remote if you want to access the remote instance.

					Downloading "file-one" from "bucket-object-test".
					"
				`);

				await runWrangler(
					`r2 object get bucket-object-test/file-two --file ./wormhole-img.png  --persist-to ./different-dir`
				);

				expect(std.getAndClearOut()).toMatchInlineSnapshot(`
					"
					 ⛅️ wrangler x.x.x
					──────────────────
					Resource location: local

					Use --remote if you want to access the remote instance.

					Downloading "file-two" from "bucket-object-test".
					Download complete."
				`);
			});
		});

		describe("parseExpires", () => {
			it("should parse HTTP-dates", ({ expect }) => {
				expect(parseExpires("Fri, 01 Jan 2100 00:00:00 GMT")).toBe(
					4_102_444_800_000
				);
			});

			it("should parse ISO 8601 dates", ({ expect }) => {
				expect(parseExpires("2100-01-01")).toBe(4_102_444_800_000);
				expect(parseExpires("2100-01-01T00:00:00.000Z")).toBe(
					4_102_444_800_000
				);
			});

			it("should treat integer strings as epoch milliseconds", ({ expect }) => {
				expect(parseExpires("0")).toBe(0);
				expect(parseExpires("1234")).toBe(1234);
				expect(parseExpires("4102444800000")).toBe(4_102_444_800_000);
			});

			it("should reject values that are neither dates nor epoch milliseconds", ({
				expect,
			}) => {
				expect(() => parseExpires("not-a-date")).toThrow(
					'The --expires value "not-a-date" could not be parsed as a date.'
				);
				expect(() => parseExpires("foo 2100")).toThrow(
					'The --expires value "foo 2100" could not be parsed as a date.'
				);
				expect(() => parseExpires("2100-02-30")).toThrow(
					'The --expires value "2100-02-30" could not be parsed as a date.'
				);
			});
		});
	});
});
