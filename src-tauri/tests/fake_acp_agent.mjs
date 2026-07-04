// Fake scripted ACP agent for acp-bridge tests: speaks canned JSON-RPC
// (ndjson over stdio). Prompt "garbage" injects a malformed line first.
import readline from "node:readline";

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  switch (msg.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { protocolVersion: 1, agentCapabilities: {} },
      });
      break;
    case "session/new":
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess_fake" } });
      break;
    case "session/prompt": {
      if (msg.params.prompt[0].text === "garbage") {
        process.stdout.write("this is not json\n");
      }
      for (const text of ["Hel", "lo ", "world"]) {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "sess_fake",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            },
          },
        });
      }
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      break;
    }
  }
});
