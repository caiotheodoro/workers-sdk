import { FatalError, UserError } from "@cloudflare/workers-utils";
import {
	bucketFormatMessage,
	isValidR2BucketName,
} from "@cloudflare/workers-utils/config";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import prettyBytes from "pretty-bytes";
import { fetchR2Objects } from "../../cfetch/internal";
import { getLocalPersistencePath } from "../../dev/get-local-persistence-path";
import { getDefaultPersistRoot } from "../../dev/miniflare";
import { MAX_UPLOAD_SIZE_BYTES } from "../constants";
import type { R2Bucket } from "@cloudflare/workers-types/experimental";
import type { ComplianceConfig } from "@cloudflare/workers-utils";
import type { Config } from "@cloudflare/workers-utils/config";
import type { ReplaceWorkersTypes } from "miniflare";
import type { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import type { HeadersInit } from "undici";

/**
 * Downloads an object
 */
export async function getR2Object(
	complianceConfig: ComplianceConfig,
	accountId: string,
	bucketName: string,
	objectName: string,
	jurisdiction?: string
): Promise<ReadableStream | null> {
	const headers: HeadersInit = {};
	if (jurisdiction !== undefined) {
		headers["cf-r2-jurisdiction"] = jurisdiction;
	}
	const response = await fetchR2Objects(
		complianceConfig,
		`/accounts/${accountId}/r2/buckets/${bucketName}/objects/${objectName}`,
		{
			method: "GET",
			headers,
		}
	);

	return response === null ? null : response.body;
}

/**
 * Validate upload size.
 *
 * Throws a FatalError if the size exceeds the maximum allowed upload size.
 *
 * @param sizeBytes the size of the object to upload in bytes
 */
export function validateUploadSize(key: string, sizeBytes: number): void {
	if (sizeBytes > MAX_UPLOAD_SIZE_BYTES) {
		throw new FatalError(
			`Error: Wrangler only supports uploading files up to ${prettyBytes(
				MAX_UPLOAD_SIZE_BYTES,
				{ binary: true }
			)} in size\n${key} is ${prettyBytes(sizeBytes, {
				binary: true,
			})} in size`,
			{ code: 1, telemetryMessage: "r2 object upload too large" }
		);
	}
}

const HTTP_DATE_PATTERN =
	/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?<day>\d{2}) (?<month>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?<year>\d{4}) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2}) GMT$/;
const ISO_DATE_TIME_PATTERN =
	/^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})(?:T(?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2})(?:\.(?<fraction>\d+))?)?(?<timezone>Z|[+-]\d{2}:\d{2})?)?$/i;

const monthNumbers: Record<string, number> = {
	Jan: 1,
	Feb: 2,
	Mar: 3,
	Apr: 4,
	May: 5,
	Jun: 6,
	Jul: 7,
	Aug: 8,
	Sep: 9,
	Oct: 10,
	Nov: 11,
	Dec: 12,
};

function isValidCalendarDate(
	year: number,
	month: number,
	day: number
): boolean {
	const daysInMonth = [
		31,
		year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	];
	return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1];
}

function isValidTime(hour: number, minute: number, second: number): boolean {
	return hour < 24 && minute < 60 && second < 60;
}

function parseDateString(value: string): number | undefined {
	const httpDateMatch = HTTP_DATE_PATTERN.exec(value);
	if (httpDateMatch?.groups) {
		const { year, month, day, hour, minute, second } = httpDateMatch.groups;
		if (
			isValidCalendarDate(Number(year), monthNumbers[month], Number(day)) &&
			isValidTime(Number(hour), Number(minute), Number(second))
		) {
			return Date.parse(value);
		}
		return undefined;
	}

	const isoDateMatch = ISO_DATE_TIME_PATTERN.exec(value);
	if (isoDateMatch?.groups) {
		const { year, month, day, hour, minute, second } = isoDateMatch.groups;
		if (
			isValidCalendarDate(Number(year), Number(month), Number(day)) &&
			(hour === undefined ||
				isValidTime(Number(hour), Number(minute), Number(second ?? 0)))
		) {
			return Date.parse(value);
		}
	}

	return undefined;
}

/**
 * Parse the `--expires` value into epoch milliseconds for a local R2 put.
 *
 * Integer strings are treated as epoch milliseconds for backwards compatibility.
 * Other values are parsed as preferred HTTP-dates or ISO 8601 date/times.
 * This ordering is important because `Date.parse()` interprets some numeric
 * strings as calendar years instead.
 */
export function parseExpires(expires: string): number {
	const value = expires.trim();

	if (/^[+-]?\d+$/.test(value)) {
		const epochMilliseconds = Number(value);
		if (!Number.isNaN(new Date(epochMilliseconds).getTime())) {
			return epochMilliseconds;
		}
	} else {
		const parsedMilliseconds = parseDateString(value);
		if (parsedMilliseconds !== undefined && !Number.isNaN(parsedMilliseconds)) {
			return parsedMilliseconds;
		}
	}

	throw new UserError(
		`The --expires value "${expires}" could not be parsed as a date. Use an HTTP-date (for example, "Fri, 01 Jan 2100 00:00:00 GMT"), an ISO 8601 date, or epoch milliseconds.`,
		{ telemetryMessage: "r2 object put invalid expires" }
	);
}

const putHeaderKeys = [
	"cache-control",
	"content-disposition",
	"content-encoding",
	"content-language",
	"content-length",
	"content-type",
	"expires",
] as const;

/**
 * Uploads an object to remote R2
 */
export async function putRemoteObject(
	complianceConfig: ComplianceConfig,
	accountId: string,
	bucketName: string,
	objectName: string,
	object: Readable | ReadableStream | Buffer,
	options: Record<(typeof putHeaderKeys)[number], string | undefined>,
	force: boolean,
	jurisdiction?: string,
	storageClass?: string
): Promise<void> {
	const headers: HeadersInit = {};
	for (const key of putHeaderKeys) {
		const value = options[key] || "";
		if (value && typeof value === "string") {
			headers[key] = value;
		}
	}
	if (jurisdiction !== undefined) {
		headers["cf-r2-jurisdiction"] = jurisdiction;
	}

	if (storageClass !== undefined) {
		headers["cf-r2-storage-class"] = storageClass;
	}
	if (!force) {
		headers["cf-r2-data-catalog-check"] = "true";
	}

	const result = await fetchR2Objects(
		complianceConfig,
		`/accounts/${accountId}/r2/buckets/${bucketName}/objects/${objectName}`,
		{
			body: object,
			headers,
			method: "PUT",
			duplex: "half",
		}
	);
	if (result === null) {
		throw new UserError("The specified bucket does not exist.", {
			telemetryMessage: "r2 object put bucket not found",
		});
	}
}
/**
 * Delete an Object
 */
export async function deleteR2Object(
	complianceConfig: ComplianceConfig,
	accountId: string,
	bucketName: string,
	objectName: string,
	force: boolean,
	jurisdiction?: string
): Promise<void> {
	const headers: HeadersInit = {};
	if (jurisdiction !== undefined) {
		headers["cf-r2-jurisdiction"] = jurisdiction;
	}
	if (!force) {
		headers["cf-r2-data-catalog-check"] = "true";
	}
	await fetchR2Objects(
		complianceConfig,
		`/accounts/${accountId}/r2/buckets/${bucketName}/objects/${objectName}`,
		{ method: "DELETE", headers }
	);
}

export async function usingLocalBucket<T>(
	persistTo: string | undefined,
	config: Config,
	bucketName: string,
	closure: (
		namespace: ReplaceWorkersTypes<R2Bucket>,
		mf: Miniflare
	) => Promise<T>
): Promise<T> {
	const persist = getLocalPersistencePath(persistTo, config);
	const resourcePersistencePath = getDefaultPersistRoot(persist);
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			// TODO(soon): import `reduceError()` from `miniflare:shared`
			script: `
    function reduceError(e) {
      return {
        name: e?.name,
        message: e?.message ?? String(e),
        stack: e?.stack,
        cause: e?.cause === undefined ? undefined : reduceError(e.cause),
      };
    }
    export default {
      async fetch(request, env, ctx) {
        try {
          if (request.method !== "PUT") return new Response(null, { status: 405 });
          const url = new URL(request.url);
          const key = decodeURIComponent(url.pathname.substring(1));
          const optsHeader = request.headers.get("Wrangler-R2-Put-Options");
          const opts = JSON.parse(optsHeader);
          await env.BUCKET.put(key, request.body, opts);
          return new Response(null, { status: 204 });
        } catch (e) {
          const error = reduceError(e);
          return Response.json(error, {
            status: 500,
            headers: { "MF-Experimental-Error-Stack": "true" },
          });
        }
      }
    }`,
			resourcePersistencePath,
			r2Buckets: { BUCKET: bucketName },
		})
	);
	const bucket = await mf.getR2Bucket("BUCKET");
	try {
		return await closure(bucket, mf);
	} finally {
		await mf.dispose();
	}
}

/**
 * Extract the bucket and key from an object path, validating the bucket name in the process.
 *
 * Throws when an invalid format is provided or when the bucket name is invalid.
 *
 * @param objectPath The path passed to wrangler commands in the format `{bucket}/{key}`
 * @returns The bucket and key extracted from the object path
 */
export function validateAndReturnBucketAndKey(objectPath: string): {
	bucket: string;
	key: string;
} {
	// Path format is `<bucket>/<key>`
	const match = /^(?<bucket>[^/]+)\/(?<key>.*)/.exec(objectPath);
	if (match === null || !match.groups) {
		throw new UserError(
			`The object path must be in the form of {bucket}/{key} you provided ${objectPath}`,
			{ telemetryMessage: "r2 object path invalid format" }
		);
	}
	const { bucket, key } = match.groups;
	if (!isValidR2BucketName(bucket)) {
		throw new UserError(
			`The bucket name "${bucket}" is invalid. ${bucketFormatMessage}`,
			{ telemetryMessage: "r2 object path invalid bucket name" }
		);
	}

	return { bucket, key };
}
