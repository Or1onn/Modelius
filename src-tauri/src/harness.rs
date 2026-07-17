// harness.rs — declarative registry of agentic coding CLIs. Each entry describes how to drive
// one CLI: its argv template, which env vars re-point it at the local gateway, which protocol it
// speaks when re-pointed (gateway inbound side), and which stdout parser decodes its output.
// Adding a harness = one entry here + one entry in the front-end registry (harnesses.ts).
use crate::gateway::Proto;

// How the CLI gets onto the user's machine (installer.rs): a global npm package.
pub(crate) enum Install {
    Npm(&'static str),
}

// Official native-binary distribution (a standalone executable — no Node/npm involved).
// Layout: {base}/{version}/manifest.json lists per-platform {binary, checksum(sha256), size};
// the executable lives at {base}/{version}/{platform-dir}/{binary}. Preferred over the npm
// install when present: faster to spawn (no node shim) and immune to a broken system Node.
pub(crate) struct NativeDist {
    pub base: &'static str,
    pub version: &'static str,
}

// Declarative argv: literals + slots, in order. Both harnesses now take the prompt over their
// stdio protocol (PromptChannel), never argv.
pub(crate) enum Arg {
    Lit(&'static str),
    // Emits [flag, model] only when a model id was picked.
    ModelFlag(&'static str),
    // Emits [flag, level] only when an effort level was picked (reasoning depth).
    EffortFlag(&'static str),
    // Maps the Modelius permission-mode id (default/acceptEdits/plan/bypassPermissions)
    // onto this CLI's own flags.
    Permission(fn(&str) -> Vec<String>),
    // Emits the harness's `EnvSpec.route_args` (with {url}/{model} substituted) only on a
    // routed run — used to configure a CLI that can't be re-pointed by env vars alone.
    RouteArgs,
    // Emits the harness's `resume_args` (with {id} substituted) only when a prior session id
    // was captured — continues that CLI session instead of starting a fresh one.
    Resume,
}

// How a harness receives prompts. All channels hold a live stdio protocol, so every harness
// runs WARM (one process per chat, follow-up turns without respawn — session.rs):
// - ClaudeStream: stream-json user messages on stdin; permissions/interrupt/mode-switch ride the
//   `control_request` stdio protocol (probe-verified claude 2.1.206).
// - CodexRpc: `codex app-server` JSON-RPC over JSONL; Rust writes the lifecycle requests
//   (codex_proto.rs), approvals arrive as server requests answered via agent_respond
//   (probe-verified codex-cli 0.142.5).
// - KimiAcp: `kimi acp` — Agent Client Protocol, strict JSON-RPC 2.0 over JSONL; lifecycle lines
//   in kimi_proto.rs, session/request_permission server requests answered via agent_respond
//   (probe-verified @moonshot-ai/kimi-code 0.25.0).
#[derive(PartialEq)]
pub(crate) enum PromptChannel {
    ClaudeStream,
    CodexRpc,
    KimiAcp,
}

// Env vars that re-point the CLI at the gateway. Every name in `base_url`/`api_key` is set (some
// CLIs read different vars depending on the configured provider type); `model_pins` are forced to
// the selected model so background/small-model calls don't 404 on a single-model endpoint;
// `remove` lists real-credential vars that must never leak into a routed run.
pub(crate) struct EnvSpec {
    pub base_url: &'static [&'static str],
    pub api_key: &'static [&'static str],
    pub model_pins: &'static [&'static str],
    pub remove: &'static [&'static str],
    // Extra CLI args emitted by Arg::RouteArgs on a routed run (see agent.rs build_argv).
    // {url} → the gateway origin (http://127.0.0.1:{port}), {model} → the picked model id.
    // The gateway token is never substituted here — it stays env-only (api_key), out of argv.
    pub route_args: &'static [&'static str],
}

pub(crate) struct HarnessSpec {
    pub id: &'static str,
    pub bin: &'static str,
    pub install: Install,
    // Native-binary dist tried before the npm install when set (installer.rs install_native);
    // version-pinned so a release regression can't silently land on users.
    pub native_dist: Option<NativeDist>,
    // Home-relative credential files the CLI's own login writes — best-effort "already signed in"
    // detection (installer.rs harness_logged_in). Empty = no native login modeled.
    pub login_marker: &'static [&'static str],
    pub protocol: Proto, // gateway inbound side when the run is routed
    // How the prompt reaches the CLI (and whether it can run warm — see PromptChannel).
    pub channel: PromptChannel,
    pub argv: &'static [Arg],
    // Args emitted by Arg::Resume when continuing a prior session; {id} → the session id the
    // CLI reported on the previous run (Claude: stream-json init; Codex: thread.started).
    pub resume_args: &'static [&'static str],
    pub env: EnvSpec,
}

fn claude_permission(mode: &str) -> Vec<String> {
    if mode.is_empty() {
        vec![]
    } else {
        vec!["--permission-mode".into(), mode.into()]
    }
}

static HARNESSES: &[HarnessSpec] = &[
    HarnessSpec {
        id: "claude-code",
        bin: "claude",
        install: Install::Npm("@anthropic-ai/claude-code"),
        // Same GCS origin the official install script uses. 2.1.206 = the version the warm-session
        // stdio protocol (multi-turn stdin / can_use_tool / interrupt / set_permission_mode) was
        // probe-verified against.
        native_dist: Some(NativeDist {
            base: "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases",
            version: "2.1.206",
        }),
        login_marker: &[".claude/.credentials.json"],
        protocol: Proto::Anthropic,
        channel: PromptChannel::ClaudeStream,
        argv: &[
            Arg::Lit("-p"),
            Arg::Lit("--output-format"),
            Arg::Lit("stream-json"),
            Arg::Lit("--verbose"), // required for stream-json under -p
            // Token-level streaming: emits `stream_event` deltas (text + tool-input) the TS
            // transform turns into AI SDK chunks (features/run-agent/lib/transform.ts).
            Arg::Lit("--include-partial-messages"),
            // The prompt goes over stdin (stdin_prompt) so the run can hold a live control
            // channel: permission prompts surface as can_use_tool control_requests instead of
            // being silently auto-denied (the headless default).
            Arg::Lit("--input-format"),
            Arg::Lit("stream-json"),
            Arg::Lit("--permission-prompt-tool"),
            Arg::Lit("stdio"),
            Arg::Resume,
            Arg::ModelFlag("--model"),
            // Reasoning depth (low/medium/high/xhigh/max) — emitted only when the webview
            // resolved a concrete level for the picked model (codeChatRegistry resolvedEffort).
            Arg::EffortFlag("--effort"),
            Arg::Permission(claude_permission),
        ],
        resume_args: &["--resume", "{id}"],
        env: EnvSpec {
            base_url: &["ANTHROPIC_BASE_URL"],
            api_key: &["ANTHROPIC_AUTH_TOKEN"],
            // With the base URL overridden, the CLI's background small-model calls would 404 on
            // the gateway — pin every internal model to the selected one.
            model_pins: &["ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"],
            // Don't leak an inherited Anthropic key to a third-party endpoint.
            remove: &["ANTHROPIC_API_KEY"],
            route_args: &[],
        },
    },
    // OpenAI Codex CLI via `codex app-server` (JSON-RPC over JSONL, probe-verified 0.142.5):
    // one warm process per chat, lifecycle requests built in codex_proto.rs (thread/start,
    // turn/start with per-turn model/effort/permission overrides, turn/interrupt), approvals as
    // server requests answered via agent_respond. Native ChatGPT login by default; a routed run
    // injects a custom `modelius` model provider (via -c overrides) pointed at the local gateway.
    // Codex only speaks the Responses API (wire_api = "responses", plain HTTP for custom
    // providers); the gateway's /responses handler translates to/from chat/completions.
    HarnessSpec {
        id: "codex",
        bin: "codex",
        install: Install::Npm("@openai/codex"),
        native_dist: None,
        login_marker: &[".codex/auth.json"],
        protocol: Proto::OpenAi,
        channel: PromptChannel::CodexRpc,
        argv: &[
            Arg::Lit("app-server"),
            // Keep detailed reasoning summaries (same knob the exec path used) — the transform
            // renders them as streaming thinking. Process-level -c is accepted by app-server.
            Arg::Lit("-c"),
            Arg::Lit("model_reasoning_summary=detailed"),
            Arg::RouteArgs, // -c provider config on a routed run; nothing on a native run
        ],
        // Resume is a JSON-RPC method (thread/resume), not argv.
        resume_args: &[],
        env: EnvSpec {
            base_url: &[], // provider base is carried in route_args (-c …base_url), not an env var
            api_key: &["MODELIUS_GATEWAY_KEY"], // the provider's env_key ← gateway token
            model_pins: &[],
            remove: &["OPENAI_API_KEY"], // don't leak an inherited key into the routed provider
            route_args: &[
                "-c",
                "model_provider=modelius",
                "-c",
                "model_providers.modelius.name=Modelius",
                "-c",
                "model_providers.modelius.base_url={url}/v1",
                "-c",
                "model_providers.modelius.wire_api=responses",
                "-c",
                "model_providers.modelius.env_key=MODELIUS_GATEWAY_KEY",
            ],
        },
    },
    // Moonshot Kimi Code CLI via `kimi acp` (Agent Client Protocol, JSON-RPC 2.0 over JSONL,
    // probe-verified 0.25.0): one warm process per chat, lifecycle lines in kimi_proto.rs.
    // Native Kimi-account login only (v1, front-end routable:false): `kimi login` device-code
    // flow run in the app's built-in terminal. No spawn-time knobs work under `acp` (probe P8) —
    // model and permission mode are set in-session (session/set_model, session/set_mode), so the
    // argv is just the subcommand.
    HarnessSpec {
        id: "kimi-code",
        bin: "kimi",
        install: Install::Npm("@moonshot-ai/kimi-code"),
        native_dist: None,
        login_marker: &[".kimi-code/credentials/kimi-code.json"],
        protocol: Proto::OpenAi, // unused while routable:false (Moonshot's API is OpenAI-compatible)
        channel: PromptChannel::KimiAcp,
        argv: &[Arg::Lit("acp")],
        // Resume is a JSON-RPC method (session/resume), not argv.
        resume_args: &[],
        env: EnvSpec {
            base_url: &[],
            api_key: &[],
            model_pins: &[],
            remove: &[],
            route_args: &[],
        },
    },
];

pub(crate) fn spec(id: &str) -> Option<&'static HarnessSpec> {
    HARNESSES.iter().find(|h| h.id == id)
}

pub(crate) fn all() -> &'static [HarnessSpec] {
    HARNESSES
}

#[cfg(test)]
mod tests {
    // spec/all read the private HARNESSES static, so they're tested inline (no pub cascade over
    // the HarnessSpec type graph), as is the permission mapping.
    use super::*;

    #[test]
    fn spec_finds_known_harnesses_and_rejects_unknown() {
        assert_eq!(spec("claude-code").unwrap().bin, "claude");
        assert_eq!(spec("codex").unwrap().bin, "codex");
        assert_eq!(spec("kimi-code").unwrap().bin, "kimi");
        assert!(spec("nope").is_none());
    }

    #[test]
    fn all_lists_every_harness_with_a_nonempty_argv() {
        assert_eq!(all().len(), 3);
        assert!(all().iter().all(|h| !h.id.is_empty() && !h.argv.is_empty()));
    }

    #[test]
    fn harness_channels_match_their_protocols() {
        assert!(spec("claude-code").unwrap().channel == PromptChannel::ClaudeStream);
        assert!(spec("codex").unwrap().channel == PromptChannel::CodexRpc);
        assert!(spec("kimi-code").unwrap().channel == PromptChannel::KimiAcp);
    }

    #[test]
    fn kimi_login_marker_points_at_the_oauth_token_file() {
        // 0.25.0 stores the device-flow token at ~/.kimi-code/credentials/kimi-code.json
        // (FileTokenStorage, name "kimi-code") — installer::harness_logged_in checks this path.
        assert_eq!(spec("kimi-code").unwrap().login_marker, &[".kimi-code/credentials/kimi-code.json"]);
    }

    #[test]
    fn claude_permission_passes_the_mode_through() {
        assert_eq!(claude_permission(""), Vec::<String>::new());
        assert_eq!(claude_permission("plan"), vec!["--permission-mode", "plan"]);
        assert_eq!(claude_permission("acceptEdits"), vec!["--permission-mode", "acceptEdits"]);
    }
}
