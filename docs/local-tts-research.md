# Local TTS Research — Replacing ElevenLabs

*2026-07-20 · Context: Nexus speaks short single-line notification phrases. Real synth path is `apps/swift/NexusShared/Synthesis/ElevenLabsClient.swift` (batch MP3 → `AVAudioPlayer`); the agent-side pre-render in `apps/agent/src/notifications/channels/tts.ts` is best-effort and unused by playback. Fallback is `/usr/bin/say`. Requirements: low time-to-first-audio on short text, per-project voice mapping, MP3 (or WAV) `Data` out, runs on Mac and/or homelab over Tailscale.*

## Candidates

| Engine | License | Size | Voices / cloning | Latency (short phrase) | Hardware | Fit |
| ------ | ------- | ---- | ---------------- | ---------------------- | -------- | --- |
| **Kokoro-82M** | Apache 2.0 | 82M | 54 preset voices + weighted mixing; **no cloning** | ~180–300 ms via MLX/CoreML on M-series; 5x realtime on M3 Pro CPU | CPU-friendly; MLX, CoreML, ONNX ports | **Best overall fit** |
| **Chatterbox / Turbo** (Resemble) | MIT | 0.5B / 350M | Zero-shot cloning from ~5 s audio, emotion control; beat ElevenLabs 65% in blind test | <150 ms first sound on GPU | ~8 GB VRAM GPU — homelab, not on-device Mac | Best quality, needs GPU |
| **Qwen3-TTS** (Jan 2026) | Apache 2.0 | 0.6B / 1.7B | 3 s cloning, voice design via natural language, 10 langs | ~97 ms streaming on GPU | GPU realistically | Strong newcomer, GPU-bound |
| **Kyutai Pocket TTS** (Jan 2026) | permissive | 100M | Preset voices | Real-time on CPU | CPU | Worth watching; young ecosystem |
| **Piper** | MIT | tiny | 30+ langs, preset voices | Real-time on any CPU / RPi | Trivial | Quality below `say`+Siri voices; skip for Mac, ok for Linux agent |
| **XTTS v2, F5-TTS, Fish Speech** | CPML / CC-BY-NC | — | Cloning | — | GPU | Non-commercial licenses — skip |
| **macOS `say` / AVSpeechSynthesizer** | built-in | — | Siri/premium voices (Settings download) | instant | zero | Already the fallback; keep |

## Two integration paths

**A. Self-hosted server on homelab (recommended first step).**
[Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) exposes an OpenAI-compatible `/v1/audio/speech` endpoint, streams MP3/WAV/PCM, and runs in Docker on CPU (`ghcr.io/remsky/kokoro-fastapi-cpu`). Put it next to `homelab-postgres`, reach it over Tailscale like everything else. `ElevenLabsClient.swift` becomes a ~20-line change: new URL + JSON body, same MP3 `Data` return, so `AudioPlayer`/ducking/fallback logic is untouched. Voice IDs map 1:1 — `projectVoiceCache` values become Kokoro voice names (`af_heart`, `am_michael`, mixes like `af_heart+af_sky`). The agent's `tts.ts` and the `elevenlabs-*` credential/voice routes can point at the same endpoint or be deleted (no key management needed at all). If quality later matters more, swap the container for [Chatterbox-TTS-Server](https://github.com/devnen/Chatterbox-TTS-Server) — same OpenAI-compatible API, needs a GPU.

**B. On-device Swift synthesis (offline, no server).**
Kokoro runs natively on Apple Silicon via [mlx-audio](https://github.com/Blaizzy/mlx-audio), a [Swift iOS/macOS port](https://github.com/mlalma/kokoro-ios) (~3.3x realtime on iPhone 13 Pro), or a [CoreML conversion](https://huggingface.co/mattmireles/kokoro-coreml). Output is WAV/PCM — `AVAudioPlayer(data:)` plays WAV fine, so `MP3PlayerProtocol` needs at most a rename. Heavier lift (model bundling, warm-up) but kills the network dependency entirely and would work for iOS/watchOS later.

## Recommendation

Start with **Kokoro via Kokoro-FastAPI on the homelab** (path A): Apache 2.0, CPU-only, MP3 out, sub-second on short phrases, 54 voices covers per-project mapping, and it deletes the entire ElevenLabs credential surface. Keep `say` as the offline fallback. If preset voices feel too generic, trial **Chatterbox Turbo** on a GPU box behind the same OpenAI-compatible API — it's the only permissive-license option that credibly beats ElevenLabs on quality. Revisit **Qwen3-TTS** and **Kyutai Pocket** in a quarter; both are young but moving fast.

## Sources

- [Best Local TTS Models 2026 (Local AI Master)](https://localaimaster.com/blog/best-local-tts-models) · [Kokoro vs XTTS vs Chatterbox](https://localaimaster.com/blog/kokoro-vs-xtts-vs-chatterbox)
- [Best Open-Source TTS 2026 — licenses compared (OCDevel)](https://ocdevel.com/blog/20250720-tts) · [FindSkill blind-test numbers](https://findskill.ai/blog/best-open-source-tts-2026/)
- [Chatterbox (resemble-ai)](https://github.com/resemble-ai/chatterbox) · [Chatterbox-TTS-Server](https://github.com/devnen/Chatterbox-TTS-Server) · [Turbo latency/VRAM](https://codersera.com/blog/chatterbox-turbo-run-and-install-locally-free-elevenlabs-alternative-2026/)
- [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) · [mlx-audio](https://github.com/Blaizzy/mlx-audio) · [kokoro-ios](https://github.com/mlalma/kokoro-ios) · [kokoro-coreml](https://huggingface.co/mattmireles/kokoro-coreml) · [MetalRT Apple Silicon benchmarks](https://www.runanywhere.ai/blog/metalrt-speech-fastest-stt-tts-apple-silicon)
- [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) · [Kyutai TTS](https://kyutai.org/tts/)
