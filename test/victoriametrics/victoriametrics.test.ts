import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sampleValue } from "../../src/victoriametrics/victoriametrics.js";
import { autoStepSeconds, parseDurationSeconds, parseTime } from "../../src/common/time.js";

const NOW = 1_800_000_000;

describe("time parsing", () => {
  it("reads durations", () => {
    assert.equal(parseDurationSeconds("90s"), 90);
    assert.equal(parseDurationSeconds("5m"), 300);
    assert.equal(parseDurationSeconds("2h"), 7200);
    assert.equal(parseDurationSeconds("1w"), 604_800);
    assert.throws(() => parseDurationSeconds("5 minutes"));
  });

  it("reads now, relative, unix and RFC 3339 times", () => {
    assert.equal(parseTime("now", NOW), NOW);
    assert.equal(parseTime("now-1h", NOW), NOW - 3600);
    assert.equal(parseTime("1700000000", NOW), 1_700_000_000);
    assert.equal(parseTime("2026-11-13T10:00:00Z", NOW), Date.UTC(2026, 10, 13, 10) / 1000);
    assert.equal(parseTime("2026-11-13T10:00:00", NOW), Date.UTC(2026, 10, 13, 10) / 1000);
    assert.equal(parseTime("2026-11-13T12:00:00+02:00", NOW), Date.UTC(2026, 10, 13, 10) / 1000);
    assert.throws(() => parseTime("yesterday", NOW));
  });

  it("picks a step of about 120 points", () => {
    assert.equal(autoStepSeconds(NOW - 3600, NOW), 30);
    assert.equal(autoStepSeconds(NOW - 60, NOW), 1);
  });
});

describe("sample values", () => {
  it("turns finite strings into numbers and keeps NaN and Inf as strings", () => {
    assert.equal(sampleValue("0.25"), 0.25);
    assert.equal(sampleValue("NaN"), "NaN");
    assert.equal(sampleValue("+Inf"), "+Inf");
  });
});
