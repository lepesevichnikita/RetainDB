import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Hono } from "hono";

const origin = "https://dashboard.example.test";
const authUrl = "https://identity.example.test/api/authz/forward-auth";
const cookie = "authelia_session=fixture-session";

async function fixture(t: TestContext) {
  process.env.RETAINDB_DASHBOARD_ORIGIN = origin;
  process.env.RETAINDB_DASHBOARD_AUTH_URL = authUrl;
  t.mock.method(globalThis, "fetch", async (url: string | URL, init?: RequestInit) => {
    assert.equal(String(url), authUrl);
    const headers = new Headers(init?.headers);
    assert.equal(init?.redirect, "manual");
    assert.equal(headers.get("x-forwarded-host"), new URL(origin).host);
    assert.equal(headers.get("x-forwarded-proto"), "https");
    assert.equal(headers.has("authorization"), false);
    if (headers.get("cookie") === "authelia_session=identity-missing") return new Response(null);
    if (headers.get("cookie") === "authelia_session=denied") return new Response(null, { status: 403 });
    if (headers.get("cookie") === "authelia_session=get-only-admin") {
      return headers.get("x-forwarded-method") === "GET"
        ? new Response(null, { headers: { "Remote-User": "fixture-admin", "Remote-Groups": "admins" } })
        : new Response(null, { status: 403 });
    }
    if (headers.get("cookie") === "authelia_session=unavailable") throw new TypeError("fixture network error");
    if (headers.get("cookie") === "authelia_session=admin") {
      return new Response(null, { headers: { "Remote-User": "fixture-admin", "Remote-Groups": "other, admins" } });
    }
    if (headers.get("cookie") === "authelia_session=similar-group") {
      return new Response(null, { headers: { "Remote-User": "fixture-reader", "Remote-Groups": "not-admins,admins-extra" } });
    }
    if (headers.get("cookie") !== cookie) return Response.redirect("https://identity.example.test/");
    return new Response(null, { headers: { "Remote-User": "fixture-operator" } });
  });
  const { createNodeApp } = await import("../src/api/app.js");
  const api = new Hono();
  api.get("/v1/fixtures/resolve", (c) => c.json({ resolved: true }));
  api.get("/v1/fixtures/:id", (c) => c.json({ ok: true }));
  return createNodeApp({ routeApp: api });
}

test("the browser dashboard authenticates its own origin and preserves the JSON root", async (t) => {
  const app = await fixture(t);

  // The browser root links to the console; old machine clients still get JSON.
  const browser = await app.request(`${origin}/`, { headers: { accept: "text/html" } });
  assert.equal(browser.status, 302);
  assert.equal(browser.headers.get("location"), "/dashboard");
  assert.match((await app.request(`${origin}/`)).headers.get("content-type") ?? "", /application\/json/);
  const machine = await app.request("https://machine.example.test/", { headers: { accept: "text/html" } });
  assert.match(machine.headers.get("content-type") ?? "", /application\/json/);

  for (const path of ["/dashboard", "/dashboard/data/projects", "/dashboard/data/logs"]) {
    const anonymous = await app.request(`${origin}${path}`, { headers: { "Remote-User": "not-a-session" } });
    assert.equal(anonymous.status, 401, path);
    assert.equal(anonymous.headers.get("cache-control"), "no-store");
  }
  const wrongHost = await app.request("https://machine.example.test/dashboard/data/logs", { headers: { cookie, "x-forwarded-host": new URL(origin).host } });
  assert.equal(wrongHost.status, 404);
  const spoofed = await app.request(`${origin}/dashboard/data/logs`, { headers: { authorization: "Bearer not-a-session", "Remote-User": "operator" } });
  assert.equal(spoofed.status, 401);
  const expired = await app.request(`${origin}/dashboard/data/logs`, { headers: { cookie: "authelia_session=expired" } });
  assert.equal(expired.status, 401);
  const duplicate = await app.request(`${origin}/dashboard/data/logs`, { headers: { cookie: `${cookie}; ${cookie}` } });
  assert.equal(duplicate.status, 401);
  for (const [session, status] of [["identity-missing", 401], ["denied", 403], ["unavailable", 503]] as const) {
    const refused = await app.request(`${origin}/dashboard/data/logs`, { headers: { cookie: `authelia_session=${session}` } });
    assert.equal(refused.status, status, session);
  }

  const page = await app.request(`${origin}/dashboard`, { headers: { cookie, origin: "https://other.example.test" } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.has("access-control-allow-origin"), false);
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  const pageText = await page.text();
  for (const name of ["Overview", "Knowledge graph", "Vector map", "Queue", "Logs"]) assert.ok(pageText.includes(name));
  const asset = await app.request(`${origin}/dashboard/assets/dashboard.js`, { headers: { cookie } });
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type") ?? "", /javascript/);
  const mutation = await app.request(`${origin}/dashboard/data/logs`, { method: "POST", headers: { cookie } });
  assert.equal(mutation.status, 404);
});

test("the dashboard displays administrator access only for the admins group verified by Authelia", async (t) => {
  const app = await fixture(t);
  // A browser-supplied group cannot override Authelia's decision.
  for (const session of [cookie, "authelia_session=similar-group"]) {
    const reader = await app.request(`${origin}/dashboard`, { headers: { cookie: session, "Remote-Groups": "admins" } });
    assert.equal(reader.status, 200);
    assert.match(await reader.text(), /class="badge">Read-only<\/span>/);
  }
  const admin = await app.request(`${origin}/dashboard`, { headers: { cookie: "authelia_session=admin" } });
  assert.equal(admin.status, 200);
  assert.match(await admin.text(), /class="badge">Administrator<\/span>/);
});

test("the dashboard respects a method-specific Authelia denial for an administrator", async (t) => {
  const app = await fixture(t);
  const headers = { cookie: "authelia_session=get-only-admin", origin, "Content-Type": "application/json" };
  assert.equal((await app.request(`${origin}/dashboard`, { headers })).status, 200);
  const rebuild = await app.request(`${origin}/dashboard/rebuilds`, { method: "POST", headers, body: "{}" });
  assert.equal(rebuild.status, 403);
  assert.deepEqual(await rebuild.json(), { error: "Dashboard access requires a valid session." });
});

test("a non-HTTPS authorization endpoint leaves the API live and the dashboard disabled", async (t) => {
  t.mock.method(console, "error", () => {});
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://retaindb_unused@127.0.0.1:1/retaindb_unused";
  t.after(() => {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });
  process.env.RETAINDB_DASHBOARD_ORIGIN = origin;
  process.env.RETAINDB_DASHBOARD_AUTH_URL = "http://identity.example.test/";
  const { createNodeApp } = await import("../src/api/app.js");
  const app = createNodeApp();
  assert.equal((await app.request(`${origin}/livez`)).status, 200);
  // This process has no database, so readiness must report that instead of faking success.
  assert.equal((await app.request(`${origin}/health`)).status, 503);
  assert.equal((await app.request(`${origin}/dashboard`, { headers: { cookie } })).status, 404);
});

test("logs reflect real API outcomes without paths, headers, cookies or dashboard polling", async (t) => {
  const app = await fixture(t);
  const token = "private-fixture-sentinel";
  const headers = { cookie, authorization: `Bearer ${token}`, "x-request-id": token };
  const request = await app.request(`${origin}/v1/fixtures/${token}?secret=${token}`, { headers });
  assert.equal(request.status, 200);
  // Both templates match; only the exact handler actually runs.
  assert.deepEqual(await (await app.request(`${origin}/v1/fixtures/resolve`)).json(), { resolved: true });
  await app.request(`${origin}/v1/missing/${token}`);

  const read = () => app.request(`${origin}/dashboard/data/logs`, { headers });
  const response = await read();
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(!body.includes(token));
  assert.ok(!body.includes("fixture-session"));
  const { rows } = JSON.parse(body);
  assert.deepEqual(rows.map(({ method, route, status }: { method: string; route: string; status: number }) => [method, route, status]), [
    ["GET", "Unmatched API route", 404], ["GET", "/v1/fixtures/resolve", 200], ["GET", "/v1/fixtures/:id", 200],
  ]);
  assert.ok(rows.every((entry: { at: string; durationMs: number }) => Number.isFinite(Date.parse(entry.at)) && entry.durationMs >= 0));
  assert.equal((await (await read()).json()).rows.length, 3);
});
