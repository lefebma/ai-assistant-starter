# Live duplex voice on a Havn box: spike result

Card #189, under Feature #188. Written 2026-10-05.

## Finding: the port already happened

Feature #188 describes Havn's voice as turn-based (record, transcribe, reply,
speak). That is the classic `/voice` page. **`/voice/live` shipped in 1.26.0
(2026-09-13)** as a straight port of Umi Live, and 1.26.2 added call memory.
So the spike's question changed from "what would it take" to "what is missing
against the stories", and the answer is a set of gaps, not an architecture.

## Architecture (as built)

```
browser mic/speaker <-> WebRTC <-> OpenAI GPT-Live-1
                                      ^ sideband WebSocket (src/voice-live.ts)
                                      | session.delegation.created
                                      v
                                  runAgent: the assistant, with skills and memory
```

- **Provider: OpenAI GPT-Live-1.** It owns the audio, barge-in and small talk.
  Claude stays the brain: GPT-Live hands work over by "client delegation", and
  the box runs the turn and returns the result to be spoken. GPT-Realtime-2 was
  rejected in May because it replaces Claude as the brain. ElevenLabs was
  retired on Umi because its custom-LLM path times out at 15 seconds, and real
  lookups take 19 to 34.
- **Cost:** about $0.05 per minute of audio (roughly $3 an hour), billed per
  second to the box's `OPENAI_API_KEY`, plus the normal cost of the Claude
  turns. Two calls at once at most, 45 minutes each.
- **Delegation:** delegation events carry no task text, so the box keeps its own
  transcript and builds each backend prompt from it. A newer request aborts the
  one still running, and a superseded result is dropped, because one handed
  over late still gets read aloud.
- **Edge:** WebRTC audio goes from the phone straight to OpenAI. The box only
  needs HTTPS (for the microphone) and the exact API paths proxied by Caddy. The
  sideband is an outbound WebSocket from the box, so nothing needs to be opened
  inbound. Node 22 is required (global WebSocket). Hosted boxes have it; the
  installer bundles ship Node 20 and so do not.
- **Auth:** the `/voice ui` link is traded for an HttpOnly cookie that carries
  the chat id, and the link is removed from the address bar. Nothing on the
  page holds a credential.

## Gap analysis against the stories

| Story | Acceptance | Before this work | Now |
|---|---|---|---|
| #190 session endpoint | No session without a per-chat credential | Met: cookie or link (per chat) or the operator bearer (maps to the primary chat) | Unchanged |
| #190 | Ends cleanly on disconnect | **Gap:** a closed tab or a lost phone kept billing until the 45-minute cap | The page signals `/api/live/end` on leave and on connection loss. The box closes a call after 5 idle minutes. Only the owning chat can end a call |
| #191 delegation | Spoken answers under a set length | Prompt asked for under 120 words; nothing enforced it | Enforced at 120 words, cut at a sentence. The overflow and any `FOR CHAT:` details go to the chat, and the voice says so |
| #191 | Long work acknowledged, then delivered | Acknowledged ("checking"), but an answer that landed after hang-up was lost | Delivered to the chat as "From your call: ..." |
| #191 | Nothing external without spoken confirmation of the exact content | Prompt rule | Rule tightened: read back the exact text, act only on a later yes. **Still a prompt rule**, not enforced by code. Hard enforcement belongs with role-scoped tools (#195) |
| #192 client UI | iOS Safari and desktop Chrome, barge-in, visible call state | Built in 1.26.0 and rehearsed on havn-test | Adds a running call timer. **Needs a device pass** on both browsers |
| #193 history | Calls list with date and length, transcripts open | **Gap:** transcripts were saved to disk, with no way to see them | Calls button on the live page: list, transcript, delete. Scoped per chat |
| #193 | Retention follows the box privacy settings | **Gap:** there was no setting | `VOICE_TRANSCRIPT_DAYS`; 0 keeps everything |

## Not done, and why

- **Device testing (#192).** It needs a person with a phone.
- **Code-enforced confirmation before sends (#191).** This needs the tool
  layer from #195 so a voice-originated turn cannot reach a send tool without
  a confirmation token. A prompt rule is what Umi runs today.
- **AI-written call titles.** Umi titles each call with Haiku. Havn uses the
  first thing you said, which is free and good enough for a list. Worth adding
  only if the list gets long.
- **Installer bundles on Node 20.** This is unchanged. It is a packaging
  decision, not voice work.
