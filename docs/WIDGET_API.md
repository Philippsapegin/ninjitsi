# External room widgets, v1

Widgets are independent services and browser applications. Ninjitsi supplies a
generic window host and an authenticated room proxy. It contains no game rules,
rendering engine, dice geometry, or widget-specific command names.

Register providers in `NINJITSI_WIDGETS` (JSON array, at most eight):

```json
[{"id":"dice","title":"Dice","commands":["dice"],"url":"https://widgets.example.com/widget","serviceUrl":"http://dice-service:3210","token":"<unique server-to-server token of at least 32 characters>"}]
```

`url` is public browser content. Serve it from a dedicated origin distinct from
Ninjitsi, with CSP `frame-ancestors` restricted to the exact Ninjitsi origin.
`serviceUrl` is an administrator-configured internal HTTP(S) base URL. Its API
must require the service token. Neither the token nor internal URL is exposed
to participants. There are no arbitrary user-supplied upstream URLs or redirects.
Registration makes the widget available in admitted rooms, including newly
created rooms. No per-room server reconfiguration is needed to activate one.

Optional `commandActions` maps additional public slash-command names (without
`/`) to provider actions, for example `{"dice_help":"help","dice_exit":"exit"}`.
These call `/actions/{action}` with an empty application payload and the signed
actor identity. They do not implicitly activate the widget. Command names must
be unique across activation commands and action mappings of all providers.
An inactive provider may still return help/acknowledgement messages; these reach
the room chat without opening a window. Returning `active:false` closes the
shared widget on every client.

Admission through `/api/rooms/{code}/join` adds `widgetToken` when providers are
registered. This signed room capability is separate from chat-bot tokens. It
expires within twelve hours, grants no media access, and stays in the parent
page. A widget iframe never receives it.

## Provider HTTP contract

Ninjitsi calls these routes with `Authorization: Bearer <service token>`:

- `POST /v1/rooms/{code}/activate`: `{requestId, actor:{id,name}}`.
- `GET /v1/rooms/{code}/state?after={version}`.
- `POST /v1/rooms/{code}/actions/{action}`: action payload plus authoritative
  `requestId` and `actor`. Participant-supplied actor fields are overwritten.

State replies:

```json
{"active":true,"version":3,"activation":"activation-id","serverNow":1794200000000,"state":{"application":"defined by provider"},"messages":[{"id":"message-id","text":"Public result","timestamp":1794200000000}]}
```

For an inactive room return `{active:false,version:0,messages:[],serverNow:...}`
without allocating a persistent session. For an unchanged version return
`state:null`; Ninjitsi retains the previous state. Include current `serverNow`
and retained completed messages even in unchanged replies. Increase `version`
when state changes. Change `activation` after a fresh command so a locally closed
window can reopen; retries with the same `requestId` must be idempotent.

Ninjitsi polls once per second by default. A provider may return `pollAfterMs`
(100–1000 milliseconds) to stream an active animation, then return to 1000 when
idle. Responses are limited to 512 KB, requests have a
five-second upstream timeout, redirects are rejected. Providers should retain
bounded state, validate actions, deduplicate requests, and enforce application
limits. Return `400`, `409`, or `429` with a short textual `error` for user-facing
failures. A provider failure does not end the meeting.

Only a local outgoing **public** command matching a registered command activates
a widget; private messages and attachments never activate it. Example command
for the above registration: `/dice`. Each client independently observes shared
provider state, so every participant sees the activation. Completed messages
appear under the configured widget title; HTML is never interpreted. Up to 500
observed widget messages remain in each page's meeting chat.

## Iframe contract

Ninjitsi creates two sandboxed frames from `url`:

- `view=controls`: the small interactive window;
- `view=stage`: a transparent fullscreen animation overlay with pointer input
  disabled, so meeting controls and chat remain usable.

Query parameters also include `room`, `parentOrigin`, and a random `channel`.
Both frames use `sandbox="allow-scripts allow-same-origin"`; no camera,
microphone, popups, or top-level navigation permissions are granted. Use a
separate provider origin. Serve application code/assets from the provider,
not from Ninjitsi.

Host frames use `color-scheme: normal`. Transparent provider documents should
use the same value on their root element; mismatched color schemes can force an
opaque iframe canvas even when CSS backgrounds are transparent.

Frames announce readiness with `postMessage` to `parentOrigin`:

```json
{"type":"ninjitsi.widget.ready.v1","channel":"..."}
```

Parent state messages:

```json
{"type":"ninjitsi.widget.state.v1","channel":"...","state":{},"serverNow":1794200000000,"roundTripMs":120,"viewport":{"left":0,"top":0,"width":1100,"height":900}}
```

Only the controls frame may request an action:

```json
{"type":"ninjitsi.widget.request.v1","channel":"...","id":"request-id","action":"application-action","payload":{"requestId":"idempotency-key"}}
```

Replies use `ninjitsi.widget.response.v1`, the same `channel` and `id`, and either
`result` or `error`. Verify `event.source === parent`, the exact `event.origin`,
and channel before accepting state or replies. Ninjitsi verifies the provider
origin, source frame, channel and action name; the stage cannot perform actions.

A successful HTTP action reply may also contain `state`, `version`, `active`,
`activation`, and `serverNow`, following the state-reply contract. Ninjitsi
publishes that state to both frames immediately. This lets an interaction start
an animation without waiting for the next poll. A delayed poll with an older
version cannot replace a newer action result within the same activation.

Clock synchronization is approximate: providers should publish an authoritative
timeline, schedule it slightly ahead, and let late clients catch up. The host
does not independently simulate or select application results.

`viewport` gives the presentation area in CSS pixels relative to the stage.
On desktop it ends at the open chat's left edge; with chat collapsed and on
mobile it spans the full viewport. The host also sends
`ninjitsi.widget.viewport.v1` with the same `channel` and `viewport` when chat or
window size changes. The animation stage itself remains fullscreen.

Actions include `actor.avatarUrl`, a bounded raster data URL derived from the
participant's local avatar, or an empty string. This is optional presentation
data, not identity. The server always supplies the admitted `actor.id` and
`actor.name`; provider content cannot override them or choose an external avatar
URL. Providers that do not display avatars may ignore this field.

## Compact controls and dragging

The controls frame can opt out of the host's title bar and report its own size:

```json
{"type":"ninjitsi.widget.layout.v1","channel":"...","width":156,"height":44,"frameless":true}
```

Only the verified controls frame can change its layout; dimensions are bounded
by the viewport and a 640×480 maximum. Without this message the ordinary window
chrome remains. Use ResizeObserver to report content changes; do not infer the
host's position from the iframe's own client coordinates.

To drag from a provider's non-interactive background, capture the pointer there
and send `ninjitsi.widget.drag.v1` with `phase: "start"`, then `"move"`, then
`"end"`. Start/move carry `x` and `y` from `PointerEvent.screenX/screenY` in CSS
pixels. The host moves the local panel and clamps it to the viewport. Do not
start drags from buttons, input fields or other interactive controls. These
messages are local to the browser and never broadcast to the room.

`ninjitsi.widget.close.v1` with the channel closes the controls and stage locally.
This can be bound to Escape for a frameless widget. A new activation reopens it.
The animation stage cannot send layout, drag, close or application actions.
