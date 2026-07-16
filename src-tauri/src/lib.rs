// lib.rs — Tauri app entrypoint: wires plugins, the SQLite migration, and the
// command handlers. The commands themselves live in the domain modules below.
mod agent;
mod anthropic;
mod artifacts;
mod codex_proto;
mod compat;
mod gateway;
mod git;
mod harness;
mod installer;
mod kimi_proto;
mod node_runtime;
mod openai;
mod secrets;
mod session;
mod stream;
mod terminal;
mod vault;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![tauri_plugin_sql::Migration {
        version: 1,
        description: "create chats table",
        sql: "CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);",
        kind: tauri_plugin_sql::MigrationKind::Up,
    }];

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:modelius.db", migrations)
                .build(),
        )
        .setup(|app| {
            vault::init(app.handle()); // capture the app-data dir for the vault-initialized sentinel
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            anthropic::anthropic_oauth_token,
            anthropic::anthropic_list_models,
            anthropic::anthropic_messages_stream,
            anthropic::anthropic_usage,
            openai::openai_await_callback,
            openai::openai_oauth_token,
            openai::openai_responses_stream,
            openai::chatgpt_usage,
            compat::compat_list_models,
            compat::compat_chat_stream,
            compat::openrouter_key_status,
            compat::ollama_show,
            stream::cancel_stream,
            agent::agent_run,
            agent::agent_respond,
            agent::agent_session_close,
            agent::codex_list_models,
            agent::kimi_list_models,
            installer::harness_status,
            installer::harness_install,
            installer::harness_logged_in,
            git::git_branches,
            git::git_checkout,
            terminal::terminal_open,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            artifacts::artifact_write,
            artifacts::artifact_read,
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete,
            vault::vault_encrypt,
            vault::vault_decrypt,
            vault::vault_export_key,
            vault::vault_import_key
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            // Warm agent CLIs (session.rs) outlive any webview call — reap them with the app so
            // a quit never strands claude processes (kill_on_drop only covers dropped handles).
            if let tauri::RunEvent::Exit = event {
                session::close_all();
                terminal::close_all();
            }
        });
}
