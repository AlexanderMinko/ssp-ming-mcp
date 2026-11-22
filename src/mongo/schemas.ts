import { z } from "zod";

/** Mirrors ssp-ming-exchange's SupplyPartnerType enum. */
export const supplyPartnerType = z.enum(["SOURCE", "PUBLISHER"]);
export type SupplyPartnerType = z.infer<typeof supplyPartnerType>;

/** The `?account=` URL param on the exchange: always three characters. */
export const sourceId = z.string().length(3, "sourceId must be exactly 3 characters");
export const publisherId = z.string().min(1, "publisherId must not be empty");
export const name = z.string().min(1, "name must not be empty");

/** Natural key of a supply partner: SOURCE → sourceId, PUBLISHER → publisherId. */
export const supplyPartnerKey = z.discriminatedUnion("entityType", [
  z.object({ entityType: z.literal("SOURCE"), sourceId }),
  z.object({ entityType: z.literal("PUBLISHER"), publisherId }),
]);
export type SupplyPartnerKey = z.infer<typeof supplyPartnerKey>;

export const bidderInput = z.object({
  id: z.string().min(1).optional().describe("Mongo _id. Defaults to bidder-<name>."),
  name: name.describe("Short bidder name, e.g. alpha"),
  seat: z.string().min(1).describe("Seat id returned in seatbid, e.g. seat-alpha"),
  endpoint: z
    .string()
    .startsWith("/", "endpoint must be a path starting with /")
    .describe("Path on the bidders service, joined to exchange.bidder.base-url, e.g. /bid/alpha"),
  tmaxMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional per-bidder deadline in ms. Only ever shortens the auction deadline."),
});
export type BidderInput = z.infer<typeof bidderInput>;

/** Spring Data writes this discriminator; we write the same so documents look identical either way. */
export const springClass = {
  supplyPartner: "com.ming.sspexchange.model.entity.SupplyPartner",
  bidder: "com.ming.sspexchange.model.entity.Bidder",
} as const;

export function defaultSupplyPartnerId(key: SupplyPartnerKey): string {
  if (key.entityType === "SOURCE") {
    return `src-${key.sourceId}`;
  }
  return `pub-${key.publisherId}`;
}

export function defaultBidderId(bidderName: string): string {
  return `bidder-${bidderName}`;
}

/** Mirrors ssp-ming-bidders' CreativeFormat enum. */
export const creativeFormat = z.enum(["BANNER", "VIDEO"]);

const videoSpec = z.object({
  durationSec: z.number().int().positive().describe("Matched against imp.video.maxduration"),
  mimes: z.array(z.string().min(1)).nonempty().describe("Matched against imp.video.mimes, e.g. [\"video/mp4\"]"),
});

const creativeFields = {
  id: z.string().min(1).optional().describe("Mongo _id. Defaults to cr-<crid>."),
  bidderId: z.string().min(1).describe("Owning bidder's _id in the bidders service, e.g. bidder-alpha"),
  crid: z.string().min(1).describe("Creative id returned in the bid, e.g. alpha-300x250-hi"),
  format: creativeFormat,
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  priceCpm: z.number().positive().describe("USD CPM bid price, first price"),
  adomain: z.array(z.string().min(1)).nonempty().describe("Advertiser domains"),
  cat: z.array(z.string().min(1)).default([]).describe("IAB categories, e.g. [\"IAB18\"]"),
  adm: z.string().min(1).describe("HTML (banner) or VAST 3.0 XML (video) with exchange macros left in"),
  video: videoSpec.optional().describe("Required for VIDEO, must be absent for BANNER"),
};
export const creativeShape = creativeFields;
export const creativeInput = z.object(creativeFields).superRefine((value, ctx) => {
  if (value.format === "VIDEO" && !value.video) {
    ctx.addIssue({ code: "custom", path: ["video"], message: "video spec is required for a VIDEO creative" });
  }
  if (value.format === "BANNER" && value.video) {
    ctx.addIssue({ code: "custom", path: ["video"], message: "a BANNER creative must not carry a video spec" });
  }
});
export type CreativeInput = z.infer<typeof creativeInput>;

export function defaultCreativeId(crid: string): string {
  return `cr-${crid}`;
}
