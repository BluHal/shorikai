// Mock DAP adapter for dap-core tests: TCP server speaking Content-Length
// framed DAP. Stops at a breakpoint only if setBreakpoints for line 7
// arrived before configurationDone — so the test proves breakpoint replay
// ordering, not just event plumbing.
import net from "node:net";

const port = Number(process.argv[2]);

const server = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  let seq = 1000;
  let sawBreakpoint = false;

  const send = (obj) => {
    const body = Buffer.from(JSON.stringify({ seq: seq++, ...obj }));
    sock.write(`Content-Length: ${body.length}\r\n\r\n`);
    sock.write(body);
  };
  const event = (name, body) => send({ type: "event", event: name, body });
  const respond = (req, body = {}) =>
    send({ type: "response", request_seq: req.seq, success: true, command: req.command, body });

  const handle = (req) => {
    switch (req.command) {
      case "initialize":
        respond(req, { supportsConfigurationDoneRequest: true });
        break;
      case "launch":
        respond(req);
        event("initialized", {});
        break;
      case "setBreakpoints": {
        const bps = req.arguments.breakpoints ?? [];
        if (req.arguments.source.path === "/tmp/fake/app.js" && bps.some((b) => b.line === 7)) {
          sawBreakpoint = true;
        }
        respond(req, { breakpoints: bps.map((b) => ({ verified: true, line: b.line })) });
        break;
      }
      case "configurationDone":
        respond(req);
        if (sawBreakpoint) {
          setTimeout(
            () => event("stopped", { reason: "breakpoint", threadId: 1, allThreadsStopped: true }),
            50,
          );
        }
        break;
      case "stackTrace":
        respond(req, {
          stackFrames: [
            { id: 1, name: "main", line: 7, column: 1, source: { path: "/tmp/fake/app.js" } },
          ],
          totalFrames: 1,
        });
        break;
      case "continue":
        respond(req, { allThreadsContinued: true });
        event("continued", { threadId: 1 });
        break;
      default:
        respond(req);
    }
  };

  sock.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buf.slice(0, headerEnd).toString();
      const len = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? 0);
      if (buf.length < headerEnd + 4 + len) return;
      const body = buf.slice(headerEnd + 4, headerEnd + 4 + len).toString();
      buf = buf.slice(headerEnd + 4 + len);
      handle(JSON.parse(body));
    }
  });
});

server.listen(port, "127.0.0.1");
