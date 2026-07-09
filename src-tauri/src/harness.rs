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

// Claude Code permission modes map onto Codex sandbox settings; "plan" runs read-only
// (Codex's default exec sandbox). The sandbox is set via `-c sandbox_mode=…`, not `--sandbox`:
// the `exec resume` subcommand accepts `-c` but not `--sandbox`, and both spellings are
// equivalent for a fresh `exec`.
fn codex_permission(mode: &str) -> Vec<String> {
    match mode {
        "bypassPermissions" => vec!["--dangerously-bypass-approvals-and-sandbox".into()],
        "plan" => vec![],
        _ => vec!["-c".into(), "sandbox_mode=\"workspace-write\"".into()],
    }
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
            Arg::Resume,
            Arg::ModelFlag("--model"),
            Arg::Permission(claude_permission),
        ],
        resume_args: &["--resume", "{id}"],
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
    // routed run injects a custom `modelius` model provider (via -c overrides) pointed at the
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
            Arg::Resume, // `resume <id>` is a subcommand — must directly follow `exec`
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
        resume_args: &["resume", "{id}"],
        env: EnvSpec {
            base_url: &[], // provider base is carried in route_args (-c …base_url), not an env var
            base_url_suffix: "",
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
        assert!(spec("nope").is_none());
    }

    #[test]
    fn all_lists_every_harness_with_a_nonempty_argv() {
        assert_eq!(all().len(), 2);
        assert!(all().iter().all(|h| !h.id.is_empty() && !h.argv.is_empty()));
    }

    #[test]
    fn claude_permission_passes_the_mode_through() {
        assert_eq!(claude_permission(""), Vec::<String>::new());
        assert_eq!(claude_permission("plan"), vec!["--permission-mode", "plan"]);
        assert_eq!(claude_permission("acceptEdits"), vec!["--permission-mode", "acceptEdits"]);
    }

    #[test]
    fn codex_permission_maps_onto_sandbox_flags() {
        assert_eq!(codex_permission("bypassPermissions"), vec!["--dangerously-bypass-approvals-and-sandbox"]);
        assert_eq!(codex_permission("plan"), Vec::<String>::new()); // read-only default
        // -c form, not --sandbox: `exec resume` rejects --sandbox (see codex_permission).
        assert_eq!(codex_permission("default"), vec!["-c", "sandbox_mode=\"workspace-write\""]);
        assert_eq!(codex_permission("acceptEdits"), vec!["-c", "sandbox_mode=\"workspace-write\""]);
    }
}
