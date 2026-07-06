// Fake scripted ACP agent for acp-bridge tests: speaks canned JSON-RPC
// (ndjson over stdio). Behavior is keyed off the prompt text:
//   "garbage"    — injects a malformed line before streaming
//   "tools"      — emits tool_call / tool_call_update pairs, one with a diff
//   "permission" — requests permission, echoes the outcome, then ends the turn
import readline from "node:readline";

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const update = (update) =>
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "sess_fake", update },
  });
const chunk = (text) =>
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

const PERMISSION_RPC_ID = 9001;
let pendingPromptId = null;

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);

  // response to our permission request
  if (msg.method === undefined && msg.id === PERMISSION_RPC_ID) {
    const outcome = msg.result?.outcome;
    chunk(
      outcome?.outcome === "selected"
        ? `approved:${outcome.optionId}`
        : "cancelled",
    );
    send({ jsonrpc: "2.0", id: pendingPromptId, result: { stopReason: "end_turn" } });
    return;
  }

  switch (msg.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { protocolVersion: 1, agentCapabilities: {} },
      });
      break;
    case "session/new":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          sessionId: "sess_fake",
          modes: {
            currentModeId: "default",
            availableModes: [
              { id: "default", name: "Always Ask" },
              { id: "acceptEdits", name: "Accept Edits" },
            ],
          },
          models: {
            currentModelId: "sonnet",
            availableModels: [
              { modelId: "sonnet", name: "Sonnet" },
              { modelId: "opus", name: "Opus" },
            ],
          },
        },
      });
      break;
    case "session/set_mode":
      send({ jsonrpc: "2.0", id: msg.id, result: null });
      update({ sessionUpdate: "current_mode_update", currentModeId: msg.params.modeId });
      break;
    case "session/set_model":
      send({ jsonrpc: "2.0", id: msg.id, result: null });
      break;
    case "session/prompt": {
      const imgs = msg.params.prompt.filter((b) => b.type === "image");
      if (imgs.length > 0) {
        chunk(`images:${imgs.length}:${imgs[0].mimeType}`);
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        break;
      }
      const links = msg.params.prompt.filter((b) => b.type === "resource_link");
      if (links.length > 0) {
        chunk(`linked:${links.map((l) => l.name).join(",")}`);
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        break;
      }
      const text = msg.params.prompt[0].text;
      if (text === "tools") {
        update({
          sessionUpdate: "tool_call",
          toolCallId: "call_1",
          title: "Read package.json",
          kind: "read",
          status: "in_progress",
          rawInput: { path: "package.json" },
        });
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "call_1",
          status: "completed",
          content: [
            { type: "content", content: { type: "text", text: '{ "name": "demo" }' } },
          ],
        });
        update({
          sessionUpdate: "tool_call",
          toolCallId: "call_2",
          title: "Edit src/app.ts",
          kind: "edit",
          status: "in_progress",
          content: [
            {
              type: "diff",
              path: "src/app.ts",
              oldText: "const a = 1;\n",
              newText: "const a = 2;\n",
            },
          ],
        });
        update({ sessionUpdate: "tool_call_update", toolCallId: "call_2", status: "completed" });
        chunk("done");
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        break;
      }
      if (text === "team") {
        update({
          sessionUpdate: "tool_call",
          toolCallId: "task_fe",
          title: "Task: frontend",
          kind: "other",
          status: "in_progress",
          rawInput: {
            subagent_type: "fe-agent",
            description: "Wire pagination controls into the users list UI",
            prompt: "Wire pagination controls...",
          },
        });
        update({
          sessionUpdate: "tool_call",
          toolCallId: "task_be",
          title: "Task: backend",
          kind: "other",
          status: "in_progress",
          rawInput: {
            subagent_type: "be-agent",
            description: "Add offset pagination to GET /users + tests",
          },
        });
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "task_be",
          content: [
            { type: "content", content: { type: "text", text: "reading src/routes/users.ts" } },
          ],
        });
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "task_be",
          status: "completed",
          content: [
            { type: "content", content: { type: "text", text: "12 tests pass · +36 −3" } },
          ],
        });
        // fe-agent stays shallow: no content, straight to completed
        update({ sessionUpdate: "tool_call_update", toolCallId: "task_fe", status: "completed" });
        chunk("merged");
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        break;
      }
      if (text === "permission") {
        pendingPromptId = msg.id;
        send({
          jsonrpc: "2.0",
          id: PERMISSION_RPC_ID,
          method: "session/request_permission",
          params: {
            sessionId: "sess_fake",
            toolCall: { toolCallId: "call_3", title: "Run npm test" },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          },
        });
        break;
      }
      if (text === "commands") {
        update({
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "compact", description: "Compact the conversation", input: null },
            { name: "review", description: "Review a pull request", input: { hint: "pr number" } },
          ],
        });
        chunk("done");
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        break;
      }
      if (text === "plan") {
        update({
          sessionUpdate: "plan",
          entries: [
            { content: "Read the config", priority: "medium", status: "in_progress" },
            { content: "Write the fix", priority: "medium", status: "pending" },
          ],
        });
        update({
          sessionUpdate: "plan",
          entries: [
            { content: "Read the config", priority: "medium", status: "completed" },
            { content: "Write the fix", priority: "medium", status: "in_progress" },
          ],
        });
        chunk("done");
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        break;
      }
      if (text === "think") {
        update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm, " } });
        update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "let me check" } });
        chunk("done");
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        break;
      }
      if (text === "garbage") {
        process.stdout.write("this is not json\n");
      }
      for (const t of ["Hel", "lo ", "world"]) chunk(t);
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      break;
    }
  }
});
