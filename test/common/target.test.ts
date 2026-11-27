import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { EKS_FORWARDS, LOCAL_PORTS, forwardHost, forwardUrl, localUrl } from "../../src/common/ports.js";
import { currentTarget, explicitSetting, resetTargetCache } from "../../src/common/target.js";
import { decodeKubernetesSecret, describeUri, eksMongoUri } from "../../src/mongo/mongo.js";
import { signozUrl } from "../../src/signoz/signoz.js";
import { vmagentUrl, vmUrl } from "../../src/victoriametrics/victoriametrics.js";

const folder = mkdtempSync(join(tmpdir(), "ssp-ming-target-"));
const file = join(folder, "target");
const saved = { ...process.env };

function setEnv(values: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  resetTargetCache();
}

beforeEach(() => {
  rmSync(file, { force: true });
  setEnv({
    SSP_MING_MCP_TARGET: undefined,
    SSP_MING_MCP_TARGET_FILE: file,
    VM_URL: undefined,
    VMAGENT_URL: undefined,
    SIGNOZ_URL: undefined,
  });
});

after(() => {
  rmSync(folder, { recursive: true, force: true });
  for (const name of Object.keys(process.env)) {
    if (!(name in saved)) {
      delete process.env[name];
    }
  }
  Object.assign(process.env, saved);
  resetTargetCache();
});

describe("target resolution", () => {
  it("defaults to local without a file", () => {
    assert.equal(currentTarget().target, "local");
    assert.match(currentTarget().source, /^default/);
  });

  it("reads the first word of the file, case-insensitively", () => {
    writeFileSync(file, "  EKS \n# comment");
    resetTargetCache();
    assert.deepEqual(currentTarget(), { target: "eks", source: `file ${file}` });
  });

  it("lets SSP_MING_MCP_TARGET override the file", () => {
    writeFileSync(file, "eks");
    setEnv({ SSP_MING_MCP_TARGET: "local" });
    assert.equal(currentTarget().target, "local");
  });

  it("rejects an unknown value instead of falling back to local", () => {
    writeFileSync(file, "prod");
    resetTargetCache();
    assert.throws(() => currentTarget(), /must be one of: local, eks, kind/);
  });

  it("treats blank variables as unset, as .mcp.json passes them", () => {
    setEnv({ VM_URL: "  " });
    assert.equal(explicitSetting("VM_URL"), undefined);
  });
});

describe("URLs per target", () => {
  it("local: Compose ports from ports.json, vmagent is the single", () => {
    assert.equal(vmUrl(), localUrl("victoriametrics"));
    assert.equal(vmagentUrl(), localUrl("victoriametrics"));
    assert.equal(signozUrl(), localUrl("signoz"));
  });

  it("eks: the forwarded ports from ports.json", () => {
    setEnv({ SSP_MING_MCP_TARGET: "eks" });
    assert.equal(vmUrl(), forwardUrl("vmsingle"));
    assert.equal(vmagentUrl(), forwardUrl("vmagent"));
    assert.equal(signozUrl(), forwardUrl("signoz"));
  });

  it("kind: the same forwarded ports as eks", () => {
    setEnv({ SSP_MING_MCP_TARGET: "kind" });
    assert.equal(currentTarget().target, "kind");
    assert.equal(vmUrl(), forwardUrl("vmsingle"));
    assert.equal(vmagentUrl(), forwardUrl("vmagent"));
    assert.equal(signozUrl(), forwardUrl("signoz"));
  });

  it("an explicit URL wins over the target", () => {
    setEnv({ SSP_MING_MCP_TARGET: "eks", VM_URL: "http://localhost:9999/", SIGNOZ_URL: "http://localhost:9998" });
    assert.equal(vmUrl(), "http://localhost:9999");
    assert.equal(vmagentUrl(), "http://localhost:9999");
    assert.equal(signozUrl(), "http://localhost:9998");
  });
});

describe("EKS Mongo URI", () => {
  it("URL-encodes the credentials and points at the forwarded port", () => {
    const uri = eksMongoUri(JSON.stringify({ MONGO_INITDB_ROOT_USERNAME: "root", MONGO_INITDB_ROOT_PASSWORD: "p@ss:w/rd" }), "ssp-exchange");
    assert.equal(uri, `mongodb://root:p%40ss%3Aw%2Frd@${forwardHost("mongo")}/ssp-exchange?authSource=admin&directConnection=true`);
  });

  it("refuses a secret without the expected keys", () => {
    assert.throws(() => eksMongoUri(JSON.stringify({ user: "x" }), "ssp-exchange"), /MONGO_INITDB_ROOT_USERNAME/);
  });

  it("kind: decodes a Kubernetes Secret into the same shape as the Secrets Manager secret", () => {
    const manifest = JSON.stringify({
      data: {
        MONGO_INITDB_ROOT_USERNAME: Buffer.from("root").toString("base64"),
        MONGO_INITDB_ROOT_PASSWORD: Buffer.from("p@ss").toString("base64"),
      },
    });
    const uri = eksMongoUri(decodeKubernetesSecret(manifest), "ssp-bidders");
    assert.equal(uri, `mongodb://root:p%40ss@${forwardHost("mongo")}/ssp-bidders?authSource=admin&directConnection=true`);
  });

  it("kind: a Secret without data lacks the expected keys", () => {
    assert.throws(() => eksMongoUri(decodeKubernetesSecret(JSON.stringify({})), "ssp-exchange"), /MONGO_INITDB_ROOT_USERNAME/);
  });

  it("describes a URI without its credentials", () => {
    assert.equal(describeUri("mongodb://root:secret@localhost:37017/ssp-exchange?authSource=admin"), "localhost:37017/ssp-exchange");
  });
});

describe("ports.json", () => {
  it("gives every local service and every forward its own laptop port", () => {
    const laptopPorts = [
      ...Object.values(LOCAL_PORTS).map((local) => local.port),
      ...Object.values(EKS_FORWARDS).map((forward) => forward.localPort),
    ];
    const repeated = laptopPorts.filter((port, index) => laptopPorts.indexOf(port) !== index);
    assert.deepEqual(repeated, [], `ports used twice: ${repeated.join(", ")}`);
  });
});
