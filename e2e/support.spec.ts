import { test, expect } from "@playwright/test";
import { findFreePort, PortInUseError, startMockServer, type MockServer } from "./support/mockServer";
import { startStaticServer } from "./support/staticServer";

// The servers the suite starts, without a browser. Every test has a server of its own on a
// port of its own, and four workers start them at the same time: what a test is given has to
// be its server, and not the one of the test next to it.

const health = async (server: Pick<MockServer, "baseURL">): Promise<number | string> => {
  try {
    return (await fetch(`${server.baseURL}/health`)).status;
  } catch (error) {
    return `failed: ${String((error as Error).cause ?? error)}`;
  }
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a mock server that does not get its port is not taken for the one that has it", async () => {
  const first = await startMockServer();
  try {
    // regression: /health of the port answered (the first server did), and the start of the
    // second one returned as if it had worked while its process died with EADDRINUSE
    const second = startMockServer({ port: first.port });
    await expect(second).rejects.toThrow(PortInUseError);
    await expect(second).rejects.toThrow(`could not listen on port ${first.port}`);
    // the server that has the port is untouched
    expect(isAlive(first.pid)).toBe(true);
    expect(await health(first)).toBe(200);
  } finally {
    await first.stop();
  }
});

test("a free port that is taken by the time the mock wants it: the next one is tried, and the server is the test's own", async () => {
  const first = await startMockServer();
  let asked = 0;
  // what the probe of a second worker returns when the kernel hands it the port the first is about to bind
  const findPort = async () => (asked++ === 0 ? first.port : findFreePort());
  let second: MockServer | undefined;
  try {
    second = await startMockServer({ findPort });
    expect(asked).toBe(2);
    expect(second.port).not.toBe(first.port);
    expect(second.pid).not.toBe(first.pid);
    expect(isAlive(second.pid)).toBe(true);
    expect(second.output()).toContain(`Mock debugger server running at http://localhost:${second.port}\n`);
    expect(second.output()).not.toContain("EADDRINUSE");

    // the end of the first test does not take the server of the second with it
    await first.stop();
    expect(await health(second)).toBe(200);
    expect(await health(first)).toMatch(/^failed: /);
  } finally {
    await first.stop();
    await second?.stop();
  }
});

test("a port that stays taken is given up after five tries, with the reason", async () => {
  const first = await startMockServer();
  let asked = 0;
  try {
    const second = startMockServer({
      findPort: async () => {
        asked++;
        return first.port;
      },
    });
    await expect(second).rejects.toThrow(PortInUseError);
    expect(asked).toBe(5);
  } finally {
    await first.stop();
  }
});

test("two static servers started together each have a port of their own", async () => {
  const servers = await Promise.all([startStaticServer(), startStaticServer()]);
  try {
    expect(servers[0].origin).not.toBe(servers[1].origin);
    for (const server of servers) {
      expect(server.url).toBe(`${server.origin}/ui/`);
      const page = await fetch(`${server.url}index.html`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('<div id="root">');
    }
  } finally {
    await Promise.all(servers.map((server) => server.stop()));
  }
});
