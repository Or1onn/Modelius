// harness.rs — declarative registry of agentic coding CLIs. Each entry describes how to drive
// one CLI: its argv template, which env vars re-point it at the local gateway, which protocol it
// speaks when re-pointed (gateway inbound side), and which stdout parser decodes its output.
// Adding a harness = one entry here + one entry in the front-end registry (harnesses.ts).
use crate::gateway::Proto;

// Which stdout decoder the CLI's output needs (see agent.rs Parser). Several CLIs share one
// format: Claude Code forks emit ClaudeStreamJson; Qwen Code's stream-json is Claude-compatible.
#[derive(Clone, Copy)]
pub(crate) enum OutputFormat {
    ClaudeStreamJson,
    CodexJsonl,
    PlainText,
}

// How the CLI gets onto the user's machine (installer.rs): a global npm package.
pub(crate) enum Install {
    Npm(&'static str),
}

// Declarative argv: literals + slots, in order. The prompt is always its own argv entry
// (never shell-interpolated — see the BatBadBut note on spawn() in agent.rs).
pub(crate) enum Arg {
    Lit(&'static str),
    Prompt,
    // Emits [flag, model] only when a model id was picked.
    ModelFlag(&'static str),
    // Maps the Orchestro permission-mode id (default/acceptEdits/plan/bypassPermissions)
    // onto this CLI's own flags.
    Permission(fn(&str) -> Vec<String>),
    // Emits the harness's `EnvSpec.route_args` (with {url}/{model} substituted) only on a
    // routed run — used to configure a CLI that can't be re-pointed by env vars alone.
    RouteArgs,
}

// Env vars that re-point the CLI at the gateway. Every name in `base_url`/`api_key` is set (some
// CLIs read different vars depending on the configured provider type); `model_pins` are forced to
// the selected model so background/small-model calls don't 404 on a single-model endpoint;
// `remove` lists real-credential vars that must never leak into a routed run.
pub(crate) struct EnvSpec {
    pub base_url: &'static [&'static str],
    pub base_url_suffix: &'static str, // appended to http://127.0.0.1:{port}
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
    // Home-relative credential files the CLI's own login writes — best-effort "already signed in"
    // detection (installer.rs harness_logged_in). Empty = no native login modeled.
    pub login_marker: &'static [&'static str],
    // Argv that exits 0 only when signed in (keyring-backed logins leave no file to check).
    // Empty = use login_marker.
    pub login_probe: &'static [&'static str],
    // Static env always set on the spawned CLI (headless quirks, e.g. workspace-trust opt-ins).
    pub extra_env: &'static [(&'static str, &'static str)],
    // Home-relative dirs where the vendor installer drops `bin` — checked by resolve_bin so a
    // fresh install works even though this process's PATH snapshot predates it. Empty for npm
    // installs (resolved via the agents prefix / PATH).
    pub bin_hint: &'static [&'static str],
    pub protocol: Proto, // gateway inbound side when the run is routed
    pub output: OutputFormat,
    pub argv: &'static [Arg],
    pub env: EnvSpec,
}

fn claude_permission(mode: &str) -> Vec<String> {
    if mode.is_empty() {
        vec![]
    } else {
        vec!["--permission-mode".into(), mode.into()]
    }
}

// Claude Code permission modes map onto Codex sandbox flags; "plan" runs read-only
// (Codex's default exec sandbox).
fn codex_permission(mode: &str) -> Vec<String> {
    match mode {
        "bypassPermissions" => vec!["--dangerously-bypass-approvals-and-sandbox".into()],
        "plan" => vec![],
        _ => vec!["--sandbox".into(), "workspace-write".into()],
    }
}

fn qwen_permission(mode: &str) -> Vec<String> {
    match mode {
        "plan" => vec!["--approval-mode".into(), "plan".into()],
        "bypassPermissions" => vec!["--yolo".into()],
        // Headless runs can't answer prompts — auto-approve edits for the interactive-ish modes.
        _ => vec!["--approval-mode".into(), "auto-edit".into()],
    }
}

// `kimi --prompt` rejects --yolo/--auto/--plan and already runs with auto permissions.
fn kimi_permission(_mode: &str) -> Vec<String> {
    vec![]
}

static HARNESSES: &[HarnessSpec] = &[
    HarnessSpec {
        id: "claude-code",
        bin: "claude",
        install: Install::Npm("@anthropic-ai/claude-code"),
        login_marker: &[".claude/.credentials.json"],
        login_probe: &[],
        extra_env: &[],
        bin_hint: &[],
        protocol: Proto::Anthropic,
        output: OutputFormat::ClaudeStreamJson,
        argv: &[
            Arg::Lit("-p"),
            Arg::Prompt,
            Arg::Lit("--output-format"),
            Arg::Lit("stream-json"),
            Arg::Lit("--verbose"), // required for stream-json under -p
            Arg::ModelFlag("--model"),
            Arg::Permission(claude_permission),
        ],
        env: EnvSpec {
            base_url: &["ANTHROPIC_BASE_URL"],
            base_url_suffix: "",
            api_key: &["ANTHROPIC_AUTH_TOKEN"],
            // With the base URL overridden, the CLI's background small-model calls would 404 on
            // the gateway — pin every internal model to the selected one.
            model_pins: &["ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"],
            // Don't leak an inherited Anthropic key to a third-party endpoint.
            remove: &["ANTHROPIC_API_KEY"],
            route_args: &[],
        },
    },
    // OpenAI Codex CLI (headless): JSONL events on stdout. Native ChatGPT login by default; a
    // routed run injects a custom `orchestro` model provider (via -c overrides) pointed at the
    // local gateway. Codex only speaks the Responses API (wire_api = "responses"); the gateway's
    // /responses handler translates it to/from chat/completions for the picked bound model.
    HarnessSpec {
        id: "codex",
        bin: "codex",
        install: Install::Npm("@openai/codex"),
        login_marker: &[".codex/auth.json"],
        login_probe: &[],
        extra_env: &[],
        bin_hint: &[],
        protocol: Proto::OpenAi,
        output: OutputFormat::CodexJsonl,
        argv: &[
            Arg::Lit("exec"),
            Arg::Lit("--json"),
            Arg::Lit("--skip-git-repo-check"),
            // `codex exec` suppresses reasoning items by default — surface them so the
            // transcript can render Thinking blocks (ignored by non-reasoning models).
            Arg::Lit("-c"),
            Arg::Lit("hide_agent_reasoning=false"),
            Arg::Lit("-c"),
            Arg::Lit("model_reasoning_summary=detailed"),
            Arg::RouteArgs, // -c provider config on a routed run; nothing on a native run
            Arg::ModelFlag("--model"),
            Arg::Permission(codex_permission),
            Arg::Prompt, // trailing positional — route flags must precede it
        ],
        env: EnvSpec {
            base_url: &[], // provider base is carried in route_args (-c …base_url), not an env var
            base_url_suffix: "",
            api_key: &["ORCHESTRO_GATEWAY_KEY"], // the provider's env_key ← gateway token
            model_pins: &[],
            remove: &["OPENAI_API_KEY"], // don't leak an inherited key into the routed provider
            route_args: &[
                "-c",
                "model_provider=orchestro",
                "-c",
                "model_providers.orchestro.name=Orchestro",
                "-c",
                "model_providers.orchestro.base_url={url}/v1",
                "-c",
                "model_providers.orchestro.wire_api=responses",
                "-c",
                "model_providers.orchestro.env_key=ORCHESTRO_GATEWAY_KEY",
            ],
        },
    },
    // Moonshot Kimi Code CLI. Speaks OpenAI-compatible wire (Moonshot's extended chat/completions);
    // KIMI_* vars re-point its default provider, OPENAI_* cover configs whose default provider is
    // an openai type. Its stream-json schema is undocumented, so headless output stays plain text.
    HarnessSpec {
        id: "kimi",
        bin: "kimi",
        install: Install::Npm("@moonshot-ai/kimi-code"),
        login_marker: &[],
        login_probe: &[],
        extra_env: &[],
        bin_hint: &[],
        protocol: Proto::OpenAi,
        output: OutputFormat::PlainText,
        argv: &[
            Arg::Lit("-p"),
            Arg::Prompt,
            Arg::Lit("--output-format"),
            Arg::Lit("text"),
            Arg::Permission(kimi_permission),
        ],
        env: EnvSpec {
            base_url: &["KIMI_BASE_URL", "OPENAI_BASE_URL"],
            base_url_suffix: "",
            api_key: &["KIMI_API_KEY", "OPENAI_API_KEY"],
            model_pins: &["KIMI_MODEL_NAME"],
            remove: &[],
            route_args: &[],
        },
    },
    // Qwen Code (Gemini CLI fork): OpenAI-compatible via OPENAI_* env; its stream-json events are
    // Claude Code-shaped (type: system/assistant/result), so the Claude parser decodes them.
    HarnessSpec {
        id: "qwen-code",
        bin: "qwen",
        install: Install::Npm("@qwen-code/qwen-code"),
        login_marker: &[],
        login_probe: &[],
        extra_env: &[],
        bin_hint: &[],
        protocol: Proto::OpenAi,
        output: OutputFormat::ClaudeStreamJson,
        argv: &[
            Arg::Lit("-p"),
            Arg::Prompt,
            Arg::Lit("--output-format"),
            Arg::Lit("stream-json"),
            Arg::ModelFlag("--model"),
            Arg::Permission(qwen_permission),
        ],
        env: EnvSpec {
            base_url: &["OPENAI_BASE_URL"],
            base_url_suffix: "",
            api_key: &["OPENAI_API_KEY"],
            model_pins: &["OPENAI_MODEL"],
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
