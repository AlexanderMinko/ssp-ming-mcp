import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bidderInput, creativeInput, defaultBidderId, defaultCreativeId, defaultSupplyPartnerId, supplyPartnerKey } from "../../src/mongo/schemas.js";

describe("supplyPartnerKey", () => {
  it("accepts a SOURCE with a 3-char sourceId", () => {
    const key = supplyPartnerKey.parse({ entityType: "SOURCE", sourceId: "amz" });
    assert.equal(defaultSupplyPartnerId(key), "src-amz");
  });

  it("rejects a SOURCE whose sourceId is not 3 chars", () => {
    assert.throws(() => supplyPartnerKey.parse({ entityType: "SOURCE", sourceId: "amzn" }), /3 characters/);
  });

  it("rejects a PUBLISHER without publisherId", () => {
    assert.throws(() => supplyPartnerKey.parse({ entityType: "PUBLISHER", sourceId: "amz" }));
  });

  it("derives pub-<publisherId> for a PUBLISHER", () => {
    const key = supplyPartnerKey.parse({ entityType: "PUBLISHER", publisherId: "pub-100" });
    assert.equal(defaultSupplyPartnerId(key), "pub-pub-100");
  });
});

describe("bidderInput", () => {
  it("requires endpoint to be a path", () => {
    assert.throws(
      () => bidderInput.parse({ name: "alpha", seat: "seat-alpha", endpoint: "http://x/bid" }),
      /starting with \//,
    );
  });

  it("accepts a bidder without tmaxMs and derives its id", () => {
    const parsed = bidderInput.parse({ name: "alpha", seat: "seat-alpha", endpoint: "/bid/alpha" });
    assert.equal(parsed.tmaxMs, undefined);
    assert.equal(defaultBidderId(parsed.name), "bidder-alpha");
  });

  it("rejects a non-positive tmaxMs", () => {
    assert.throws(() => bidderInput.parse({ name: "a", seat: "s", endpoint: "/b", tmaxMs: 0 }));
  });
});

describe("creativeInput", () => {
  const banner = { bidderId: "bidder-alpha", crid: "alpha-1", format: "BANNER", w: 300, h: 250, priceCpm: 1.5, adomain: ["a.example"], adm: "<div/>" };

  it("accepts a banner, defaults cat to [] and derives cr-<crid>", () => {
    const parsed = creativeInput.parse(banner);
    assert.deepEqual(parsed.cat, []);
    assert.equal(defaultCreativeId(parsed.crid), "cr-alpha-1");
  });

  it("rejects a VIDEO creative without a video spec", () => {
    assert.throws(() => creativeInput.parse({ ...banner, format: "VIDEO" }), /video spec is required/);
  });

  it("rejects a BANNER creative carrying a video spec", () => {
    assert.throws(
      () => creativeInput.parse({ ...banner, video: { durationSec: 15, mimes: ["video/mp4"] } }),
      /must not carry/,
    );
  });

  it("rejects a non-positive price and an empty adomain", () => {
    assert.throws(() => creativeInput.parse({ ...banner, priceCpm: 0 }));
    assert.throws(() => creativeInput.parse({ ...banner, adomain: [] }));
  });
});
