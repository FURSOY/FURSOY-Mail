import assert from "node:assert/strict";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("renders the focused download landing page", async () => {
  const response = await render();
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /Verification codes\./);
  assert.match(html, /One click away\./);
  assert.match(html, /Download for Windows/);
  assert.match(html, /~5 MB installer/);
  assert.match(html, /No telemetry/);
  assert.match(html, /application\/ld\+json/);
});

test("renders the public privacy policy", async () => {
  const response = await render("/privacy");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /Privacy Policy/);
  assert.match(html, /does not operate a server that stores mailbox data/);
  assert.match(html, /Google API Services User Data Policy/);
});
