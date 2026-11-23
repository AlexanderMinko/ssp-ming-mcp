import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { andFilter, orderTrace, queryRangeBody, quoteLiteral, shapeLog, shapeSpan } from "../../src/signoz/signoz.js";

describe("filter building", () => {
  it("quotes literals and escapes quotes and backslashes", () => {
    assert.equal(quoteLiteral("exchange"), "'exchange'");
    assert.equal(quoteLiteral("it's"), "'it\\'s'");
    assert.equal(quoteLiteral("a\\b"), "'a\\\\b'");
  });

  it("ANDs only the non-empty conditions, each in parentheses", () => {
    assert.equal(andFilter([undefined, "service.name = 'exchange'", " ", "a = 1 OR b = 2"]), "(service.name = 'exchange') AND (a = 1 OR b = 2)");
    assert.equal(andFilter([undefined]), "");
  });
});

describe("query_range body", () => {
  it("builds a raw logs query in milliseconds, newest first", () => {
    const body = queryRangeBody("raw", 1000.7, 2000.2, { signal: "logs", filter: "x = 1", limit: 10 });
    assert.equal(body.start, 1000);
    assert.equal(body.end, 2000);
    assert.equal(body.requestType, "raw");
    const spec = (body.compositeQuery as { queries: Array<{ spec: Record<string, unknown> }> }).queries[0]?.spec;
    assert.ok(spec);
    assert.equal(spec.signal, "logs");
    assert.deepEqual(spec.filter, { expression: "x = 1" });
    assert.deepEqual(spec.order, [{ key: { name: "timestamp" }, direction: "desc" }]);
    assert.equal(spec.aggregations, undefined);
  });

  it("builds a scalar aggregation ordered by its value", () => {
    const body = queryRangeBody("scalar", 0, 1, {
      signal: "traces",
      filter: "",
      limit: 5,
      aggregations: [{ expression: "count()", alias: "value" }],
      groupBy: ["service.name"],
    });
    const spec = (body.compositeQuery as { queries: Array<{ spec: Record<string, unknown> }> }).queries[0]?.spec;
    assert.ok(spec);
    assert.deepEqual(spec.groupBy, [{ name: "service.name" }]);
    assert.deepEqual(spec.order, [{ key: { name: "value" }, direction: "desc" }]);
  });
});

describe("row shaping", () => {
  it("shapes a log row and cuts long bodies", () => {
    const line = shapeLog(
      {
        timestamp: "2026-11-21T10:00:00Z",
        data: {
          body: "x".repeat(30),
          severity_text: "ERROR",
          resources_string: { "service.name": "exchange" },
          attributes_string: { logger: "BidderService" },
          trace_id: "abc",
          span_id: "",
        },
      },
      10,
      true,
    );
    assert.equal(line.time, "2026-11-21T10:00:00Z");
    assert.equal(line.severity, "ERROR");
    assert.equal(line.service, "exchange");
    assert.equal(line.body, "xxxxxxxxxx… (30 chars)");
    assert.equal(line.traceId, "abc");
    assert.equal(line.spanId, undefined);
    assert.deepEqual(line.attributes, { logger: "BidderService" });
  });

  it("shapes a span row from either key spelling", () => {
    const span = shapeSpan({
      data: {
        timestamp: 1_800_000_000_000_000_000,
        name: "POST /openrtb2/auction",
        duration_nano: 12_345_678,
        traceID: "t1",
        spanID: "s1",
        parentSpanID: "",
        hasError: "true",
        resource: { "service.name": "exchange" },
        attributes_string: { "http.response.status_code": "500" },
      },
    });
    assert.equal(span.service, "exchange");
    assert.equal(span.durationMs, 12.35);
    assert.equal(span.traceId, "t1");
    assert.equal(span.parentSpanId, undefined);
    assert.equal(span.hasError, true);
    assert.equal(span.statusCode, "500");
    assert.equal(span.time, new Date(1_800_000_000_000).toISOString());
  });
});

describe("pod-log rows from the EKS k8s-infra agent", () => {
  it("takes the service from k8s.deployment.name and the severity from a level attribute", () => {
    const line = shapeLog(
      {
        data: {
          body: "{}",
          severity_text: "",
          timestamp: 1_800_000_000_000_000_000,
          resources_string: { "k8s.deployment.name": "bidders", "k8s.pod.name": "bidders-1" },
          attributes_string: { level: "INFO" },
        },
      },
      100,
      false,
    );
    assert.equal(line.service, "bidders");
    assert.equal(line.severity, "INFO");
  });
});

describe("trace ordering", () => {
  it("puts children under their parent with depth and start offset", () => {
    const spans = orderTrace([
      { spanId: "child-2", parentSpanId: "root", time: "2026-11-21T10:00:00.030Z" },
      { spanId: "grandchild", parentSpanId: "child-1", time: "2026-11-21T10:00:00.015Z" },
      { spanId: "root", time: "2026-11-21T10:00:00.000Z" },
      { spanId: "child-1", parentSpanId: "root", time: "2026-11-21T10:00:00.010Z" },
      { spanId: "orphan", parentSpanId: "missing", time: "2026-11-21T10:00:00.050Z" },
    ]);
    assert.deepEqual(
      spans.map((span) => [span.spanId, span.depth, span.offsetMs]),
      [
        ["root", 0, 0],
        ["child-1", 1, 10],
        ["grandchild", 2, 15],
        ["child-2", 1, 30],
        ["orphan", 0, 50],
      ],
    );
  });
});
