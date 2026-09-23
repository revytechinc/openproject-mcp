import test from "node:test";
import assert from "node:assert/strict";
import { createApi } from "../lib/api.js";
import {
  parseBearerAuthorization,
  runWithCallerToken,
  resolveOpenProjectToken,
  getCallerToken,
} from "../lib/auth-context.js";

test("parseBearerAuthorization accepts Bearer only", () => {
  assert.equal(parseBearerAuthorization("Bearer abc.def"), "abc.def");
  assert.equal(parseBearerAuthorization("bearer xyz"), "xyz");
  assert.equal(parseBearerAuthorization("Basic abc"), null);
  assert.equal(parseBearerAuthorization(""), null);
  assert.equal(parseBearerAuthorization(null), null);
});

test("resolveOpenProjectToken prefers caller ALS over env", async () => {
  const prev = process.env.OPENPROJECT_API_KEY;
  process.env.OPENPROJECT_API_KEY = "env-key";
  try {
    assert.equal(resolveOpenProjectToken(), "env-key");
    await runWithCallerToken("caller-key", async () => {
      assert.equal(getCallerToken(), "caller-key");
      assert.equal(resolveOpenProjectToken(), "caller-key");
    });
    assert.equal(resolveOpenProjectToken(), "env-key");
  } finally {
    if (prev === undefined) delete process.env.OPENPROJECT_API_KEY;
    else process.env.OPENPROJECT_API_KEY = prev;
  }
});

test("createApi fail-closed when no token", async () => {
  const api = createApi({
    baseUrl: "https://example.invalid",
    getApiKey: () => "",
    fetchImpl: async () => {
      throw new Error("should not fetch");
    },
  });
  await assert.rejects(() => api.request("/api/v3/users/me"), /401/);
});

test("createApi uses caller token from getApiKey", async () => {
  const calls = [];
  const api = createApi({
    baseUrl: "https://example.invalid",
    getApiKey: () => "tok-1",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        async text() {
          return '{"_type":"User","id":1}';
        },
      };
    },
  });
  const result = await api.request("/api/v3/users/me");
  assert.equal(result.id, 1);
  const decoded = Buffer.from(
    calls[0].init.headers.Authorization.slice(6),
    "base64"
  ).toString();
  assert.equal(decoded, "apikey:tok-1");
});
