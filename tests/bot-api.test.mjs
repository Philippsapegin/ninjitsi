import assert from "node:assert/strict";
import test from "node:test";
import { createBotApi } from "../server/bot-api.mjs";

function fixture() {
  let time = Date.now();
  const room = { code: "test-room", expiresAt: new Date(time + 86_400_000).toISOString() };
  const token = "a-unique-bot-secret-with-at-least-32-characters";
  const api = createBotApi({ configuration: JSON.stringify([{ id: "dice", name: "Dice", token, rooms: [room.code] }]),
    getRoom: code => code === room.code ? room : undefined, now: () => time,
    readJsonBody: async request => request.body,
    json: (response, status, body) => Object.assign(response, { status, body }),
  });
  const admission = api.issueAdmission(room, "Alice");
  async function request(method, resource, bearer = token, body) {
    const response = { setHeader() {} };
    const handled = await api.handle({ method, headers: { authorization: `Bearer ${bearer}` }, body }, response,
      new URL(`http://localhost/api/v1/rooms/${room.code}/${resource}`));
    assert(handled);
    return response;
  }
  return { api, room, token, admission, request, advance: ms => { time += ms; } };
}

test("bot API enforces admission, room allowlist and role scopes", async () => {
  const f = fixture();
  assert.equal((await f.request("GET", "events", "wrong")).status, 401);
  assert.equal((await f.request("GET", "events", `${f.admission}x`)).status, 401);
  assert.equal((await f.request("POST", "messages", f.admission, { id: "one", text: "forged bot" })).status, 403);
  assert.equal((await f.request("POST", "events", f.token, { id: "one", text: "forged human" })).status, 403);
  const reply = {};
  await f.api.handle({ method: "GET", headers: { authorization: `Bearer ${f.token}` } }, reply,
    new URL("http://localhost/api/v1/rooms/other-room/events"));
  assert.equal(reply.status, 401);
  assert.equal(f.api.issueAdmission({ ...f.room, code: "other-room" }, "Alice"), null);
  f.advance(12 * 60 * 60_000 + 1);
  assert.equal((await f.request("GET", "events", f.admission)).status, 401);
});

test("public command reaches bot; bot reply reaches participants exactly once", async () => {
  const f = fixture();
  const message = { id: "command-1", text: "/roll 2d20+3" };
  const first = await f.request("POST", "events", f.admission, message);
  const retry = await f.request("POST", "events", f.admission, message);
  assert.equal(first.body.event.id, retry.body.event.id);
  const botRead = await f.request("GET", "events");
  assert.equal(botRead.body.events.length, 1);
  assert.equal(botRead.body.events[0].text, message.text);
  assert.equal(botRead.body.events[0].senderName, "Alice");
  const answer = await f.request("POST", "messages", f.token, { id: "roll-1", text: "2d20+3: [12, 4] + 3 = 19" });
  assert.equal(answer.status, 201);
  const humanRead = await f.request("GET", "events", f.admission);
  assert.equal(humanRead.body.events.length, 1);
  assert.equal(humanRead.body.events[0].isBot, true);
  assert.equal(humanRead.body.events[0].senderName, "Dice");
  const cursor = humanRead.body.cursor;
  const epoch = humanRead.body.epoch;
  assert.equal((await f.request("GET", `events?after=${cursor}&epoch=${epoch}`)).body.events.length, 0);
  assert.equal((await f.request("GET", `events?after=${cursor}&epoch=old`)).body.truncated, true);
});

test("bot API rejects malformed payloads, private recipients and unbounded input", async () => {
  const f = fixture();
  for (const body of [null, {}, { id: "x", text: "" }, { id: "x", text: "a".repeat(4001) },
    { id: "x", text: "secret", recipientIds: ["bob"] }, { id: "bad/id", text: "hello" }]) {
    assert.equal((await f.request("POST", "events", f.admission, body)).status, 400);
  }
  assert.equal((await f.request("GET", "events?after=NaN")).status, 400);
  for (let n = 0; n < 30; n++) await f.request("POST", "messages", f.token, { id: `roll-${n}`, text: "4" });
  assert.equal((await f.request("POST", "messages", f.token, { id: "excess", text: "4" })).status, 429);
});

test("bot API expires retained events and rejects expired rooms", async () => {
  const f = fixture();
  await f.request("POST", "messages", f.token, { id: "roll-1", text: "4" });
  f.advance(30 * 60_000 + 1);
  assert.equal((await f.request("GET", "events")).body.events.length, 0);
  f.advance(86_400_000);
  assert.equal((await f.request("GET", "events")).status, 404);
});

test("bot API fails closed on unsafe bot configuration", () => {
  for (const configuration of ['{}', '[{}]', '[{"id":"x","name":"X","token":"short","rooms":["test-room"]}]']) {
    assert.throws(() => createBotApi({ configuration }));
  }
});
